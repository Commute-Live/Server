import "dotenv/config";
import { Hono } from "hono/quick";
import { startDb } from "./db/db.ts";
import { registerRoutes } from "./routes/index.ts";

const { sql, db } = startDb();

const app = new Hono();

registerRoutes(app, { sql, db });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8080),
  fetch: app.fetch,
});

console.log(`Listening on ${server.url}`);
