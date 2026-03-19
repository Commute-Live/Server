import type { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import type { dependency } from "../types/dependency.d.ts";
import { devices, displays } from "../db/schema/schema.ts";
import { resolveActiveDisplay } from "../displays/selection.ts";
import type { DeviceConfig, DeviceDisplay, DisplayWeekday, LineConfig } from "../types.ts";
import { authRequired } from "../middleware/auth.ts";
import { requireDeviceAccess } from "../middleware/deviceAccess.ts";
import { loadtestGuard } from "../middleware/loadtest.ts";
import {
    getCoreStationById as getMtaStationById,
    listCoreLinesForStation as listMtaLinesForStation,
    normalizeCoreLineId as normalizeMtaLineId,
} from "../mta/core_catalog.ts";
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
const DEFAULT_DISPLAY_NAME = "Display";
const VALID_WEEKDAYS: DisplayWeekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SUPPORTED_PROVIDERS = new Set([
    "mta-subway",
    "mta-bus",
    "mbta",
    "cta-subway",
    "cta-bus",
    "septa-rail",
    "septa-bus",
]);
const CUSTOM_TEXT_FORMATS = new Set(["top-bottom", "custom-text", "split-text"]);

type DisplayMetadataUpdates = {
    name?: string;
    paused?: boolean;
    priority?: number;
    sortOrder?: number;
    scheduleStart?: string | null;
    scheduleEnd?: string | null;
    scheduleDays?: DisplayWeekday[];
};

type DisplayWritePayload = {
    displayId?: string;
    metadata: DisplayMetadataUpdates;
    configUpdates: Partial<DeviceConfig>;
};

type DisplayRow = {
    displayId: string;
    deviceId: string;
    timezone: string;
    name: string;
    paused: boolean;
    priority: number;
    sortOrder: number;
    scheduleStart: string | null;
    scheduleEnd: string | null;
    scheduleDays: DisplayWeekday[];
    config: DeviceConfig;
    createdAt: string;
    updatedAt: string;
};

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
        if (candidate.label !== undefined && typeof candidate.label !== "string") return false;
        if (candidate.secondaryLabel !== undefined && typeof candidate.secondaryLabel !== "string") return false;
        if (candidate.topText !== undefined && typeof candidate.topText !== "string") return false;
        if (candidate.bottomText !== undefined && typeof candidate.bottomText !== "string") return false;
        if (candidate.textColor !== undefined && typeof candidate.textColor !== "string") return false;
        if (candidate.nextStops !== undefined && typeof candidate.nextStops !== "number") return false;
        if (candidate.displayFormat !== undefined && typeof candidate.displayFormat !== "string") return false;
        if (candidate.primaryContent !== undefined && typeof candidate.primaryContent !== "string") return false;
        if (candidate.secondaryContent !== undefined && typeof candidate.secondaryContent !== "string") return false;
        return true;
    });
};

const normalizeOptionalText = (value: unknown) => {
    if (typeof value !== "string") return "";
    return value.trim();
};

const validateLineConfigs = (lines: LineConfig[] | undefined) => {
    if (!Array.isArray(lines)) return null;

    for (const [index, row] of lines.entries()) {
        const provider = normalizeOptionalText(row.provider).toLowerCase();
        const line = normalizeOptionalText(row.line);
        const stop = normalizeOptionalText(row.stop);
        const topText = normalizeOptionalText(row.topText);
        const bottomText = normalizeOptionalText(row.bottomText);
        const displayFormat = normalizeOptionalText(row.displayFormat).toLowerCase();

        if (!provider) {
            return `Line ${index + 1}: provider is required`;
        }
        if (!line) {
            return `Line ${index + 1}: line is required`;
        }
        if (SUPPORTED_PROVIDERS.has(provider) && !stop) {
            return `Line ${index + 1}: stop is required`;
        }
        if ((topText && !bottomText) || (!topText && bottomText)) {
            return `Line ${index + 1}: topText and bottomText must both be provided`;
        }
        if (CUSTOM_TEXT_FORMATS.has(displayFormat) && (!topText || !bottomText)) {
            return `Line ${index + 1}: displayFormat '${displayFormat}' requires both topText and bottomText`;
        }
    }

    return null;
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

const normalizeScheduleTime = (value: unknown) => {
    if (value === null) return null;
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed.length) return null;
    if (!CLOCK_RE.test(trimmed)) return undefined;
    return trimmed;
};

