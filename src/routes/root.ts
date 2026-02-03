import type { Hono } from "hono";

export function registerRoot(app: Hono) {
    app.get("/", (c) => c.text("Hello Bun!"));
}
