import type { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import type { dependency } from "../types/dependency.d.ts";
import { devices, displays } from "../db/schema/schema.ts";
import type { DeviceConfig, LineConfig } from "../types.ts";
import { authRequired } from "../middleware/auth.ts";
import { requireDeviceAccess } from "../middleware/deviceAccess.ts";
import { loadtestGuard } from "../middleware/loadtest.ts";
import { listLinesForStop } from "../gtfs/stops_lookup.ts";
import {
    listCoreLinesForStation as listCtaLinesForStation,
    normalizeCoreLineId as normalizeCtaLineId,
} from "../cta/core_catalog.ts";
import { resolveCoreLineForStation as resolveMbtaLineForStation } from "../mbta/core_catalog.ts";
import { listMtaBusStopsForRoute } from "../providers/new-york/bus_stops.ts";

const DEFAULT_BRIGHTNESS = 60;
const DEFAULT_DISPLAY_TYPE = 1;
const DEFAULT_SCROLLING = false;
const DEFAULT_ARRIVALS_TO_DISPLAY = 1;
const SUPPORTED_PROVIDERS = new Set([
    "mta-subway",
    "mta-bus",
    "mbta",
    "cta-subway",
    "cta-bus",
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
        if (candidate.stop !== undefined && typeof candidate.stop !== "string") return false;
        if (candidate.direction !== undefined && typeof candidate.direction !== "string") return false;
        if (candidate.displayType !== undefined && typeof candidate.displayType !== "number") return false;
        if (candidate.scrolling !== undefined && typeof candidate.scrolling !== "boolean") return false;
        return true;
    });
};

const normalizeArrivalsToDisplay = (value: unknown) => {
    if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_ARRIVALS_TO_DISPLAY;
    if (value < 1) return 1;
    if (value > 3) return 3;
    return Math.trunc(value);
};

const normalizeConfig = (
    existing: DeviceConfig | null | undefined,
    updates: Partial<DeviceConfig> = {},
): DeviceConfig => {
    const current = existing ?? {};
    const brightness =
        typeof updates.brightness === "number" && !Number.isNaN(updates.brightness)
            ? updates.brightness
            : typeof current.brightness === "number" && !Number.isNaN(current.brightness)
              ? current.brightness
              : DEFAULT_BRIGHTNESS;

    const lines = Array.isArray(updates.lines)
        ? updates.lines
        : Array.isArray(current.lines)
          ? current.lines
          : [];

    const displayType =
        typeof updates.displayType === "number" && !Number.isNaN(updates.displayType)
            ? updates.displayType
            : typeof current.displayType === "number" && !Number.isNaN(current.displayType)
              ? current.displayType
              : DEFAULT_DISPLAY_TYPE;

    const scrolling =
        typeof updates.scrolling === "boolean"
            ? updates.scrolling
            : typeof current.scrolling === "boolean"
              ? current.scrolling
              : DEFAULT_SCROLLING;

    const arrivalsToDisplay =
        updates.arrivalsToDisplay !== undefined
            ? normalizeArrivalsToDisplay(updates.arrivalsToDisplay)
            : current.arrivalsToDisplay !== undefined
              ? normalizeArrivalsToDisplay(current.arrivalsToDisplay)
              : DEFAULT_ARRIVALS_TO_DISPLAY;

    return {
        ...current,
        ...updates,
        brightness,
        lines,
        displayType,
        scrolling,
        arrivalsToDisplay,
    };
};