const normalizeScheduleDays = (value: unknown) => {
    if (value === null) return [];
    if (!Array.isArray(value)) return undefined;

    const uniqueDays = new Set<DisplayWeekday>();
    for (const item of value) {
        if (typeof item !== "string") return undefined;
        const day = item.trim().toLowerCase() as DisplayWeekday;
        if (!VALID_WEEKDAYS.includes(day)) return undefined;
        uniqueDays.add(day);
    }
    return VALID_WEEKDAYS.filter((day) => uniqueDays.has(day));
};

const normalizeInteger = (value: unknown) => {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && value.trim().length) {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) return parsed;
    }
    return undefined;
};

const normalizeName = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : "";
};

const parseConfigUpdates = (body: unknown): DisplayWritePayload | null => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;

    const raw = body as Record<string, unknown>;
    const displayId =
        typeof raw.displayId === "string" && raw.displayId.trim().length > 0
            ? raw.displayId.trim()
            : undefined;
    const payload =
        raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)
            ? (raw.config as Record<string, unknown>)
            : raw;

    const configUpdates: Partial<DeviceConfig> = {};
    const metadata: DisplayMetadataUpdates = {};

    const maybeBrightness = payload.brightness;
    if (typeof maybeBrightness === "number") {
        configUpdates.brightness = maybeBrightness;
    } else if (typeof maybeBrightness === "string" && maybeBrightness.trim() !== "") {
        const parsed = Number(maybeBrightness);
        if (!Number.isNaN(parsed)) configUpdates.brightness = parsed;
    }

    if ("displayType" in payload) {
        const maybeDisplay = payload.displayType;
        if (typeof maybeDisplay === "number" && !Number.isNaN(maybeDisplay)) {
            configUpdates.displayType = maybeDisplay;
        }
    }

    if ("scrolling" in payload && typeof payload.scrolling === "boolean") {
        configUpdates.scrolling = payload.scrolling;
    }

    if ("arrivalsToDisplay" in payload) {
        const maybeArrivalsToDisplay = payload.arrivalsToDisplay;
        if (
            typeof maybeArrivalsToDisplay === "number" &&
            !Number.isNaN(maybeArrivalsToDisplay)
        ) {
            configUpdates.arrivalsToDisplay = normalizeArrivalsToDisplay(maybeArrivalsToDisplay);
        }
    }

    if ("lines" in payload) {
        const proposed = payload.lines;
        if (proposed === undefined || proposed === null) {
            configUpdates.lines = [];
        } else if (!validateLines(proposed)) {
            return null;
        } else {
            configUpdates.lines = proposed as LineConfig[];
        }
    }

    if ("name" in raw) {
        const normalized = normalizeName(raw.name);
        if (normalized === undefined) return null;
        metadata.name = normalized;
    }

    if ("paused" in raw) {
        if (typeof raw.paused !== "boolean") return null;
        metadata.paused = raw.paused;
    }

    if ("priority" in raw) {
        const normalized = normalizeInteger(raw.priority);
        if (normalized === undefined) return null;
        metadata.priority = normalized;
    }

    if ("sortOrder" in raw) {
        const normalized = normalizeInteger(raw.sortOrder);
        if (normalized === undefined) return null;
        metadata.sortOrder = normalized;
    }

    if ("scheduleStart" in raw) {
        const normalized = normalizeScheduleTime(raw.scheduleStart);
        if (normalized === undefined) return null;
        metadata.scheduleStart = normalized;
    }

    if ("scheduleEnd" in raw) {
        const normalized = normalizeScheduleTime(raw.scheduleEnd);
        if (normalized === undefined) return null;
        metadata.scheduleEnd = normalized;
    }

    if ("scheduleDays" in raw) {
        const normalized = normalizeScheduleDays(raw.scheduleDays);
        if (normalized === undefined) return null;
        metadata.scheduleDays = normalized;
    }

    return { displayId, metadata, configUpdates };
};

