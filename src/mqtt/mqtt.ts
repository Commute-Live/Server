import mqtt, { type MqttClient } from "mqtt";
import { metrics } from "../metrics.ts";

let client: MqttClient | null = null;
let isConfigured = false;
let debugSubscriptionsInstalled = false;
let presenceHandler: ((deviceId: string, online: boolean) => void) | null = null;

type MqttDebugDirection = "outgoing" | "incoming" | "state" | "error";
type MqttDebugEvent = {
    id: number;
    ts: string;
    direction: MqttDebugDirection;
    topic?: string;
    payloadPreview?: string;
    detail?: string;
};

const DEBUG_EVENTS_MAX = 500;
let debugEventId = 0;
const debugEvents: MqttDebugEvent[] = [];

const MQTT_DEBUG_PAYLOAD_MAX_CHARS = (() => {
    const raw = Number(process.env.MQTT_DEBUG_PAYLOAD_MAX_CHARS ?? 4000);
    if (!Number.isFinite(raw)) return 4000;
    return Math.max(128, Math.min(20000, Math.floor(raw)));
})();

const toPayloadPreview = (value: string | Buffer | Uint8Array) => {
    const text =
        typeof value === "string" ? value : Buffer.from(value).toString("utf8");
    if (text.length <= MQTT_DEBUG_PAYLOAD_MAX_CHARS) return text;
    return `${text.slice(0, MQTT_DEBUG_PAYLOAD_MAX_CHARS)}...[truncated ${text.length - MQTT_DEBUG_PAYLOAD_MAX_CHARS} chars]`;
};

const pushDebugEvent = (event: Omit<MqttDebugEvent, "id" | "ts">) => {
    debugEventId += 1;
    const nextEvent: MqttDebugEvent = {
        id: debugEventId,
        ts: new Date().toISOString(),
        ...event,
    };
    debugEvents.push(nextEvent);
    if (debugEvents.length > DEBUG_EVENTS_MAX) {
        debugEvents.splice(0, debugEvents.length - DEBUG_EVENTS_MAX);
    }

    const level = nextEvent.direction === "error" ? "error" : "info";
    console.log(
        JSON.stringify({
            level,
            message: "mqtt_debug_event",
            source: "mqtt",
            service: process.env.DD_SERVICE ?? "commutelive-api",
            env: process.env.DD_ENV ?? process.env.NODE_ENV ?? "unknown",
            version: process.env.DD_VERSION ?? "unknown",
            mqtt: nextEvent,
        }),
    );
};

const getDebugTopics = () => {
    const raw = process.env.MQTT_DEBUG_TOPICS?.trim();
    if (!raw)
        return ["/device/+/commands", "devices/+/status", "devices/+/display"];
    return raw
        .split(",")
        .map((topic) => topic.trim())
        .filter(Boolean);
};

const SYS_TOPIC_TO_METRIC: Record<string, string> = {
    "$SYS/broker/clients/connected": "mosquitto.clients.connected",
    "$SYS/broker/subscriptions/count": "mosquitto.subscriptions.count",
    "$SYS/broker/publish/messages/sent": "mosquitto.publish.messages.sent",
    "$SYS/broker/publish/messages/received": "mosquitto.publish.messages.received",
    "$SYS/broker/bytes/sent": "mosquitto.bytes.sent",
    "$SYS/broker/bytes/received": "mosquitto.bytes.received",
    "$SYS/broker/retained messages/count": "mosquitto.retained_messages.count",
    "$SYS/broker/heap/current": "mosquitto.heap.current",
};

function getConfig() {
    const host = process.env.MQTT_HOST;
    const protocol = (process.env.MQTT_PROTOCOL ?? "mqtt") as "mqtt" | "mqtts";
    const port = Number(
        process.env.MQTT_PORT ?? (protocol === "mqtts" ? 8883 : 1883),
    );
    const username = process.env.MQTT_USERNAME;
    const password = process.env.MQTT_PASSWORD;

    if (!host) return null;
    return { host, protocol, port, username, password };
}