const parseConfigUpdates = (body: unknown): { displayId?: string; updates: Partial<DeviceConfig> } | null => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;

    const raw = body as Record<string, unknown>;
    const displayId = typeof raw.displayId === "string" && raw.displayId.trim().length > 0 ? raw.displayId.trim() : undefined;
    const payload =
        raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)
            ? (raw.config as Record<string, unknown>)
            : raw;

    const updates: Partial<DeviceConfig> = {};

    const maybeBrightness = payload.brightness;
    if (typeof maybeBrightness === "number") {
        updates.brightness = maybeBrightness;
    } else if (typeof maybeBrightness === "string" && maybeBrightness.trim() !== "") {
        const parsed = Number(maybeBrightness);
        if (!Number.isNaN(parsed)) updates.brightness = parsed;
    }

    if ("displayType" in payload) {
        const maybeDisplay = payload.displayType;
        if (typeof maybeDisplay === "number" && !Number.isNaN(maybeDisplay)) {
            updates.displayType = maybeDisplay;
        }
    }

    if ("scrolling" in payload && typeof payload.scrolling === "boolean") {
        updates.scrolling = payload.scrolling;
    }

    if ("arrivalsToDisplay" in payload) {
        const maybeArrivalsToDisplay = payload.arrivalsToDisplay;
        if (typeof maybeArrivalsToDisplay === "number" && !Number.isNaN(maybeArrivalsToDisplay)) {
            updates.arrivalsToDisplay = normalizeArrivalsToDisplay(maybeArrivalsToDisplay);
        }
    }

    if ("lines" in payload) {
        const proposed = payload.lines;
        if (proposed === undefined || proposed === null) {
            updates.lines = [];
        } else if (!validateLines(proposed)) {
            return null;
        } else {
            updates.lines = proposed as LineConfig[];
        }
    }

    return { displayId, updates };
};

async function validateDisplayLines(deps: dependency, lines: LineConfig[] | undefined) {
    if (!Array.isArray(lines) || lines.length === 0) return null;

    for (const row of lines) {
        const provider = (row.provider ?? "").trim().toLowerCase();
        const rawLine = (row.line ?? "").trim();
        const line = rawLine.toUpperCase();
        const rawStop = (row.stop ?? "").trim();
        const stop = rawStop.toUpperCase();

        if (!SUPPORTED_PROVIDERS.has(provider)) {
            return `Unsupported provider '${provider}'. Supported providers: ${Array.from(SUPPORTED_PROVIDERS).join(", ")}`;
        }

        if (provider === "mta-subway" && line && stop) {
            const stopLines = await listLinesForStop(stop);
            const normalizedStopLines = stopLines.map((v) => v.trim().toUpperCase());
            if (!normalizedStopLines.includes(line)) {
                return `Invalid line+stop combination for New York subway: line ${line} does not serve stop ${stop}`;
            }
        }

        if (provider === "mta-bus" && line && stop) {
            const busStops = await listMtaBusStopsForRoute(line);
            const hasStop = busStops.some((s) => s.stopId.trim().toUpperCase() === stop);
            if (!hasStop) {
                return `Invalid line+stop combination for NYC bus: line ${line} does not serve stop ${stop}`;
            }
        }

        if (provider === "mbta" && rawLine && rawStop) {
            const match = await resolveMbtaLineForStation(deps.db, rawLine, rawStop);
            if (!match) {
                return `Invalid line+stop combination for MBTA: line ${rawLine} does not serve stop ${rawStop}`;
            }
            row.line = match.line.id;
            row.stop = match.stopId;
        }

        if ((provider === "cta-subway" || provider === "cta-bus") && line && stop) {
            const ctaMode = provider === "cta-subway" ? "subway" : "bus";
            const ctaStopLines = await listCtaLinesForStation(deps.db, ctaMode, stop);
            const normalizedLine = normalizeCtaLineId(ctaMode, line);
            const normalizedStopLines = ctaStopLines.map((v) => normalizeCtaLineId(ctaMode, v.id));
            if (!normalizedStopLines.includes(normalizedLine)) {
                return `Invalid line+stop combination for Chicago ${ctaMode}: line ${line} does not serve stop ${stop}`;
            }
            row.line = normalizedLine;
        }
    }

    return null;
}

async function getDisplaysForDevice(deps: dependency, deviceId: string) {
    const rows = await deps.db
        .select({
            displayId: displays.id,
            config: displays.config,
            createdAt: displays.createdAt,
            updatedAt: displays.updatedAt,
        })
        .from(displays)
        .where(eq(displays.deviceId, deviceId))
        .orderBy(asc(displays.createdAt), asc(displays.id));

    return rows.map((row) => ({
        displayId: row.displayId,
        config: normalizeConfig(row.config as DeviceConfig | null | undefined),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    }));
}

