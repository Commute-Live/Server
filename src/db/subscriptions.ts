import { devices } from "./schema/schema.ts";
import type { DeviceConfig, LineConfig, Subscription } from "../types.ts";

const isLineConfig = (value: unknown): value is LineConfig =>
    !!value &&
    typeof value === "object" &&
    typeof (value as LineConfig).provider === "string" &&
    typeof (value as LineConfig).line === "string" &&
    (typeof (value as LineConfig).stop === "string" || (value as LineConfig).stop === undefined) &&
    (typeof (value as LineConfig).direction === "string" || (value as LineConfig).direction === undefined);

export async function loadSubscriptionsFromDb(db: { select: Function }) {
    const rows = await db.select({ id: devices.id, config: devices.config }).from(devices);

    const subs: Subscription[] = [];

    for (const row of rows) {
        const cfg = (row.config ?? {}) as DeviceConfig;
        const lines = Array.isArray(cfg.lines) ? cfg.lines.filter(isLineConfig) : [];

        for (const line of lines) {
            // Require minimal fields; skip malformed entries
            if (!line.provider || !line.line) continue;

            subs.push({
                deviceId: row.id,
                provider: line.provider,
                type: "arrivals",
                config: {
                    line: line.line,
                    stop: line.stop ?? "",
                    direction: line.direction ?? "",
                },
            });
        }
    }

    return subs;
}
