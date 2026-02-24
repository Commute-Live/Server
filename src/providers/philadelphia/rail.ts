import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";
import { resolveSeptaRailRouteAliases, resolveSeptaRailRouteId, resolveSeptaRailStopName } from "./stops_lookup.ts";
import { logger } from "../../logger.ts";
import { fillSeptaScheduledArrivals } from "./schedule_fill.ts";

const SEPTA_ARRIVALS_URL = process.env.SEPTA_LIVE_RAIL_URL ?? "https://www3.septa.org/api/Arrivals/index.php";
const CACHE_TTL_SECONDS = 20;
const ARRIVALS_RESULTS_LIMIT = 30;
const SEPTA_DEBUG_FETCH = process.env.SEPTA_DEBUG_FETCH === "1";

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

const localDateParts = (timezone: string, nowMs: number) => {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(nowMs));
    const year = Number(parts.find((p) => p.type === "year")?.value ?? "0");
    const month = Number(parts.find((p) => p.type === "month")?.value ?? "0");
    const day = Number(parts.find((p) => p.type === "day")?.value ?? "0");
    return { year, month, day };
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
        const now = localDateParts("America/New_York", nowMs);
        let candidateMs = Date.parse(
            parseLocalTimeToIso(
                "America/New_York",
                now.year,
                now.month,
                now.day,
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

const parseStatusToArrivalIso = (statusRaw?: string | null, nowMs = Date.now()) => {
    if (!statusRaw) return null;
    const status = statusRaw.trim().toUpperCase();
    if (!status) return null;
    if (status === "DUE" || status === "ARR" || status === "ARRIVING") {
        return new Date(nowMs).toISOString();
    }
    const minsMatch = status.match(/(\d+)\s*MIN/);
    if (minsMatch?.[1]) {
        const mins = Number(minsMatch[1]);
        if (Number.isFinite(mins) && mins >= 0) {
            return new Date(nowMs + mins * 60_000).toISOString();
        }
    }
    return null;
};

const pickArrivals = (arr: SeptaArrival[] = [], direction?: "N" | "S", nowMs = Date.now()) =>
    arr
        .filter((a) => (direction ? a.direction === direction : true))
        .map((a) => {
            const arrivalIso =
                parseStatusToArrivalIso(a.status, nowMs) ??
                parseTimeToIso(a.depart_time ?? a.sched_time, nowMs);
            const scheduledIso = parseTimeToIso(a.sched_time, nowMs);
            const arrivalTs = arrivalIso ? Date.parse(arrivalIso) : NaN;
            const scheduledTs = scheduledIso ? Date.parse(scheduledIso) : NaN;
            const delaySeconds =
                Number.isFinite(arrivalTs) && Number.isFinite(scheduledTs)
                    ? Math.round((arrivalTs - scheduledTs) / 1000)
                    : null;
            const destination = cleanDirectionLabel(a.destination) || cleanDirectionLabel(a.next_station) || undefined;
            const status = (a.status ?? "").trim() || undefined;
            const line = resolveSeptaRailRouteId(a.line ?? "") || normalizeLine(a.line);
            return {
                arrivalTime: arrivalIso,
                scheduledTime: scheduledIso ?? null,
                delaySeconds,
                destination,
                status,
                direction: a.direction,
                line,
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

const compactArrival = (a: SeptaArrival) => ({
    line: normalizeLine(a.line),
    direction: a.direction,
    destination: cleanDirectionLabel(a.destination) || cleanDirectionLabel(a.next_station) || "",
    depart_time: a.depart_time ?? "",
    sched_time: a.sched_time ?? "",
    status: (a.status ?? "").trim(),
});

const fetchSeptaRailArrivals = async (key: string, ctx: FetchContext): Promise<FetchResult> => {
    const { params } = parseKeySegments(key);
    const stationRaw = params.stop || params.station || "";
    if (!stationRaw.trim()) throw new Error("SEPTA station is required (use stop=<station name>)");
    const station = resolveSeptaRailStopName(stationRaw) ?? stationRaw;
    const direction = params.direction?.toUpperCase() === "S" ? "S" : params.direction?.toUpperCase() === "N" ? "N" : undefined;
    const requestedLineRaw = normalizeLine(params.line);
    const requestedLineId = resolveSeptaRailRouteId(requestedLineRaw);
    const requestedLineAliases = resolveSeptaRailRouteAliases(requestedLineRaw);
    const matchesRequestedLine = (line?: string | null) => {
        const value = normalizeLineForMatch(line);
        if (!value || requestedLineAliases.length === 0) return true;
        const valueId = resolveSeptaRailRouteId(value);
        if (requestedLineId && valueId && valueId === requestedLineId) return true;
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

    const url = `${SEPTA_ARRIVALS_URL}?${search.toString()}`;
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
    if (SEPTA_DEBUG_FETCH) {
        logger.debug({
            url,
            stationRaw,
            stationQuery: station,
            stationKey: stationKey ?? "",
            direction: direction ?? "",
            requestedLine: requestedLineRaw || "",
            requestedLineId: requestedLineId || "",
            requestedAliases: requestedLineAliases,
            rawNorth: northRaw.length,
            rawSouth: southRaw.length,
            filteredNorth: north.length,
            filteredSouth: south.length,
            sampleNorth: northRaw.slice(0, 5).map(compactArrival),
            sampleSouth: southRaw.slice(0, 5).map(compactArrival),
        }, "SEPTA rail fetch");
    }

    let arrivals = direction === "S" ? pickArrivals(south, "S", ctx.now) : direction === "N" ? pickArrivals(north, "N", ctx.now) : pickArrivals([...north, ...south], undefined, ctx.now);

    const first = (direction === "S" ? south : direction === "N" ? north : [...north, ...south])[0];
    const requestedOrResolvedLine =
        requestedLineId ||
        resolveSeptaRailRouteId(first?.line ?? "") ||
        normalizeLine(first?.line) ||
        "";
    if (arrivals.length < 3 && requestedOrResolvedLine) {
        const fallback = await fillSeptaScheduledArrivals({
            mode: "rail",
            routeId: requestedOrResolvedLine,
            stopInput: stationRaw,
            direction,
            nowMs: ctx.now,
            limit: 3 - arrivals.length,
        });
        const seen = new Set(arrivals.map((a) => `${a.arrivalTime}:${a.destination ?? ""}`));
        for (const row of fallback) {
            const key = `${row.arrivalTime}:${row.destination ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            arrivals.push({
                arrivalTime: row.arrivalTime,
                scheduledTime: row.scheduledTime,
                delaySeconds: null,
                destination: row.destination,
                status: "SCHEDULED",
                direction: row.direction === "S" ? "S" : "N",
                line: row.line ?? requestedOrResolvedLine,
            });
            if (arrivals.length >= 3) break;
        }
        arrivals = arrivals.sort((a, b) => Date.parse(a.arrivalTime!) - Date.parse(b.arrivalTime!));
    }

    const directionLabel =
        cleanDirectionLabel(first?.destination) ||
        cleanDirectionLabel(first?.next_station) ||
        stationLabel ||
        cleanDirectionLabel(first?.path);
    if (requestedLineAliases.length > 0 && arrivals.length === 0) {
        const available = [...northRaw, ...southRaw].map((a) => normalizeLine(a.line)).filter((v) => v.length > 0);
        const sample = Array.from(new Set(available)).slice(0, 12);
        logger.warn({
            stationRaw,
            stationQuery: station,
            stationKey: stationKey ?? "",
            requestedLine: requestedLineRaw,
            aliases: requestedLineAliases,
            availableLines: sample,
        }, "SEPTA rail: no arrivals after line filter");
    }

    const destination = cleanDirectionLabel(first?.destination) || cleanDirectionLabel(first?.next_station) || undefined;

    return {
        payload: {
            provider: "septa-rail",
            line: requestedOrResolvedLine || "SEPTA",
            stop: stationLabel,
            stopId: stationRaw,
            stopName: stationLabel,
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
