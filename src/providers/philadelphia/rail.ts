import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";
import { resolveSeptaRailStopName } from "./stops_lookup.ts";

const SEPTA_BASE = "https://www3.septa.org/api";
const CACHE_TTL_SECONDS = 20;
const ARRIVALS_RESULTS_LIMIT = 30;

type SeptaArrival = {
    direction: "N" | "S";
    path?: string;
    train_id?: string;
    origin?: string;
    destination?: string;
    line?: string;
    status?: string;
    next_station?: string;
    sched_time?: string;
    depart_time?: string;
    track?: string;
};

type SeptaArrivalsResponse = Record<
    string,
    Array<{
        Northbound?: SeptaArrival[];
        Southbound?: SeptaArrival[];
    }>
>;

const detectOffsetMinutesForTimezone = (timezone: string, utcLikeMs: number) => {
    const probe = new Date(utcLikeMs);
    const utcWall = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
    const zoneWall = new Date(probe.toLocaleString("en-US", { timeZone: timezone }));
    return Math.round((utcWall.getTime() - zoneWall.getTime()) / 60000);
};

const parseLocalTimeToIso = (
    timezone: string,
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
) => {
    const asUtcLike = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetMinutes = detectOffsetMinutesForTimezone(timezone, asUtcLike);
    return new Date(asUtcLike + offsetMinutes * 60_000).toISOString();
};

const cleanStationLabel = (value?: string | null) => {
    if (!value) return "";
    return value.replace(/\s+Departures:\s*.*/i, "").trim();
};

const parseTimeToIso = (timeStr?: string | null, nowMs = Date.now()) => {
    if (!timeStr) return null;
    const trimmed = timeStr.trim();
    if (!trimmed) return null;
    // If already ISO or epoch
    const isoParsed = Date.parse(trimmed);
    if (Number.isFinite(isoParsed)) return new Date(isoParsed).toISOString();

    // Common format from SEPTA: "3:45PM" or "03:45 PM"
    const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (match) {
        const [, hhRaw, mmRaw, ampmRaw] = match;
        let hh = Number(hhRaw);
        const mm = Number(mmRaw);
        const ampm = ampmRaw.toUpperCase();
        if (ampm === "PM" && hh !== 12) hh += 12;
        if (ampm === "AM" && hh === 12) hh = 0;
        const now = new Date(nowMs);
        let candidateMs = Date.parse(
            parseLocalTimeToIso(
                "America/New_York",
                now.getUTCFullYear(),
                now.getUTCMonth() + 1,
                now.getUTCDate(),
                hh,
                mm,
                0,
            ),
        );

        // SEPTA times are local clock times without date. If the parsed value is far in the past,
        // treat it as the next day (late-night rollover window).
        if (Number.isFinite(candidateMs) && candidateMs < nowMs - 3 * 60 * 60 * 1000) {
            candidateMs += 24 * 60 * 60 * 1000;
        }

        if (Number.isFinite(candidateMs)) return new Date(candidateMs).toISOString();
    }
    return null;
};

const pickArrivals = (arr: SeptaArrival[] = [], direction?: "N" | "S", nowMs = Date.now()) =>
    arr
        .filter((a) => (direction ? a.direction === direction : true))
        .map((a) => {
            const arrivalIso = parseTimeToIso(a.depart_time ?? a.sched_time, nowMs);
            return {
                arrivalTime: arrivalIso,
                scheduledTime: arrivalIso,
                delaySeconds: null,
            };
        })
        .filter((a) => !!a.arrivalTime)
        .sort((a, b) => Date.parse(a.arrivalTime!) - Date.parse(b.arrivalTime!));

const normalizeLine = (line?: string | null) => (line ?? "").trim().toUpperCase();

const fetchSeptaRailArrivals = async (key: string, ctx: FetchContext): Promise<FetchResult> => {
    const { params } = parseKeySegments(key);
    const stationRaw = params.stop || params.station || "";
    if (!stationRaw.trim()) throw new Error("SEPTA station is required (use stop=<station name>)");
    const station = resolveSeptaRailStopName(stationRaw) ?? stationRaw;
    const direction = params.direction?.toUpperCase() === "S" ? "S" : params.direction?.toUpperCase() === "N" ? "N" : undefined;
    const requestedLine = normalizeLine(params.line);

    const search = new URLSearchParams({
        station: station,
        results: String(ARRIVALS_RESULTS_LIMIT),
    });
    if (direction) search.set("direction", direction);

    const url = `${SEPTA_BASE}/Arrivals/index.php?${search.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`SEPTA Arrivals error ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as SeptaArrivalsResponse;
    const stationKey = Object.keys(json)[0];
    const stationLabel = cleanStationLabel(stationKey) || station;
    const body = stationKey ? json[stationKey]?.[0] : undefined;
    const northRaw = body?.Northbound ?? [];
    const southRaw = body?.Southbound ?? [];
    const north =
        requestedLine.length > 0 ? northRaw.filter((a) => normalizeLine(a.line) === requestedLine) : northRaw;
    const south =
        requestedLine.length > 0 ? southRaw.filter((a) => normalizeLine(a.line) === requestedLine) : southRaw;

    const arrivals = direction === "S" ? pickArrivals(south, "S", ctx.now) : direction === "N" ? pickArrivals(north, "N", ctx.now) : pickArrivals([...north, ...south], undefined, ctx.now);

    const first = (direction === "S" ? south : direction === "N" ? north : [...north, ...south])[0];
    if (requestedLine.length > 0 && arrivals.length === 0) {
        const available = [...northRaw, ...southRaw].map((a) => normalizeLine(a.line)).filter((v) => v.length > 0);
        const sample = Array.from(new Set(available)).slice(0, 12);
        console.log(
            `[SEPTA rail] no arrivals after line filter stationRaw="${stationRaw}" stationQuery="${station}" stationKey="${stationKey ?? ""}" requestedLine="${requestedLine}" availableLines=${sample.join(",")}`,
        );
    }

    return {
        payload: {
            provider: "septa-rail",
            line: requestedLine || normalizeLine(first?.line) || "SEPTA",
            stop: stationLabel,
            stopId: stationRaw,
            direction: direction ?? first?.direction,
            directionLabel: first?.path ?? first?.destination ?? stationLabel,
            arrivals,
            fetchedAt: new Date(ctx.now).toISOString(),
        },
        ttlSeconds: CACHE_TTL_SECONDS,
    };
};

export const septaRailProvider: ProviderPlugin = {
    providerId: "septa-rail",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("septa-rail", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchSeptaRailArrivals(key, ctx),
};

registerProvider(septaRailProvider);
