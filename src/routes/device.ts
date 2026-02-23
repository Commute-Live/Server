import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { dependency } from "../types/dependency.d.ts";
import { devices } from "../db/schema/schema.ts";
import { authRequired } from "../middleware/auth.ts";
import { requireDeviceAccess } from "../middleware/deviceAccess.ts";
import { getLatestOutgoingCommandEvent } from "../mqtt/mqtt.ts";

async function getDeviceById(deps: dependency, deviceId: string) {
    const rows = await deps.db
        .select()
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
    return rows[0] ?? null;
}

export function registerDevice(app: Hono, deps: dependency) {
    app.get("/device/:device_id", async (c) => {
        const deviceId = c.req.param("device_id");
        const device = await getDeviceById(deps, deviceId);
        if (!device) {
            return c.json({ error: "Device not found" }, 404);
        }
        const activity = await deps.aggregator.getDeviceActivity(deviceId);
        return c.json({
            ...device,
            activity,
        });
    });

    app.get(
        "/device/:device_id/last-command",
        authRequired,
        requireDeviceAccess(deps, "device_id"),
        async (c) => {
            const deviceId = c.req.param("device_id");
            const event = getLatestOutgoingCommandEvent(deviceId);
            if (!event) {
                return c.json({ deviceId, event: null });
            }

            let payload: unknown = null;
            if (typeof event.payloadPreview === "string" && event.payloadPreview.trim().length > 0) {
                try {
                    payload = JSON.parse(event.payloadPreview);
                } catch {
                    payload = event.payloadPreview;
                }
            }

            return c.json({
                deviceId,
                event: {
                    id: event.id,
                    ts: event.ts,
                    topic: event.topic ?? null,
                    payload,
                },
            });
        },
    );
}
