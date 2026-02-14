import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";

const CTA_BASE_URL = "https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx";

type CtaEta = {
    staId?: string;
    stpId?: string;
    staNm?: string;
    stpDe?: string;
    rt?: string;
    trDr?: string;
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

const parseCtaTimestamp = (raw?: string | null) => {
    if (!raw) return null;
    const value = raw.trim();
    if (!value) return null;

    // Supports both "yyyyMMdd HH:mm:ss" and ISO-like strings from outputType=JSON.
    const match = value.match(/^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (match) {
        const [, y, m, d, hh, mm, ss] = match;
        const parsed = Date.parse(`${y}-${m}-${d}T${hh}:${mm}:${ss}-06:00`);
        if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
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

    const search = new URLSearchParams({
        key: apiKey,
        outputType: "JSON",
    });

    // CTA uses mapid (4xxxx station parent) or stpid (3xxxx platform stop).
    if (/^\d{5}$/.test(stop) && stop.startsWith("3")) {
        search.set("stpid", stop);
    } else {
        search.set("mapid", stop);
    }

    if (line) search.set("rt", line);
    search.set("max", "10");

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

    const etaItems = normalizeEtas(body?.eta)
        .filter((eta) => (direction ? eta.trDr === direction : true))
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

    const primary = normalizeEtas(body?.eta)[0];

    return {
        payload: {
            provider: "cta-subway",
            line: line ?? primary?.rt ?? params.line,
            stop,
            stopId: primary?.stpId ?? undefined,
            stopName: primary?.staNm ?? undefined,
            direction: params.direction,
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
