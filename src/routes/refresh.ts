import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";

export function registerRefresh(app: Hono, deps: dependency) {
    app.post("/refresh/device/:deviceId", async (c) => {
        const deviceId = c.req.param("deviceId");
        await deps.aggregator.refreshDevice(deviceId);
        return c.json({ status: "ok", deviceId });
    });

    app.post("/refresh/key", async (c) => {
        const body = await c.req.json().catch(() => null);
        const key = body?.key;
        if (!key || typeof key !== "string") {
            return c.json({ error: "key is required (string)" }, 400);
        }
        await deps.aggregator.refreshKey(key);
        return c.json({ status: "ok", key });
    });
}
