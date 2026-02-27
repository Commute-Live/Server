import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";
import { getProviderCache, setProviderCache } from "../../cache.ts";

const CTA_BUS_BASE_URL = "https://www.ctabustracker.com/bustime/api/v2/getpredictions";

type CtaBusPrediction = {
    stpid?: string;
    stpnm?: string;
    rt?: string;
    rtdir?: string;
    des?: string;
    prdtm?: string;
    tmstmp?: string;
    dly?: string;
};

type CtaBusResponse = {
    "bustime-response"?: {
        prd?: CtaBusPrediction[] | CtaBusPrediction;
        error?: Array<{ msg?: string }>;
    };
};

const STOP_CACHE_TTL_S = 20;
const inflightStopFetch = new Map<string, Promise<{ predictions: CtaBusPrediction[] }>>();
const stopCacheKey = (stop: string) => `cta-bus:stop:${stop}`;

const normalizeText = (value?: string | null) => {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeRoute = (raw?: string) => {
    const value = normalizeText(raw);
    return value ? value.toUpperCase() : undefined;
};

const normalizeDirection = (raw?: string) => normalizeText(raw)?.toUpperCase();

const directionKey = (value?: string) => {
    const text = normalizeDirection(value);
    if (!text) return undefined;
    if (text === "N" || text === "NB" || text === "NORTH" || text === "NORTHBOUND") return "N";
    if (text === "S" || text === "SB" || text === "SOUTH" || text === "SOUTHBOUND") return "S";
    if (text === "E" || text === "EB" || text === "EAST" || text === "EASTBOUND") return "E";
    if (text === "W" || text === "WB" || text === "WEST" || text === "WESTBOUND") return "W";
    return text;
};

const matchesDirection = (query?: string, candidate?: string) => {
    const q = directionKey(query);
    if (!q) return true;
    const c = directionKey(candidate);
    return c === q;
};

const detectOffsetMinutesForChicago = (utcLikeMs: number) => {
    const probe = new Date(utcLikeMs);
    const utcWall = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
    const chicagoWall = new Date(probe.toLocaleString("en-US", { timeZone: "America/Chicago" }));
    return Math.round((utcWall.getTime() - chicagoWall.getTime()) / 60000);
};

const parseChicagoLocalToIso = (year: number, month: number, day: number, hour: number, minute: number, second: number) => {
    const asUtcLike = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetMinutes = detectOffsetMinutesForChicago(asUtcLike);
    return new Date(asUtcLike + offsetMinutes * 60_000).toISOString();
};

const parseCtaBusTimestamp = (raw?: string | null) => {
    const value = normalizeText(raw);
    if (!value) return null;

    let match = value.match(/^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2})$/);
    if (match) {
        const [, y, m, d, hh, mm] = match;
        return parseChicagoLocalToIso(Number(y), Number(m), Number(d), Number(hh), Number(mm), 0);
    }

    match = value.match(/^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (match) {
        const [, y, m, d, hh, mm, ss] = match;
        return parseChicagoLocalToIso(Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss));
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return null;
};

const normalizePredictions = (raw?: CtaBusPrediction[] | CtaBusPrediction): CtaBusPrediction[] => {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "object") return [raw];
    return [];
};

const fetchStopPredictions = async (stop: string, apiKey: string) => {
    const cached = await getProviderCache<{ predictions: CtaBusPrediction[] }>(stopCacheKey(stop));
    if (cached) return cached;

    const existing = inflightStopFetch.get(stop);
    if (existing) return existing;

    const work = (async () => {
        const search = new URLSearchParams({
            key: apiKey,
            format: "json",
            stpid: stop,
            top: "20",
        });
        const url = `${CTA_BUS_BASE_URL}?${search.toString()}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`CTA Bus Tracker error ${res.status} ${res.statusText}`);
        }

        const json = (await res.json()) as CtaBusResponse;
        const body = json["bustime-response"];
        const errors = body?.error ?? [];
        if (errors.length > 0) {
            const message = normalizeText(errors[0]?.msg) ?? "Unknown CTA bus error";
            throw new Error(message);
        }

        const bundle = { predictions: normalizePredictions(body?.prd) };
        await setProviderCache(stopCacheKey(stop), bundle, STOP_CACHE_TTL_S);
        inflightStopFetch.delete(stop);
        return bundle;
    })().catch((err) => {
        inflightStopFetch.delete(stop);
        throw err;
    });

    inflightStopFetch.set(stop, work);
    return work;
};

const fetchCtaBusArrivals = async (key: string, ctx: FetchContext): Promise<FetchResult> => {
    const { params } = parseKeySegments(key);
    const apiKey = process.env.CTA_BUS_API_KEY;
    if (!apiKey) {
        throw new Error("CTA Bus Tracker API key is required (set CTA_BUS_API_KEY)");
    }

    const stop = normalizeText(params.stop);
    if (!stop) {
        throw new Error("CTA bus stop is required (use stop=stpid)");
    }

    const line = normalizeRoute(params.line);
    const direction = normalizeDirection(params.direction);

    const bundle = await fetchStopPredictions(stop, apiKey);

    const filtered = bundle.predictions.filter((prediction) => {
        const routeOk = line ? normalizeRoute(prediction.rt) === line : true;
        const directionOk = matchesDirection(direction, prediction.rtdir);
        return routeOk && directionOk;
    });

    const arrivals = filtered
        .map((prediction) => {
            const arrivalTime = parseCtaBusTimestamp(prediction.prdtm);
            if (!arrivalTime) return null;
            return {
                arrivalTime,
                scheduledTime: null,
                delaySeconds: null,
                destination: normalizeText(prediction.des),
            };
        })
        .filter((item) => !!item)
        .sort((a, b) => Date.parse(a!.arrivalTime) - Date.parse(b!.arrivalTime));

    const primary = filtered[0] ?? bundle.predictions[0];
    const stopName = normalizeText(primary?.stpnm) ?? stop;
    const resolvedDirection = directionKey(direction) ?? directionKey(primary?.rtdir);
    const destination = normalizeText(primary?.des);

    return {
        payload: {
            provider: "cta-bus",
            line: line ?? normalizeRoute(primary?.rt) ?? params.line,
            stop: stopName,
            stopId: stop,
            stopName,
            direction: resolvedDirection,
            directionLabel: destination ?? resolvedDirection,
            destination,
            arrivals,
            fetchedAt: new Date(ctx.now).toISOString(),
        },
        ttlSeconds: STOP_CACHE_TTL_S,
    };
};

export const ctaBusProvider: ProviderPlugin = {
    providerId: "cta-bus",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("cta-bus", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchCtaBusArrivals(key, ctx),
};

registerProvider(ctaBusProvider);
