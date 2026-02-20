import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";

const CTA_BASE_URL = "https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx";
const CTA_STATION_NAME_BY_ID: Record<string, string> = {
    "40380": "Clark/Lake",
    "41400": "Roosevelt",
    "40900": "Howard",
    "40890": "O'Hare",
    "40450": "95th/Dan Ryan",
};

type CtaEta = {
    staId?: string;
    stpId?: string;
    staNm?: string;
    stpDe?: string;
    rt?: string;
    trDr?: string;
    destNm?: string;
    prdt?: string;
    arrT?: string;
    isSch?: string;
    isDly?: string;
};

type CtaResponse = {
    ctatt?: {
        errCd?: string | number;
        errNm?: string | null;
        eta?: CtaEta[] | CtaEta | null;
    };
};

const ROUTE_ALIASES: Record<string, string> = {
    RED: "Red",
    BLUE: "Blue",
    BRN: "Brn",
    BROWN: "Brn",
    G: "G",
    GREEN: "G",
    ORG: "Org",
    ORANGE: "Org",
    P: "P",
    PURPLE: "P",
    PINK: "Pink",
    Y: "Y",
    YELLOW: "Y",
};

const normalizeRoute = (raw?: string) => {
    if (!raw) return undefined;
    const key = raw.trim().toUpperCase();
    if (!key) return undefined;
    return ROUTE_ALIASES[key] ?? raw.trim();
};

const normalizeDirection = (raw?: string) => {
    if (!raw) return undefined;
    const value = raw.trim().toUpperCase();
    if (!value) return undefined;
    if (value === "N" || value === "1") return "1";
    if (value === "S" || value === "5") return "5";
    return undefined;
};

const STOP_CACHE_TTL_MS = 20_000;
const stopCache = new Map<string, { expiresAt: number; etas: CtaEta[] }>();
const inflightStopFetch = new Map<string, Promise<{ etas: CtaEta[] }>>();

const getStopBundle = async (opts: { stop: string; apiKey: string }) => {
    const { stop, apiKey } = opts;
    const now = Date.now();

    const cached = stopCache.get(stop);
    if (cached && cached.expiresAt > now) return cached;

    const existing = inflightStopFetch.get(stop);
    if (existing) return existing;

    const work = (async () => {
        const search = new URLSearchParams({
            key: apiKey,
            outputType: "JSON",
            max: "20",
        });

        // CTA uses mapid (4xxxx station parent) or stpid (3xxxx platform stop).
        if (/^\d{5}$/.test(stop) && stop.startsWith("3")) {
            search.set("stpid", stop);
        } else {
            search.set("mapid", stop);
        }

        const url = `${CTA_BASE_URL}?${search.toString()}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`CTA Train Tracker error ${res.status} ${res.statusText}`);
        }

        const json = (await res.json()) as CtaResponse;
        const body = json?.ctatt;
        const errCd = Number(body?.errCd ?? 900);
        const errNm = body?.errNm ?? "Unknown CTA error";
        if (!Number.isFinite(errCd) || errCd !== 0) {
            throw new Error(`CTA error ${errCd}: ${errNm}`);
        }

        const bundle = {
            etas: normalizeEtas(body?.eta),
            expiresAt: now + STOP_CACHE_TTL_MS,
        };
        stopCache.set(stop, bundle);
        inflightStopFetch.delete(stop);
        return bundle;
    })().catch((err) => {
        inflightStopFetch.delete(stop);
        throw err;
    });

    inflightStopFetch.set(stop, work);
    return work;
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

const parseCtaTimestamp = (raw?: string | null) => {
    if (!raw) return null;
    const value = raw.trim();
    if (!value) return null;

    // Already timezone-aware (Z or +hh:mm/-hh:mm)
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }

    // CTA JSON often returns "yyyy-MM-ddTHH:mm:ss" without timezone.
    let match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
    if (match) {
        const [, y, m, d, hh, mm, ss] = match;
        return parseChicagoLocalToIso(Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss));
    }

    // CTA docs also use "yyyyMMdd HH:mm:ss".
    match = value.match(/^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (match) {
        const [, y, m, d, hh, mm, ss] = match;
        return parseChicagoLocalToIso(Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss));
    }

    const parsedFallback = Date.parse(value);
    if (Number.isFinite(parsedFallback)) return new Date(parsedFallback).toISOString();
    return null;
};

const normalizeEtas = (etaRaw?: CtaEta[] | CtaEta | null): CtaEta[] => {
    if (!etaRaw) return [];
    if (Array.isArray(etaRaw)) return etaRaw;
    if (typeof etaRaw === "object") return [etaRaw];
    return [];
};

const fetchCtaArrivals = async (key: string, ctx: FetchContext): Promise<FetchResult> => {
    const { params } = parseKeySegments(key);
    const apiKey = process.env.CTA_TRAIN_API_KEY;
    if (!apiKey) {
        throw new Error("CTA Train Tracker API key is required (set CTA_TRAIN_API_KEY)");
    }

    const stop = params.stop?.trim();
    if (!stop) {
        throw new Error("CTA station/stop is required (use stop=mapid|stpid)");
    }

    const line = normalizeRoute(params.line);
    const direction = normalizeDirection(params.direction);

    const bundle = await getStopBundle({ stop, apiKey });

    const filteredEtas = bundle.etas.filter((eta) => {
        const routeOk = line ? normalizeRoute(eta.rt) === line : true;
        const dirOk = direction ? eta.trDr === direction : true;
        return routeOk && dirOk;
    });

    const etaItems = filteredEtas
        .map((eta) => {
            const arrivalIso = parseCtaTimestamp(eta.arrT);
            const predictionIso = parseCtaTimestamp(eta.prdt);
            if (!arrivalIso) return null;

            let delaySeconds: number | null = null;
            if (predictionIso && eta.isDly === "1") {
                const delta = Date.parse(arrivalIso) - Date.parse(predictionIso);
                if (Number.isFinite(delta)) delaySeconds = Math.max(0, Math.round(delta / 1000));
            }

            return {
                arrivalTime: arrivalIso,
                scheduledTime: eta.isSch === "1" ? arrivalIso : null,
                delaySeconds,
            };
        })
        .filter((item): item is { arrivalTime: string; scheduledTime: string | null; delaySeconds: number | null } => !!item)
        .sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime));

    const primary = filteredEtas[0] ?? bundle.etas[0];
    const resolvedStopName = primary?.staNm ?? CTA_STATION_NAME_BY_ID[stop] ?? stop;
    const resolvedDirectionLabel = primary?.destNm ?? resolvedStopName;
    const resolvedDirection = params.direction || primary?.trDr || undefined;

    return {
        payload: {
            provider: "cta-subway",
            line: line ?? primary?.rt ?? params.line,
            stop: resolvedStopName,
            stopId: stop,
            stopName: resolvedStopName,
            direction: resolvedDirection,
            directionLabel: resolvedDirectionLabel,
            arrivals: etaItems,
            fetchedAt: new Date(ctx.now).toISOString(),
        },
        ttlSeconds: 20,
    };
};

export const ctaSubwayProvider: ProviderPlugin = {
    providerId: "cta-subway",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("cta-subway", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchCtaArrivals(key, ctx),
};

registerProvider(ctaSubwayProvider);
