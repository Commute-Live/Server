import { and, asc, eq, inArray, or } from "drizzle-orm";
import { startDb } from "../../db/db.ts";
import { septaScheduledStopTimes, septaServiceDates, septaStops, type SeptaMode } from "../../db/schema/schema.ts";

export type ScheduledArrival = {
    arrivalTime: string;
    scheduledTime: string | null;
    delaySeconds: number | null;
    destination?: string;
    direction?: string;
    line?: string;
};

const TZ = "America/New_York";

const dateKey = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(d).replaceAll("-", "");

const parseYmd = (ymd: string) => {
    if (!/^\d{8}$/.test(ymd)) return null;
    const y = Number(ymd.slice(0, 4));
    const m = Number(ymd.slice(4, 6));
    const d = Number(ymd.slice(6, 8));
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    return { y, m, d };
};

const localToIso = (year: number, month: number, day: number, seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const utcLike = Date.UTC(year, month - 1, day, h, m, s);
    const probe = new Date(utcLike);
    const utcWall = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
    const zoneWall = new Date(probe.toLocaleString("en-US", { timeZone: TZ }));
    const offsetMinutes = Math.round((utcWall.getTime() - zoneWall.getTime()) / 60000);
    return new Date(utcLike + offsetMinutes * 60_000).toISOString();
};

const normalizeRailDirection = (value?: string | null) => {
    const v = (value ?? "").trim().toUpperCase();
    if (v === "N") return "N";
    if (v === "S") return "S";
    return "";
};

const normalizeSurfaceDirection = (value?: string | null) => {
    const v = (value ?? "").trim().toUpperCase();
    if (v === "N" || v === "0") return "0";
    if (v === "S" || v === "1") return "1";
    return "";
};

const normalizeDirection = (mode: SeptaMode, value?: string | null) =>
    mode === "rail" ? normalizeRailDirection(value) : normalizeSurfaceDirection(value);

export async function fillSeptaScheduledArrivals(opts: {
    mode: SeptaMode;
    routeId: string;
    stopInput: string;
    direction?: string;
    nowMs: number;
    limit: number;
}): Promise<ScheduledArrival[]> {
    const { db } = startDb();
    const routeId = opts.routeId.trim().toUpperCase();
    const stopInput = opts.stopInput.trim();
    const direction = normalizeDirection(opts.mode, opts.direction);
    const limit = Math.max(0, Math.min(10, opts.limit));
    if (!routeId || !stopInput || limit <= 0) return [];

    const now = new Date(opts.nowMs);
    const today = dateKey(now);
    const tomorrow = dateKey(new Date(opts.nowMs + 24 * 60 * 60 * 1000));

    const stopRows = await db
        .select({ id: septaStops.id })
        .from(septaStops)
        .where(
            and(
                eq(septaStops.mode, opts.mode),
                or(
                    eq(septaStops.id, stopInput),
                    eq(septaStops.name, stopInput),
                ),
            ),
        )
        .limit(10);

    const stopIds = Array.from(new Set(stopRows.map((r) => r.id).concat([stopInput])));
    if (stopIds.length === 0) return [];

    const rows = await db
        .select({
            serviceDate: septaServiceDates.serviceDate,
            arrivalSeconds: septaScheduledStopTimes.arrivalSeconds,
            headsign: septaScheduledStopTimes.headsign,
            direction: septaScheduledStopTimes.direction,
            routeId: septaScheduledStopTimes.routeId,
        })
        .from(septaScheduledStopTimes)
        .innerJoin(
            septaServiceDates,
            and(
                eq(septaServiceDates.mode, septaScheduledStopTimes.mode),
                eq(septaServiceDates.serviceId, septaScheduledStopTimes.serviceId),
            ),
        )
        .where(
            and(
                eq(septaScheduledStopTimes.mode, opts.mode),
                eq(septaScheduledStopTimes.routeId, routeId),
                inArray(septaScheduledStopTimes.stopId, stopIds),
                direction ? eq(septaScheduledStopTimes.direction, direction) : undefined,
                inArray(septaServiceDates.serviceDate, [today, tomorrow]),
            ),
        )
        .orderBy(asc(septaServiceDates.serviceDate), asc(septaScheduledStopTimes.arrivalSeconds))
        .limit(400);

    const out: ScheduledArrival[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        const ymd = parseYmd(row.serviceDate);
        if (!ymd) continue;
        const iso = localToIso(ymd.y, ymd.m, ymd.d, row.arrivalSeconds);
        const ts = Date.parse(iso);
        if (!Number.isFinite(ts) || ts < opts.nowMs - 15_000) continue;
        const key = `${row.routeId}:${row.direction}:${iso}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            arrivalTime: iso,
            scheduledTime: iso,
            delaySeconds: null,
            destination: row.headsign || undefined,
            direction: row.direction || undefined,
            line: row.routeId,
        });
        if (out.length >= limit) break;
    }
    return out;
}
