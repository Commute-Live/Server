import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";
import { authRequired } from "../middleware/auth.ts";
import { requireDeviceAccess } from "../middleware/deviceAccess.ts";

export function registerRefresh(app: Hono, deps: dependency) {
    const requireAuth = authRequired(deps);

    app.post(
        "/refresh/device/:deviceId",
        requireAuth,
        requireDeviceAccess(deps, "deviceId"),
        async (c) => {
            const deviceId = c.req.param("deviceId");

            await deps.aggregator.refreshDevice(deviceId);
            return c.json({ status: "ok", deviceId });
        },
    );

    app.post("/refresh/key", requireAuth, async (c) => {
        const body = await c.req.json().catch(() => null);
        const key = body?.key;
        if (!key || typeof key !== "string") {
            return c.json({ error: "key is required (string)" }, 400);
        }
        await deps.aggregator.refreshKey(key);
        return c.json({ status: "ok", key });
    });
}