export function registerConfig(app: Hono, deps: dependency) {
    app.get("/device/:deviceId/config", loadtestGuard, async (c) => {
        const deviceId = c.req.param("deviceId");
        const reportedFw = c.req.query("fw")?.trim() ?? null;
        const requestedDisplayId = c.req.query("displayId")?.trim() ?? null;

        const [device] = await deps.db
            .select({ id: devices.id })
            .from(devices)
            .where(eq(devices.id, deviceId))
            .limit(1);

        if (!device) {
            return c.json({ error: "Device not found" }, 404);
        }

        if (reportedFw && /^\d+\.\d+\.\d+$/.test(reportedFw)) {
            await deps.db
                .update(devices)
                .set({ firmwareVersion: reportedFw })
                .where(eq(devices.id, deviceId));
        }

        const deviceDisplays = await getDisplaysForDevice(deps, deviceId);

        if (requestedDisplayId) {
            const selected = deviceDisplays.find((display) => display.displayId === requestedDisplayId);
            if (!selected) {
                return c.json({ error: "Display not found" }, 404);
            }

            return c.json({
                deviceId,
                displayId: selected.displayId,
                config: selected.config,
            });
        }

        return c.json({
            deviceId,
            displayId: deviceDisplays[0]?.displayId ?? null,
            config: deviceDisplays[0]?.config ?? normalizeConfig(null),
            displays: deviceDisplays,
        });
    });

    app.post(
        "/device/:deviceId/config",
        loadtestGuard,
        authRequired,
        requireDeviceAccess(deps, "deviceId"),
        async (c) => {
            const deviceId = c.req.param("deviceId");
            const body = await c.req.json().catch(() => null);
            const parsed = parseConfigUpdates(body);

            if (!parsed) {
                return c.json(
                    {
                        error: "Request body must be a JSON object with valid display config fields",
                    },
                    400,
                );
            }

            const [device] = await deps.db
                .select({ id: devices.id })
                .from(devices)
                .where(eq(devices.id, deviceId))
                .limit(1);

            if (!device) {
                return c.json({ error: "Device not found" }, 404);
            }

            const existingDisplay = parsed.displayId
                ? (
                      await deps.db
                          .select({ id: displays.id, config: displays.config })
                          .from(displays)
                          .where(and(eq(displays.deviceId, deviceId), eq(displays.id, parsed.displayId)))
                          .limit(1)
                  )[0] ?? null
                : (
                      await deps.db
                          .select({ id: displays.id, config: displays.config })
                          .from(displays)
                          .where(eq(displays.deviceId, deviceId))
                          .orderBy(desc(displays.createdAt), desc(displays.id))
                          .limit(1)
                  )[0] ?? null;

            const displayId = parsed.displayId ?? existingDisplay?.id ?? crypto.randomUUID();
            const nextConfig = normalizeConfig(
                existingDisplay?.config as DeviceConfig | null | undefined,
                parsed.updates,
            );

            const validationError = await validateDisplayLines(deps, nextConfig.lines);
            if (validationError) {
                return c.json({ error: validationError }, 400);
            }

            const persisted = existingDisplay
                ? (
                      await deps.db
                          .update(displays)
                          .set({
                              config: nextConfig,
                              updatedAt: new Date().toISOString(),
                          })
                          .where(and(eq(displays.deviceId, deviceId), eq(displays.id, displayId)))
                          .returning({
                              displayId: displays.id,
                              config: displays.config,
                              createdAt: displays.createdAt,
                              updatedAt: displays.updatedAt,
                          })
                  )[0]
                : (
                      await deps.db
                          .insert(displays)
                          .values({
                              id: displayId,
                              deviceId,
                              config: nextConfig,
                          })
                          .returning({
                              displayId: displays.id,
                              config: displays.config,
                              createdAt: displays.createdAt,
                              updatedAt: displays.updatedAt,
                          })
                  )[0];

            await deps.aggregator.reloadSubscriptions();
            await deps.aggregator.refreshDevice(deviceId);

            if (!persisted) {
                return c.json({ error: "Failed to persist display config" }, 500);
            }

            return c.json({
                deviceId,
                displayId: persisted.displayId,
                config: normalizeConfig(persisted.config as DeviceConfig | null | undefined),
                displays: await getDisplaysForDevice(deps, deviceId),
            });
        },
    );
}
