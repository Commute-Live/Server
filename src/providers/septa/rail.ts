import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";

const SEPTA_BASE = "https://www3.septa.org/api";
const CACHE_TTL_SECONDS = 20;

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
        const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0));
        return candidate.toISOString();
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

const fetchSeptaRailArrivals = async (key: string, ctx: FetchContext): Promise<FetchResult> => {
    const { params } = parseKeySegments(key);
    const station = params.stop || params.station || "";
    if (!station.trim()) throw new Error("SEPTA station is required (use stop=<station name>)");
    const direction = params.direction?.toUpperCase() === "S" ? "S" : params.direction?.toUpperCase() === "N" ? "N" : undefined;

    const search = new URLSearchParams({
        station: station,
        results: "5",
    });
    if (direction) search.set("direction", direction);

    const url = `${SEPTA_BASE}/Arrivals/index.php?${search.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`SEPTA Arrivals error ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as SeptaArrivalsResponse;
    const stationKey = Object.keys(json)[0];
    const body = stationKey ? json[stationKey]?.[0] : undefined;
    const north = body?.Northbound ?? [];
    const south = body?.Southbound ?? [];

    const arrivals = direction === "S" ? pickArrivals(south, "S", ctx.now) : direction === "N" ? pickArrivals(north, "N", ctx.now) : pickArrivals([...north, ...south], undefined, ctx.now);

    const first = (direction === "S" ? south : direction === "N" ? north : [...north, ...south])[0];

    return {
        payload: {
            provider: "septa-rail",
            line: first?.line ?? params.line ?? "SEPTA",
            stop: stationKey ?? station,
            stopId: station,
            direction: direction ?? first?.direction,
            directionLabel: first?.path ?? first?.destination ?? stationKey ?? station,
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
