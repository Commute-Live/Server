import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";
import { resolveSeptaRailRouteAliases, resolveSeptaRailStopName } from "./stops_lookup.ts";

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

const cleanDirectionLabel = (value?: string | null) => {
    if (!value) return "";
    return value
        .replace(/\s+Departures:\s*.*/i, "")
        .replace(/\s+Station$/i, "")
        .trim();
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
        if (!hhRaw || !mmRaw || !ampmRaw) return null;
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
            const destination = cleanDirectionLabel(a.destination) || cleanDirectionLabel(a.next_station) || undefined;
            return {
                arrivalTime: arrivalIso,
                scheduledTime: arrivalIso,
                delaySeconds: null,
                destination,
            };
        })
        .filter((a) => !!a.arrivalTime)
        .sort((a, b) => Date.parse(a.arrivalTime!) - Date.parse(b.arrivalTime!));

const normalizeLine = (line?: string | null) => (line ?? "").trim().toUpperCase();
const normalizeLineForMatch = (line?: string | null) =>
    (line ?? "")
        .trim()
        .toUpperCase()
        .replace(/\s+LINE$/i, "")
        .replace(/\s+/g, " ");

const fetchSeptaRailArrivals = async (key: string, ctx: FetchContext): Promise<FetchResult> => {
    const { params } = parseKeySegments(key);
    const stationRaw = params.stop || params.station || "";
    if (!stationRaw.trim()) throw new Error("SEPTA station is required (use stop=<station name>)");
    const station = resolveSeptaRailStopName(stationRaw) ?? stationRaw;
    const direction = params.direction?.toUpperCase() === "S" ? "S" : params.direction?.toUpperCase() === "N" ? "N" : undefined;
    const requestedLineRaw = normalizeLine(params.line);
    const requestedLineAliases = resolveSeptaRailRouteAliases(requestedLineRaw);
    const matchesRequestedLine = (line?: string | null) => {
        const value = normalizeLineForMatch(line);
        if (!value || requestedLineAliases.length === 0) return true;
        return requestedLineAliases.some((alias) => {
            const normalizedAlias = normalizeLineForMatch(alias);
            return (
                value === normalizedAlias ||
                value.includes(normalizedAlias) ||
                normalizedAlias.includes(value)
            );
        });
    };

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
    const north = requestedLineAliases.length > 0 ? northRaw.filter((a) => matchesRequestedLine(a.line)) : northRaw;
    const south = requestedLineAliases.length > 0 ? southRaw.filter((a) => matchesRequestedLine(a.line)) : southRaw;

    const arrivals = direction === "S" ? pickArrivals(south, "S", ctx.now) : direction === "N" ? pickArrivals(north, "N", ctx.now) : pickArrivals([...north, ...south], undefined, ctx.now);

    const first = (direction === "S" ? south : direction === "N" ? north : [...north, ...south])[0];
    const directionLabel =
        cleanDirectionLabel(first?.destination) ||
        cleanDirectionLabel(first?.next_station) ||
        stationLabel ||
        cleanDirectionLabel(first?.path);
    if (requestedLineAliases.length > 0 && arrivals.length === 0) {
        const available = [...northRaw, ...southRaw].map((a) => normalizeLine(a.line)).filter((v) => v.length > 0);
        const sample = Array.from(new Set(available)).slice(0, 12);
        console.log(
            `[SEPTA rail] no arrivals after line filter stationRaw="${stationRaw}" stationQuery="${station}" stationKey="${stationKey ?? ""}" requestedLine="${requestedLineRaw}" aliases="${requestedLineAliases.join("|")}" availableLines=${sample.join(",")}`,
        );
    }

    const destination = cleanDirectionLabel(first?.destination) || cleanDirectionLabel(first?.next_station) || undefined;

    return {
        payload: {
            provider: "septa-rail",
            line: requestedLineRaw || normalizeLine(first?.line) || "SEPTA",
            stop: stationLabel,
            stopId: stationRaw,
            direction: direction ?? first?.direction,
            directionLabel,
            destination,
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
