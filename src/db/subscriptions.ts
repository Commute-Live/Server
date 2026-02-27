import { devices } from "./schema/schema.ts";
import type { DeviceConfig, LineConfig, Subscription } from "../types.ts";

const SUPPORTED_PROVIDERS = new Set([
    "mta-subway",
    "mta-bus",
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
    const rows = await db.select({ id: devices.id, config: devices.config }).from(devices);

    const subs: Subscription[] = [];

    for (const row of rows) {
        const cfg = (row.config ?? {}) as DeviceConfig;
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
                deviceId: row.id,
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
            });
        }
    }

    return subs;
}
