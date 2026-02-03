import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";

export function registerHealth(app: Hono, deps: dependency) {
    app.get("/health", async (c) => {
        await deps.sql`select 1`;
        return c.text("ok");
    });
}
