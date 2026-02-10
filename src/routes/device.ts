import type { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type { dependency } from "../types/dependency.d.ts";
import { devices } from "../db/schema/schema.ts";

async function getDeviceById(deps: dependency, deviceId: string) {
    const rows = await deps.db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
    return rows[0] ?? null;
}

export function registerDevice(app: Hono, deps: dependency) {
    app.get("/device/:device_id", async (c) => {
        const deviceId = c.req.param("device_id");
        const device = await getDeviceById(deps, deviceId);
        if (!device) {
            return c.json({ error: "Device not found" }, 404);
        }
        return c.json(device);
    });

    app.get("/device/:device_id/heartbeat", async (c) => {
        const deviceId = c.req.param("device_id");
        const device = await getDeviceById(deps, deviceId);
        if (!device) {
            return c.json({ error: "Device not found" }, 404);
        }
        return c.json({ deviceId: device.id, lastActive: device.lastActive });
    });

    app.post("/device/:device_id/heartbeat", async (c) => {
        const deviceId = c.req.param("device_id");
        const [updated] = await deps.db
            .update(devices)
            .set({ lastActive: sql`now()` })
            .where(eq(devices.id, deviceId))
            .returning();

        if (!updated) {
            return c.json({ error: "Device not found" }, 404);
        }

        return c.json({ deviceId: updated.id, lastActive: updated.lastActive });
    });
}
