import { devices } from "./schema/schema.ts";
import type { DeviceConfig, Subscription } from "../types.ts";
import { normalizeDeviceConfig, SUPPORTED_PROVIDERS } from "../config/deviceConfig.ts";

export async function loadSubscriptionsFromDb(db: { select: Function }) {
    const rows = await db.select({ id: devices.id, config: devices.config }).from(devices);

    const subs: Subscription[] = [];

    for (const row of rows) {
        const cfg = normalizeDeviceConfig(row.config as DeviceConfig | null | undefined);
        const lines = Array.isArray(cfg.lines) ? cfg.lines : [];
        const deviceDisplayType = typeof cfg.displayType === "number" ? cfg.displayType : 1;
        const deviceScrolling = typeof cfg.scrolling === "boolean" ? cfg.scrolling : false;
        const deviceArrivalsToDisplay =
            typeof cfg.arrivalsToDisplay === "number" ? cfg.arrivalsToDisplay : 1;

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
