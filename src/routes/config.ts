import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { dependency } from "../types/dependency.d.ts";
import { devices } from "../db/schema/schema.ts";
import type { DeviceConfig, LineConfig } from "../types.ts";

const DEFAULT_BRIGHTNESS = 60;

const validateLines = (lines: unknown): lines is LineConfig[] => {
    if (!Array.isArray(lines)) return false;
    return lines.every((item) => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Record<string, unknown>;
        if (typeof candidate.provider !== "string") return false;
        if (typeof candidate.line !== "string") return false;
        if (candidate.stop !== undefined && typeof candidate.stop !== "string") return false;
        if (candidate.direction !== undefined && typeof candidate.direction !== "string") return false;
        return true;
    });
};

const normalizeConfig = (existing: DeviceConfig | null | undefined, updates: Partial<DeviceConfig> = {}): DeviceConfig => {
    const current = existing ?? {};
    const brightness =
        typeof updates.brightness === "number" && !Number.isNaN(updates.brightness)
            ? updates.brightness
            : typeof current.brightness === "number" && !Number.isNaN(current.brightness)
              ? current.brightness
              : DEFAULT_BRIGHTNESS;

    const lines =
        Array.isArray(updates.lines) ? updates.lines : Array.isArray(current.lines) ? current.lines : [];

    return { ...current, ...updates, brightness, lines };
};

export function registerConfig(app: Hono, deps: dependency) {
    app.get("/device/:deviceId/config", async (c) => {
        const deviceId = c.req.param("deviceId");
        const [device] = await deps.db
            .select({ config: devices.config })
            .from(devices)
            .where(eq(devices.id, deviceId))
            .limit(1);

        if (!device) {
            return c.json({ error: "Device not found" }, 404);
        }

        const normalized = normalizeConfig(device.config as DeviceConfig | null | undefined);
        return c.json({ deviceId, config: normalized });
    });

    app.post("/device/:deviceId/config", async (c) => {
        const deviceId = c.req.param("deviceId");
        const body = await c.req.json().catch(() => null);

        const updates: Partial<DeviceConfig> = {};

        if (body && typeof body === "object") {
            const maybeBrightness = (body as Record<string, unknown>).brightness;
            if (typeof maybeBrightness === "number") {
                updates.brightness = maybeBrightness;
            } else if (typeof maybeBrightness === "string" && maybeBrightness.trim() !== "") {
                const parsed = Number(maybeBrightness);
                if (!Number.isNaN(parsed)) {
                    updates.brightness = parsed;
                }
            }

            if ("lines" in (body as Record<string, unknown>)) {
                const proposed = (body as Record<string, unknown>).lines;
                if (proposed === undefined || proposed === null) {
                    updates.lines = [];
                } else if (!validateLines(proposed)) {
                    return c.json({ error: "lines must be an array of { provider, line, stop?, direction? }" }, 400);
                } else {
                    updates.lines = proposed as LineConfig[];
                }
            }
        }

        const [device] = await deps.db
            .select({ config: devices.config })
            .from(devices)
            .where(eq(devices.id, deviceId))
            .limit(1);

        if (!device) {
            return c.json({ error: "Device not found" }, 404);
        }

        const nextConfig = normalizeConfig(device.config as DeviceConfig | null | undefined, updates);

        const [updated] = await deps.db
            .update(devices)
            .set({ config: nextConfig })
            .where(eq(devices.id, deviceId))
            .returning({ config: devices.config });

        return c.json({ deviceId, config: updated?.config ?? nextConfig });
    });
}
