import "dotenv/config";
import { Hono } from "hono/quick";
import { startDb } from "./db/db.ts";
import { registerRoutes } from "./routes/index.ts";
import { startAggregatorEngine } from "./engine.ts";

const { sql, db } = startDb();

const aggregator = startAggregatorEngine();

const app = new Hono();

registerRoutes(app, { sql, db, aggregator });

aggregator.ready
    .then(() => console.log("[ENGINE] aggregator ready"))
    .catch((err) => console.error("[ENGINE] failed to start", err));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8080),
  fetch: app.fetch,
});

console.log(`Listening on ${server.url}`);
