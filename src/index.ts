import "dotenv/config";
import { Hono } from "hono/quick";
import { startDb } from "./db/db.ts";
import { registerRoutes } from "./routes/index.ts";

const { sql } = startDb();

const app = new Hono();

registerRoutes(app, { sql });

const server = Bun.serve({
    port: 3000,
    fetch: app.fetch,
});

console.log(`Listening on ${server.url}`);
