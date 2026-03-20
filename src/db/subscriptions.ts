import { asc, eq } from "drizzle-orm";
import { devices, displays } from "./schema/schema.ts";
import { resolveActiveDisplay } from "../displays/selection.ts";
import type { DeviceConfig, DeviceDisplay, LineConfig, Subscription } from "../types.ts";

const SUPPORTED_PROVIDERS = new Set([
    "mta-subway",
    "mta-bus",
    "mta-lirr",
    "mbta",
    "cta-subway",
    "cta-bus",
    "septa-rail",
    "septa-bus",
    "septa-trolley",
]);

const clampArrivalsToDisplay = (value: unknown) => {
    if (typeof value !== "number" || Number.isNaN(value)) return 1;
    if (value < 1) return 1;
    if (value > 3) return 3;
    return Math.trunc(value);
};

const isLineConfig = (value: unknown): value is LineConfig => {
    if (!value || typeof value !== "object") return false;
    const v = value as LineConfig;
    if (typeof v.provider !== "string") return false;
    if (typeof v.line !== "string") return false;
    if (v.stop !== undefined && typeof v.stop !== "string") return false;
    if (v.direction !== undefined && typeof v.direction !== "string") return false;
    return true;
};

export async function loadSubscriptionsFromDb(db: { select: Function }) {
    const rows = await db
        .select({
            deviceId: displays.deviceId,
            displayId: displays.id,
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
            timezone: devices.timezone,
        })
        .from(displays)
        .innerJoin(devices, eq(devices.id, displays.deviceId))
        .orderBy(asc(displays.deviceId), asc(displays.sortOrder), asc(displays.createdAt), asc(displays.id));

    const subs: Subscription[] = [];
    const displaysByDevice = new Map<string, Array<DeviceDisplay & { timezone: string }>>();

    for (const row of rows) {
        const deviceDisplays = displaysByDevice.get(row.deviceId) ?? [];
        deviceDisplays.push({
            displayId: row.displayId,
            deviceId: row.deviceId,
            name: row.name ?? "",
            paused: row.paused ?? false,
            priority: row.priority ?? 0,
            sortOrder: row.sortOrder ?? 0,
            scheduleStart: row.scheduleStart ?? null,
            scheduleEnd: row.scheduleEnd ?? null,
            scheduleDays: Array.isArray(row.scheduleDays) ? row.scheduleDays : [],
            config: (row.config ?? {}) as DeviceConfig,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            timezone: row.timezone ?? "UTC",
        });
        displaysByDevice.set(row.deviceId, deviceDisplays);
    }

    for (const [deviceId, deviceDisplays] of displaysByDevice.entries()) {
        const activeDisplay = resolveActiveDisplay(deviceDisplays);
        if (!activeDisplay) continue;

        const cfg = (activeDisplay.config ?? {}) as DeviceConfig;
        const lines = Array.isArray(cfg.lines) ? cfg.lines.filter(isLineConfig) : [];
        const deviceDisplayType = typeof cfg.displayType === "number" ? cfg.displayType : 1;
        const deviceScrolling = typeof cfg.scrolling === "boolean" ? cfg.scrolling : false;
        const deviceArrivalsToDisplay = clampArrivalsToDisplay(cfg.arrivalsToDisplay);

        for (const line of lines) {
            // Require minimal fields; skip malformed entries
            if (!line.provider || !line.line) continue;
            const provider = line.provider.trim().toLowerCase();
            if (!SUPPORTED_PROVIDERS.has(provider)) continue;

            const displayType = typeof line.displayType === "number" ? line.displayType : deviceDisplayType;
            const scrolling = typeof line.scrolling === "boolean" ? line.scrolling : deviceScrolling;

            subs.push({
                deviceId,
                provider,
                type: "arrivals",
                config: {
                    line: line.line,
                    stop: line.stop ?? "",
                    direction: line.direction ?? "",
                },
                displayType,
                scrolling,
                arrivalsToDisplay: deviceArrivalsToDisplay,
                lineConfig: line,
            });
        }
    }

    return subs;
}
