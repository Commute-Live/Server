import type { Hono } from "hono";
import { eq } from "drizzle-orm";

import type { dependency } from "../types/dependency.d.ts";
import { devices } from "../db/schema/schema.ts";
import type { DeviceConfig } from "../types.ts";
import { authRequired } from "../middleware/auth.ts";
import { requireDeviceAccess } from "../middleware/deviceAccess.ts";
import { loadtestGuard } from "../middleware/loadtest.ts";
import { listLinesForStop } from "../gtfs/stops_lookup.ts";
import {
    extractDeviceConfigPatch,
    normalizeDeviceConfig,
    SUPPORTED_PROVIDERS,
    validateLineConfigs,
} from "../config/deviceConfig.ts";
import {
    listCoreLinesForStation as listCtaLinesForStation,
    normalizeCoreLineId as normalizeCtaLineId,
} from "../cta/core_catalog.ts";
import { resolveCoreLineForStation as resolveMbtaLineForStation } from "../mbta/core_catalog.ts";
import { listMtaBusStopsForRoute } from "../providers/new-york/bus_stops.ts";

async function validateLineReferences(deps: dependency, lines: DeviceConfig["lines"]) {
    if (!Array.isArray(lines) || lines.length === 0) return null;

    for (const row of lines) {
        if (!row || typeof row !== "object") continue;

        const candidate = row as Record<string, unknown>;
        const provider = typeof candidate.provider === "string" ? candidate.provider.trim().toLowerCase() : "";
        const rawLine = typeof candidate.line === "string" ? candidate.line.trim() : "";
        const line = rawLine.toUpperCase();
        const rawStop = typeof candidate.stop === "string" ? candidate.stop.trim() : "";
        const stop = rawStop.toUpperCase();

        if (!SUPPORTED_PROVIDERS.has(provider)) {
            return `Unsupported provider '${provider}'. Supported providers: ${Array.from(SUPPORTED_PROVIDERS).join(", ")}`;
        }

        if (provider === "mta-subway" && line && stop) {
            const stopLines = await listLinesForStop(stop);
            const normalizedStopLines = stopLines.map((value) => value.trim().toUpperCase());
            if (!normalizedStopLines.includes(line)) {
                return `Invalid line+stop combination for New York subway: line ${line} does not serve stop ${stop}`;
            }
        }

        if (provider === "mta-bus" && line && stop) {
            const busStops = await listMtaBusStopsForRoute(line);
            const hasStop = busStops.some((item) => item.stopId.trim().toUpperCase() === stop);
            if (!hasStop) {
                return `Invalid line+stop combination for NYC bus: line ${line} does not serve stop ${stop}`;
            }
        }

        if (provider === "mbta" && rawLine && rawStop) {
            const match = await resolveMbtaLineForStation(deps.db, rawLine, rawStop);
            if (!match) {
                return `Invalid line+stop combination for MBTA: line ${rawLine} does not serve stop ${rawStop}`;
            }
            candidate.line = match.line.id;
            candidate.stop = match.stopId;
        }

        if ((provider === "cta-subway" || provider === "cta-bus") && line && stop) {
            const ctaMode = provider === "cta-subway" ? "subway" : "bus";
            const ctaStopLines = await listCtaLinesForStation(deps.db, ctaMode, stop);
            const normalizedLine = normalizeCtaLineId(ctaMode, line);
            const normalizedStopLines = ctaStopLines.map((item) => normalizeCtaLineId(ctaMode, item.id));
            if (!normalizedStopLines.includes(normalizedLine)) {
                return `Invalid line+stop combination for Chicago ${ctaMode}: line ${line} does not serve stop ${stop}`;
            }
            candidate.line = normalizedLine;
        }
    }

    return null;
}

export function registerConfig(app: Hono, deps: dependency) {
    app.get("/device/:deviceId/config", loadtestGuard, async (c) => {
        const deviceId = c.req.param("deviceId");
        const [device] = await deps.db
            .select({ config: devices.config })
            .from(devices)
            .where(eq(devices.id, deviceId))
            .limit(1);

        if (!device) {
            return c.json({ error: "Device not found" }, 404);
        }

        const normalized = normalizeDeviceConfig(device.config as DeviceConfig | null | undefined);
        return c.json({ deviceId, config: normalized });
    });

    app.post(
        "/device/:deviceId/config",
        loadtestGuard,
        authRequired,
        requireDeviceAccess(deps, "deviceId"),
        async (c) => {
            const deviceId = c.req.param("deviceId");
            const body = await c.req.json().catch(() => null);
            const updates = extractDeviceConfigPatch(body);

            if (!updates) {
                return c.json({ error: "Request body must be a JSON object" }, 400);
            }

            if (Object.prototype.hasOwnProperty.call(updates, "lines")) {
                if (updates.lines === null || updates.lines === undefined) {
                    updates.lines = [];
                } else if (!validateLineConfigs(updates.lines)) {
                    return c.json(
                        {
                            error: "lines must be an array of { provider, line, stop?, direction?, displayType?, scrolling? }",
                        },
                        400,
                    );
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

            const nextConfig = normalizeDeviceConfig(
                device.config as DeviceConfig | null | undefined,
                updates,
            );

            if (Object.prototype.hasOwnProperty.call(updates, "lines")) {
                const lineValidationError = await validateLineReferences(
                    deps,
                    nextConfig.lines ?? [],
                );
                if (lineValidationError) {
                    return c.json({ error: lineValidationError }, 400);
                }
            }

            const [updated] = await deps.db
                .update(devices)
                .set({ config: nextConfig })
                .where(eq(devices.id, deviceId))
                .returning({ config: devices.config });

            await deps.aggregator.reloadSubscriptions();
            await deps.aggregator.refreshDevice(deviceId);

            const persistedConfig = (updated?.config ?? nextConfig) as DeviceConfig | null | undefined;
            return c.json({ deviceId, config: normalizeDeviceConfig(persistedConfig) });
        },
    );
}