function getClient() {
    if (client) return client;

    const config = getConfig();
    if (!config) {
        if (!isConfigured) {
            console.warn(
                "MQTT not configured. Set MQTT_HOST to enable publishing.",
            );
            isConfigured = true;
        }
        return null;
    }

    client = mqtt.connect({
        protocol: config.protocol,
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        reconnectPeriod: 2000,
        connectTimeout: 5000,
    });

    client.on("connect", () => {
        console.log(
            `MQTT connected to ${config.protocol}://${config.host}:${config.port}`,
        );
        pushDebugEvent({
            direction: "state",
            detail: `connected to ${config.protocol}://${config.host}:${config.port}`,
        });
        metrics.increment("mqtt.connection.connect");

        if (!debugSubscriptionsInstalled) {
            debugSubscriptionsInstalled = true;
            for (const topic of [...getDebugTopics(), "$SYS/#", "device/+/presence"]) {
                client?.subscribe(topic, (err) => {
                    if (err) {
                        pushDebugEvent({
                            direction: "error",
                            topic,
                            detail: `subscribe failed: ${err.message}`,
                        });
                        return;
                    }
                    pushDebugEvent({
                        direction: "state",
                        topic,
                        detail: "subscribed",
                    });
                });
            }
        }
    });

    client.on("reconnect", () => {
        pushDebugEvent({
            direction: "state",
            detail: "reconnecting",
        });
        metrics.increment("mqtt.connection.reconnect");
    });

    client.on("close", () => {
        pushDebugEvent({
            direction: "state",
            detail: "connection closed",
        });
        metrics.increment("mqtt.connection.close");
    });

    client.on("offline", () => {
        pushDebugEvent({
            direction: "state",
            detail: "offline",
        });
    });

    client.on("message", (topic, payload) => {
        const sysMetric = SYS_TOPIC_TO_METRIC[topic];
        if (sysMetric) {
            const value = parseFloat(Buffer.from(payload).toString("utf8"));
            if (Number.isFinite(value)) {
                metrics.gauge(sysMetric, value);
            }
            return;
        }

        if (topic.startsWith("$SYS/")) return;

        const presenceMatch = topic.match(/^device\/([^/]+)\/presence$/);
        if (presenceMatch && presenceMatch[1] && presenceHandler) {
            const deviceId = presenceMatch[1];
            const online = Buffer.from(payload).toString("utf8").trim() === "online";
            presenceHandler(deviceId, online);
            return;
        }

        pushDebugEvent({
            direction: "incoming",
            topic,
            payloadPreview: toPayloadPreview(payload),
        });
    });

    client.on("error", (err) => {
        console.error("MQTT error:", err.message);
        pushDebugEvent({
            direction: "error",
            detail: err.message,
        });
        metrics.increment("mqtt.connection.error");
    });

    return client;
}

export async function publish(topic: string, payload: string) {
    const mqttClient = getClient();
    if (!mqttClient) {
        pushDebugEvent({
            direction: "error",
            topic,
            detail: "publish skipped: MQTT not configured",
        });
        return false;
    }

    await new Promise<void>((resolve, reject) => {
        mqttClient.publish(topic, payload, { qos: 0 }, (err) => {
            if (err) {
                pushDebugEvent({
                    direction: "error",
                    topic,
                    payloadPreview: toPayloadPreview(payload),
                    detail: `publish failed: ${err.message}`,
                });
                metrics.increment("mqtt.publish.error");
                return reject(err);
            }
            pushDebugEvent({
                direction: "outgoing",
                topic,
                payloadPreview: toPayloadPreview(payload),
            });
            metrics.increment("mqtt.publish.success");
            return resolve();
        });
    });

    return true;
}

export function subscribePresence(handler: (deviceId: string, online: boolean) => void) {
    presenceHandler = handler;
}

export function getRecentMqttDebugEvents(limit = 200) {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    return debugEvents.slice(-safeLimit);
}

export function getLatestOutgoingCommandEvent(deviceId: string) {
    const normalizedId = deviceId.trim();
    if (!normalizedId) return null;
    const topic = `/device/${normalizedId}/commands`;
    for (let i = debugEvents.length - 1; i >= 0; i -= 1) {
        const event = debugEvents[i];
        if (!event) continue;
        if (event.direction !== "outgoing") continue;
        if (event.topic !== topic) continue;
        return event;
    }
    return null;
}
