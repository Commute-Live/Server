import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { dependency } from "../types/dependency.d.ts";
import { devices } from "../db/schema/schema.ts";

async function getDeviceByName(deps: dependency, deviceName: string) {
    const rows = await deps.db
        .select()
        .from(devices)
        .where(eq(devices.deviceName, deviceName))
        .limit(1);
    return rows[0] ?? null;
}

export function registerDevice(app: Hono, deps: dependency) {
    app.get("/device/:device_name", async (c) => {
        const deviceName = c.req.param("device_name");
        const device = await getDeviceByName(deps, deviceName);
        if (!device) {
            return c.json({ error: "Device not found" }, 404);
        }
        return c.json(device);
    });
}
