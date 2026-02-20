import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { dependency } from "../types/dependency.d.ts";
import { devices } from "../db/schema/schema.ts";
import type { DeviceConfig, LineConfig } from "../types.ts";
import { authRequired } from "../middleware/auth.ts";
import { requireDeviceAccess } from "../middleware/deviceAccess.ts";
import { listLinesForStop } from "../gtfs/stops_lookup.ts";
import { listCtaSubwayLinesForStop } from "../gtfs/cta_subway_lookup.ts";
import { listMtaBusStopsForRoute } from "../providers/new-york/bus_stops.ts";

const DEFAULT_BRIGHTNESS = 60;
const DEFAULT_DISPLAY_TYPE = 1;
const DEFAULT_SCROLLING = false;
const SUPPORTED_PROVIDERS = new Set([
    "mta-subway",
    "mta-bus",
    "mbta",
    "cta-subway",
    "septa-rail",
    "septa-bus",
]);

const validateLines = (lines: unknown): lines is LineConfig[] => {
    if (!Array.isArray(lines)) return false;
    return lines.every((item) => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Record<string, unknown>;
        if (typeof candidate.provider !== "string") return false;
        if (typeof candidate.line !== "string") return false;
        if (candidate.stop !== undefined && typeof candidate.stop !== "string")
            return false;
        if (
            candidate.direction !== undefined &&
            typeof candidate.direction !== "string"
        )
            return false;
        if (
            candidate.displayType !== undefined &&
            typeof candidate.displayType !== "number"
        )
            return false;
        if (
            candidate.scrolling !== undefined &&
            typeof candidate.scrolling !== "boolean"
        )
            return false;
        return true;
    });
};

const normalizeConfig = (
    existing: DeviceConfig | null | undefined,
    updates: Partial<DeviceConfig> = {},
): DeviceConfig => {
    const current = existing ?? {};
    const brightness =
        typeof updates.brightness === "number" &&
        !Number.isNaN(updates.brightness)
            ? updates.brightness
            : typeof current.brightness === "number" &&
                !Number.isNaN(current.brightness)
              ? current.brightness
              : DEFAULT_BRIGHTNESS;

    const lines = Array.isArray(updates.lines)
        ? updates.lines
        : Array.isArray(current.lines)
          ? current.lines
          : [];

    const displayType =
        typeof updates.displayType === "number" &&
        !Number.isNaN(updates.displayType)
            ? updates.displayType
            : typeof current.displayType === "number" &&
                !Number.isNaN(current.displayType)
              ? current.displayType
              : DEFAULT_DISPLAY_TYPE;

    const scrolling =
        typeof updates.scrolling === "boolean"
            ? updates.scrolling
            : typeof current.scrolling === "boolean"
              ? current.scrolling
              : DEFAULT_SCROLLING;

    return {
        ...current,
        ...updates,
        brightness,
        lines,
        displayType,
        scrolling,
    };
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

        const normalized = normalizeConfig(
            device.config as DeviceConfig | null | undefined,
        );
        return c.json({ deviceId, config: normalized });
    });

    app.post(
        "/device/:deviceId/config",
        authRequired,
        requireDeviceAccess(deps, "deviceId"),
        async (c) => {
            const deviceId = c.req.param("deviceId");
            const body = await c.req.json().catch(() => null);

            const updates: Partial<DeviceConfig> = {};

            if (body && typeof body === "object") {
                const maybeBrightness = (body as Record<string, unknown>)
                    .brightness;
                if (typeof maybeBrightness === "number") {
                    updates.brightness = maybeBrightness;
                } else if (
                    typeof maybeBrightness === "string" &&
                    maybeBrightness.trim() !== ""
                ) {
                    const parsed = Number(maybeBrightness);
                    if (!Number.isNaN(parsed)) {
                        updates.brightness = parsed;
                    }
                }

                if ("displayType" in (body as Record<string, unknown>)) {
                    const maybeDisplay = (body as Record<string, unknown>)
                        .displayType;
                    if (
                        typeof maybeDisplay === "number" &&
                        !Number.isNaN(maybeDisplay)
                    ) {
                        updates.displayType = maybeDisplay;
                    }
                }

                if ("scrolling" in (body as Record<string, unknown>)) {
                    const maybeScrolling = (body as Record<string, unknown>)
                        .scrolling;
                    if (typeof maybeScrolling === "boolean") {
                        updates.scrolling = maybeScrolling;
                    }
                }

                if ("lines" in (body as Record<string, unknown>)) {
                    const proposed = (body as Record<string, unknown>).lines;
                    if (proposed === undefined || proposed === null) {
                        updates.lines = [];
                    } else if (!validateLines(proposed)) {
                        return c.json(
                            {
                                error: "lines must be an array of { provider, line, stop?, direction?, displayType?, scrolling? }",
                            },
                            400,
                        );
                    } else {
                        updates.lines = proposed as LineConfig[];
                    }
                }
            }

            if (Array.isArray(updates.lines) && updates.lines.length > 0) {
                for (const row of updates.lines) {
                    const provider = (row.provider ?? "").trim().toLowerCase();
                    const line = (row.line ?? "").trim().toUpperCase();
                    const stop = (row.stop ?? "").trim().toUpperCase();

                    if (!SUPPORTED_PROVIDERS.has(provider)) {
                        return c.json(
                            {
                                error: `Unsupported provider '${provider}'. Supported providers: ${Array.from(
                                    SUPPORTED_PROVIDERS,
                                ).join(", ")}`,
                            },
                            400,
                        );
                    }

                    if (provider === "mta-subway" && line && stop) {
                        const stopLines = await listLinesForStop(stop);
                        const normalizedStopLines = stopLines.map((v) =>
                            v.trim().toUpperCase(),
                        );
                        if (!normalizedStopLines.includes(line)) {
                            return c.json(
                                {
                                    error: `Invalid line+stop combination for New York subway: line ${line} does not serve stop ${stop}`,
                                },
                                400,
                            );
                        }
                    }

                    if (provider === "mta-bus" && line && stop) {
                        const busStops = await listMtaBusStopsForRoute(line);
                        const hasStop = busStops.some(
                            (s) => s.stopId.trim().toUpperCase() === stop,
                        );
                        if (!hasStop) {
                            return c.json(
                                {
                                    error: `Invalid line+stop combination for NYC bus: line ${line} does not serve stop ${stop}`,
                                },
                                400,
                            );
                        }
                    }

                    if (provider === "cta-subway" && line && stop) {
                        const ctaStopLines =
                            await listCtaSubwayLinesForStop(stop);
                        const normalizedStopLines = ctaStopLines.map((v) =>
                            v.trim().toUpperCase(),
                        );
                        if (!normalizedStopLines.includes(line)) {
                            return c.json(
                                {
                                    error: `Invalid line+stop combination for Chicago subway: line ${line} does not serve stop ${stop}`,
                                },
                                400,
                            );
                        }
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

            const nextConfig = normalizeConfig(
                device.config as DeviceConfig | null | undefined,
                updates,
            );

            const [updated] = await deps.db
                .update(devices)
                .set({ config: nextConfig })
                .where(eq(devices.id, deviceId))
                .returning({ config: devices.config });

            await deps.aggregator.reloadSubscriptions();
            await deps.aggregator.refreshDevice(deviceId);

            return c.json({ deviceId, config: updated?.config ?? nextConfig });
        },
    );
}
