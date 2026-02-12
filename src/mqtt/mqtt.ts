import mqtt, { type MqttClient } from "mqtt";

let client: MqttClient | null = null;
let isConfigured = false;

function getConfig() {
    const host = process.env.MQTT_HOST;
    const protocol = (process.env.MQTT_PROTOCOL ?? "mqtt") as "mqtt" | "mqtts";
    const port = Number(process.env.MQTT_PORT ?? (protocol === "mqtts" ? 8883 : 1883));
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
            console.warn("MQTT not configured. Set MQTT_HOST to enable publishing.");
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
        console.log(`MQTT connected to ${config.protocol}://${config.host}:${config.port}`);
    });

    client.on("error", (err: { message: any; }) => {
        console.error("MQTT error:", err.message);
    });

    return client;
}

export async function publish(topic: string, payload: string) {
    const mqttClient = getClient();
    if (!mqttClient) return false;

    await new Promise<void>((resolve, reject) => {
        mqttClient.publish(topic, payload, { qos: 0 }, (err: any) => {
            if (err) return reject(err);
            return resolve();
        });
    });

    return true;
}
