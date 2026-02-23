import { ddTraceMiddleware } from "./tracer.ts";
import "dotenv/config";
import { Hono } from "hono/quick";
import { cors } from "hono/cors";
import { startDb } from "./db/db.ts";
import { registerRoutes } from "./routes/index.ts";
import { startAggregatorEngine } from "./engine.ts";
import { loadSubscriptionsFromDb } from "./db/subscriptions.ts";
import { publish as mqttPublish, subscribePresence } from "./mqtt/mqtt.ts";
import { initCache } from "./cache.ts";
import { logger } from "./logger.ts";

await initCache();

const { sql, db } = startDb();

const aggregator = startAggregatorEngine({
    loadSubscriptions: () => loadSubscriptionsFromDb(db),
    publish: (topic, payload) => {
        void mqttPublish(topic, JSON.stringify(payload)).catch((err) => {
            logger.error(
                {
                    topic,
                    err,
                },
                "MQTT publish failed",
            );
        });
    },
});

const app = new Hono();

const allowedOrigins = (
    process.env.CORS_ORIGINS ?? "http://localhost:8081,http://127.0.0.1:8081"
)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use("*", ddTraceMiddleware);

app.use(
    "*",
    cors({
        origin: (origin) => {
            if (!origin) return "";
            return allowedOrigins.includes(origin) ? origin : "";
        },
        credentials: true,
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
    }),
);

registerRoutes(app, { sql, db, aggregator });

subscribePresence((deviceId, online) => {
    const action = online ? aggregator.markDeviceActive(deviceId) : aggregator.markDeviceInactive(deviceId);
    action.catch((err) => logger.error({ err, deviceId, online }, "presence update failed"));
});

aggregator.ready
    .then(() => logger.info("aggregator ready"))
    .catch((err) => logger.error({ err }, "aggregator failed to start"));

const server = Bun.serve({
    hostname: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 8080),
    fetch: app.fetch,
});

logger.info({ url: server.url.toString() }, "server listening");