const toDisplayRecord = (
    row: {
        displayId: string;
        deviceId: string;
        timezone: string;
        name: string | null;
        paused: boolean | null;
        priority: number | null;
        sortOrder: number | null;
        scheduleStart: string | null;
        scheduleEnd: string | null;
        scheduleDays: DisplayWeekday[] | null;
        config: DeviceConfig | null;
        createdAt: string;
        updatedAt: string;
    },
): DisplayRow => ({
    displayId: row.displayId,
    deviceId: row.deviceId,
    timezone: row.timezone || "UTC",
    name: row.name?.trim() || DEFAULT_DISPLAY_NAME,
    paused: row.paused ?? false,
    priority: row.priority ?? 0,
    sortOrder: row.sortOrder ?? 0,
    scheduleStart: row.scheduleStart ?? null,
    scheduleEnd: row.scheduleEnd ?? null,
    scheduleDays: Array.isArray(row.scheduleDays) ? row.scheduleDays : [],
    config: normalizeConfig(row.config),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const toDisplayResponse = (
    display: DisplayRow,
    isActive: boolean,
): DeviceDisplay & { isActive: boolean } => ({
    displayId: display.displayId,
    deviceId: display.deviceId,
    name: display.name,
    paused: display.paused,
    priority: display.priority,
    sortOrder: display.sortOrder,
    scheduleStart: display.scheduleStart,
    scheduleEnd: display.scheduleEnd,
    scheduleDays: display.scheduleDays,
    config: display.config,
    createdAt: display.createdAt,
    updatedAt: display.updatedAt,
    isActive,
});

const normalizeMtaSubwayDirection = (value: string | undefined) => {
    const normalized = (value ?? "").trim().toUpperCase();
    return normalized === "N" || normalized === "S" ? normalized : "";
};

async function resolveMtaSubwayStopForConfig(
    deps: dependency,
    rawStop: string,
    rawDirection: string | undefined,
) {
    const normalizedStop = rawStop.trim().toUpperCase();
    if (!normalizedStop) return null;

    let station = await getMtaStationById(deps.db, "subway", normalizedStop);
    if (!station && /[NS]$/.test(normalizedStop)) {
        station = await getMtaStationById(deps.db, "subway", normalizedStop.slice(0, -1));
    }
    if (!station) return null;

    const childStopIds = station.childStopIds
        .map((value) => value.trim().toUpperCase())
        .filter((value) => value.length > 0);
    const requestedDirection =
        normalizeMtaSubwayDirection(rawDirection) ||
        (/[NS]$/.test(normalizedStop) ? normalizedStop.slice(-1) : "");

    let providerStop = normalizedStop;
    if (!childStopIds.includes(providerStop)) {
        if (requestedDirection) {
            providerStop =
                childStopIds.find((value) => value.endsWith(requestedDirection)) ?? "";
        } else if (childStopIds.length === 1) {
            providerStop = childStopIds[0] ?? "";
        } else {
            providerStop = "";
        }
    }

    const resolvedDirection =
        requestedDirection ||
        (providerStop.endsWith("N") ? "N" : providerStop.endsWith("S") ? "S" : "");

    return {
        station,
        providerStop,
        direction: resolvedDirection,
    };
}

async function validateDisplayLines(deps: dependency, lines: LineConfig[] | undefined) {
    if (!Array.isArray(lines) || lines.length === 0) return null;

    const configError = validateLineConfigs(lines);
    if (configError) return configError;

    for (const row of lines) {
        const provider = (row.provider ?? "").trim().toLowerCase();
        const rawLine = (row.line ?? "").trim();
        const line = rawLine.toUpperCase();
        const rawStop = (row.stop ?? "").trim();
        const stop = rawStop.toUpperCase();

        if (!SUPPORTED_PROVIDERS.has(provider)) {
            return `Unsupported provider '${provider}'. Supported providers: ${Array.from(
                SUPPORTED_PROVIDERS,
            ).join(", ")}`;
        }

        if (provider === "mta-subway" && line && stop) {
            const normalizedLine = normalizeMtaLineId("subway", line);
            const resolvedStop = await resolveMtaSubwayStopForConfig(deps, stop, row.direction);
            if (!resolvedStop?.providerStop) {
                return `Invalid line+stop combination for New York subway: line ${line} does not serve stop ${stop}`;
            }

            const stopLines = await listMtaLinesForStation(
                deps.db,
                "subway",
                resolvedStop.station.stopId,
            );
            const normalizedStopLines = stopLines.map((entry) =>
                normalizeMtaLineId("subway", entry.id),
            );
            if (!normalizedStopLines.includes(normalizedLine)) {
                return `Invalid line+stop combination for New York subway: line ${line} does not serve stop ${stop}`;
            }

            row.line = normalizedLine;
            row.stop = resolvedStop.providerStop;
            if (resolvedStop.direction) {
                row.direction = resolvedStop.direction;
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
            const normalizedStopLines = ctaStopLines.map((v) =>
                normalizeCtaLineId(ctaMode, v.id),
            );
            if (!normalizedStopLines.includes(normalizedLine)) {
                return `Invalid line+stop combination for Chicago ${ctaMode}: line ${line} does not serve stop ${stop}`;
            }
            row.line = normalizedLine;
        }
    }

    return null;
}

async function getDeviceRow(deps: dependency, deviceId: string) {
    const [device] = await deps.db
        .select({ id: devices.id, timezone: devices.timezone })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
    return device ?? null;
}

async function getDisplayRowsForDevice(deps: dependency, deviceId: string) {
    const rows = await deps.db
        .select({
            displayId: displays.id,
            deviceId: displays.deviceId,
            timezone: devices.timezone,
            name: displays.name,
            paused: displays.paused,
            priority: displays.priority,
            sortOrder: displays.sortOrder,
            scheduleStart: displays.scheduleStart,
            scheduleEnd: displays.scheduleEnd,
            scheduleDays: displays.scheduleDays,
            config: displays.config,
            createdAt: displays.createdAt,
            updatedAt: displays.updatedAt,
        })
        .from(displays)
        .innerJoin(devices, eq(devices.id, displays.deviceId))
        .where(eq(displays.deviceId, deviceId))
        .orderBy(
            asc(displays.sortOrder),
            desc(displays.priority),
            asc(displays.createdAt),
            asc(displays.id),
        );

    return rows.map(toDisplayRecord);
}

async function getDisplayRow(deps: dependency, deviceId: string, displayId: string) {
    const [row] = await deps.db
        .select({
            displayId: displays.id,
            deviceId: displays.deviceId,
            timezone: devices.timezone,
            name: displays.name,
            paused: displays.paused,
            priority: displays.priority,
            sortOrder: displays.sortOrder,
            scheduleStart: displays.scheduleStart,
            scheduleEnd: displays.scheduleEnd,
            scheduleDays: displays.scheduleDays,
            config: displays.config,
            createdAt: displays.createdAt,
            updatedAt: displays.updatedAt,
        })
        .from(displays)
        .innerJoin(devices, eq(devices.id, displays.deviceId))
        .where(and(eq(displays.deviceId, deviceId), eq(displays.id, displayId)))
        .limit(1);

    return row ? toDisplayRecord(row) : null;
}

async function getResolvedDisplaysForDevice(deps: dependency, deviceId: string) {
    const deviceDisplays = await getDisplayRowsForDevice(deps, deviceId);
    const active = resolveActiveDisplay(deviceDisplays);
    const activeDisplay = active
        ? ({
              ...active,
              config: normalizeConfig(active.config),
          } as DisplayRow)
        : null;
    return {
        activeDisplayId: activeDisplay?.displayId ?? null,
        activeDisplay: activeDisplay ? toDisplayResponse(activeDisplay, true) : null,
        displays: deviceDisplays.map((display) =>
            toDisplayResponse(display, display.displayId === activeDisplay?.displayId),
        ),
    };
}

async function compactSortOrder(deps: dependency, deviceId: string) {
    const rows = await deps.db
        .select({ displayId: displays.id })
        .from(displays)
        .where(eq(displays.deviceId, deviceId))
        .orderBy(
            asc(displays.sortOrder),
            desc(displays.priority),
            asc(displays.createdAt),
            asc(displays.id),
        );

    await Promise.all(
        rows.map((row, index) =>
            deps.db
                .update(displays)
                .set({ sortOrder: index, updatedAt: new Date().toISOString() })
                .where(and(eq(displays.deviceId, deviceId), eq(displays.id, row.displayId))),
        ),
    );
}

async function createDisplayRecord(
    deps: dependency,
    deviceId: string,
    payload: DisplayWritePayload,
) {
    const existingDisplays = await getDisplayRowsForDevice(deps, deviceId);
    const nextConfig = normalizeConfig(null, payload.configUpdates);
    const validationError = await validateDisplayLines(deps, nextConfig.lines);
    if (validationError) return { error: validationError };

    const nextSortOrder =
        payload.metadata.sortOrder !== undefined
            ? payload.metadata.sortOrder
            : existingDisplays.length;
    const displayId = payload.displayId ?? crypto.randomUUID();

    const [persisted] = await deps.db
        .insert(displays)
        .values({
            id: displayId,
            deviceId,
            name: payload.metadata.name ?? `${DEFAULT_DISPLAY_NAME} ${existingDisplays.length + 1}`,
            paused: payload.metadata.paused ?? false,
            priority: payload.metadata.priority ?? 0,
            sortOrder: nextSortOrder,
            scheduleStart: payload.metadata.scheduleStart ?? null,
            scheduleEnd: payload.metadata.scheduleEnd ?? null,
            scheduleDays: payload.metadata.scheduleDays ?? [],
            config: nextConfig,
        })
        .returning({ displayId: displays.id });

    if (!persisted) {
        return { error: "Failed to create display" };
    }

    if (nextSortOrder < existingDisplays.length) {
        await compactSortOrder(deps, deviceId);
    }

    await deps.aggregator.reloadSubscriptions();
    await deps.aggregator.refreshDevice(deviceId);

    return { displayId: persisted.displayId };
}

async function updateDisplayRecord(
    deps: dependency,
    deviceId: string,
    existingDisplay: DisplayRow,
    payload: DisplayWritePayload,
) {
    const nextConfig = normalizeConfig(existingDisplay.config, payload.configUpdates);
    const validationError = await validateDisplayLines(deps, nextConfig.lines);
    if (validationError) return { error: validationError };

    const nextSortOrder =
        payload.metadata.sortOrder !== undefined
            ? payload.metadata.sortOrder
            : existingDisplay.sortOrder;

    const [persisted] = await deps.db
        .update(displays)
        .set({
            name: payload.metadata.name ?? existingDisplay.name,
            paused: payload.metadata.paused ?? existingDisplay.paused,
            priority: payload.metadata.priority ?? existingDisplay.priority,
            sortOrder: nextSortOrder,
            scheduleStart:
                payload.metadata.scheduleStart !== undefined
                    ? payload.metadata.scheduleStart
                    : existingDisplay.scheduleStart,
            scheduleEnd:
                payload.metadata.scheduleEnd !== undefined
                    ? payload.metadata.scheduleEnd
                    : existingDisplay.scheduleEnd,
            scheduleDays:
                payload.metadata.scheduleDays !== undefined
                    ? payload.metadata.scheduleDays
                    : existingDisplay.scheduleDays,
            config: nextConfig,
            updatedAt: new Date().toISOString(),
        })
        .where(and(eq(displays.deviceId, deviceId), eq(displays.id, existingDisplay.displayId)))
        .returning({ displayId: displays.id });

    if (!persisted) {
        return { error: "Failed to update display" };
    }

    if (nextSortOrder !== existingDisplay.sortOrder) {
        await compactSortOrder(deps, deviceId);
    }

    await deps.aggregator.reloadSubscriptions();
    await deps.aggregator.refreshDevice(deviceId);

    return { displayId: persisted.displayId };
}

export function registerConfig(app: Hono, deps: dependency) {
    app.get("/device/:deviceId/config", loadtestGuard, async (c) => {
        const deviceId = c.req.param("deviceId");
        const reportedFw = c.req.query("fw")?.trim() ?? null;
        const requestedDisplayId = c.req.query("displayId")?.trim() ?? null;

        const device = await getDeviceRow(deps, deviceId);
        if (!device) {
            return c.json({ error: "Device not found" }, 404);
        }

        if (reportedFw && /^\d+\.\d+\.\d+$/.test(reportedFw)) {
            await deps.db
                .update(devices)
                .set({ firmwareVersion: reportedFw })
                .where(eq(devices.id, deviceId));
        }

        if (requestedDisplayId) {
            const display = await getDisplayRow(deps, deviceId, requestedDisplayId);
            if (!display) {
                return c.json({ error: "Display not found" }, 404);
            }
            const resolved = await getResolvedDisplaysForDevice(deps, deviceId);
            return c.json({
                deviceId,
                displayId: display.displayId,
                config: display.config,
                display: toDisplayResponse(display, display.displayId === resolved.activeDisplayId),
                activeDisplayId: resolved.activeDisplayId,
            });
        }

        const resolved = await getResolvedDisplaysForDevice(deps, deviceId);
        return c.json({
            deviceId,
            displayId: resolved.activeDisplayId,
            config: resolved.activeDisplay?.config ?? normalizeConfig(null),
            activeDisplayId: resolved.activeDisplayId,
            display: resolved.activeDisplay,
            displays: resolved.displays,
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
                    { error: "Request body must be a JSON object with valid display fields" },
                    400,
                );
            }

            const device = await getDeviceRow(deps, deviceId);
            if (!device) {
                return c.json({ error: "Device not found" }, 404);
            }

            const existingDisplay = parsed.displayId
                ? await getDisplayRow(deps, deviceId, parsed.displayId)
                : null;

            if (parsed.displayId && !existingDisplay) {
                return c.json({ error: "Display not found" }, 404);
            }

            const result = existingDisplay
                ? await updateDisplayRecord(deps, deviceId, existingDisplay, parsed)
                : await createDisplayRecord(deps, deviceId, parsed);

            if ("error" in result) {
                return c.json({ error: result.error }, 400);
            }

            const resolved = await getResolvedDisplaysForDevice(deps, deviceId);
            const saved =
                resolved.displays.find((display) => display.displayId === result.displayId) ?? null;

            return c.json({
                deviceId,
                displayId: result.displayId,
                activeDisplayId: resolved.activeDisplayId,
                config: saved?.config ?? normalizeConfig(null),
                display: saved,
                displays: resolved.displays,
            });
        },
    );

    app.get(
        "/device/:deviceId/displays",
        authRequired,
        requireDeviceAccess(deps, "deviceId"),
        async (c) => {
            const deviceId = c.req.param("deviceId");
            const device = await getDeviceRow(deps, deviceId);
            if (!device) {
                return c.json({ error: "Device not found" }, 404);
            }

            const resolved = await getResolvedDisplaysForDevice(deps, deviceId);
            return c.json({
                deviceId,
                activeDisplayId: resolved.activeDisplayId,
                activeDisplay: resolved.activeDisplay,
                displays: resolved.displays,
            });
        },
    );

    app.get(
        "/device/:deviceId/displays/active",
        authRequired,
        requireDeviceAccess(deps, "deviceId"),
        async (c) => {
            const deviceId = c.req.param("deviceId");
            const device = await getDeviceRow(deps, deviceId);
            if (!device) {
                return c.json({ error: "Device not found" }, 404);
            }

            const resolved = await getResolvedDisplaysForDevice(deps, deviceId);
            return c.json({
                deviceId,
                activeDisplayId: resolved.activeDisplayId,
                activeDisplay: resolved.activeDisplay,
            });
        },
    );

    app.get(
        "/device/:deviceId/displays/:displayId",
        authRequired,
        requireDeviceAccess(deps, "deviceId"),
        async (c) => {
            const deviceId = c.req.param("deviceId");
            const displayId = c.req.param("displayId");
            const display = await getDisplayRow(deps, deviceId, displayId);
            if (!display) {
                return c.json({ error: "Display not found" }, 404);
            }

            const resolved = await getResolvedDisplaysForDevice(deps, deviceId);
            return c.json({
                deviceId,
                activeDisplayId: resolved.activeDisplayId,
                display: toDisplayResponse(display, display.displayId === resolved.activeDisplayId),
            });
        },
    );

    app.post(
        "/device/:deviceId/displays",
        authRequired,
        requireDeviceAccess(deps, "deviceId"),
        async (c) => {
            const deviceId = c.req.param("deviceId");
            const body = await c.req.json().catch(() => null);
            const parsed = parseConfigUpdates(body);

            if (!parsed) {
                return c.json(
                    { error: "Request body must be a JSON object with valid display fields" },
                    400,
                );
            }

            const device = await getDeviceRow(deps, deviceId);
            if (!device) {
                return c.json({ error: "Device not found" }, 404);
            }

            const result = await createDisplayRecord(deps, deviceId, parsed);
            if ("error" in result) {
                return c.json({ error: result.error }, 400);
            }

            const resolved = await getResolvedDisplaysForDevice(deps, deviceId);
            const created =
                resolved.displays.find((display) => display.displayId === result.displayId) ?? null;

            return c.json(
                {
                    deviceId,
                    activeDisplayId: resolved.activeDisplayId,
                    display: created,
                    displays: resolved.displays,
                },
                201,
            );
        },
    );

    app.patch(
        "/device/:deviceId/displays/:displayId",
        authRequired,
        requireDeviceAccess(deps, "deviceId"),
        async (c) => {
            const deviceId = c.req.param("deviceId");
            const displayId = c.req.param("displayId");
            const body = await c.req.json().catch(() => null);
            const parsed = parseConfigUpdates({
                ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
                displayId,
            });

            if (!parsed) {
                return c.json(
                    { error: "Request body must be a JSON object with valid display fields" },
                    400,
                );
            }

            const existingDisplay = await getDisplayRow(deps, deviceId, displayId);
            if (!existingDisplay) {
                return c.json({ error: "Display not found" }, 404);
            }

            const result = await updateDisplayRecord(deps, deviceId, existingDisplay, parsed);
            if ("error" in result) {
                return c.json({ error: result.error }, 400);
            }

            const resolved = await getResolvedDisplaysForDevice(deps, deviceId);
            const updated =
                resolved.displays.find((display) => display.displayId === displayId) ?? null;

            return c.json({
                deviceId,
                activeDisplayId: resolved.activeDisplayId,
                display: updated,
                displays: resolved.displays,
            });
        },
    );

    app.delete(
        "/device/:deviceId/displays/:displayId",
        authRequired,
        requireDeviceAccess(deps, "deviceId"),
        async (c) => {
            const deviceId = c.req.param("deviceId");
            const displayId = c.req.param("displayId");
            const existingDisplay = await getDisplayRow(deps, deviceId, displayId);
            if (!existingDisplay) {
                return c.json({ error: "Display not found" }, 404);
            }

            await deps.db
                .delete(displays)
                .where(and(eq(displays.deviceId, deviceId), eq(displays.id, displayId)));

            await compactSortOrder(deps, deviceId);
            await deps.aggregator.reloadSubscriptions();
            await deps.aggregator.refreshDevice(deviceId);

            const resolved = await getResolvedDisplaysForDevice(deps, deviceId);
            return c.json({
                deviceId,
                deletedDisplayId: displayId,
                activeDisplayId: resolved.activeDisplayId,
                displays: resolved.displays,
            });
        },
    );

    app.post(
        "/device/:deviceId/displays/reorder",
        authRequired,
        requireDeviceAccess(deps, "deviceId"),
        async (c) => {
            const deviceId = c.req.param("deviceId");
            const rawBody = await c.req.json().catch(() => null);
            const body =
                rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
                    ? (rawBody as Record<string, unknown>)
                    : null;
            const displayIds = Array.isArray(body?.displayIds)
                ? body.displayIds.filter(
                      (value): value is string =>
                          typeof value === "string" && value.trim().length > 0,
                  )
                : null;

            if (!displayIds?.length) {
                return c.json({ error: "displayIds must be a non-empty array" }, 400);
            }

            const existingDisplays = await getDisplayRowsForDevice(deps, deviceId);
            const existingIds = new Set(existingDisplays.map((display) => display.displayId));

            if (displayIds.length !== existingIds.size) {
                return c.json({ error: "displayIds must include every display exactly once" }, 400);
            }
            if (new Set(displayIds).size !== displayIds.length) {
                return c.json({ error: "displayIds must not contain duplicates" }, 400);
            }
            if (displayIds.some((displayId) => !existingIds.has(displayId))) {
                return c.json({ error: "displayIds contains an unknown display" }, 400);
            }

            await Promise.all(
                displayIds.map((displayId, index) =>
                    deps.db
                        .update(displays)
                        .set({ sortOrder: index, updatedAt: new Date().toISOString() })
                        .where(and(eq(displays.deviceId, deviceId), eq(displays.id, displayId))),
                ),
            );

            await deps.aggregator.reloadSubscriptions();
            await deps.aggregator.refreshDevice(deviceId);

            const resolved = await getResolvedDisplaysForDevice(deps, deviceId);
            return c.json({
                deviceId,
                activeDisplayId: resolved.activeDisplayId,
                displays: resolved.displays,
            });
        },
    );
}
