import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { getProviderCache, setProviderCache } from "../../cache.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";

const OPEN511_BASE_URL = process.env.OPEN511_BASE_URL ?? "https://api.511.org/transit";
const CACHE_TTL_SECONDS = 20;

const inflightStopFetch = new Map<string, Promise<StopMonitoringBundle>>();

type StopMonitoringBundle = {
    operatorId: string;
    stopId: string;
    responseTimestamp: string | null;
    visits: unknown[];
};

type NormalizedArrival = {
    arrivalTime: string;
    scheduledTime: string | null;
    delaySeconds: number | null;
    destination?: string;
};

const normalizeText = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const asArray = <T>(value: unknown): T[] => {
    if (Array.isArray(value)) return value as T[];
    if (value && typeof value === "object") return [value as T];
    return [];
};

const parseJsonWithBom = async (res: Response): Promise<unknown> => {
    const text = await res.text();
    const normalized = text.replace(/^\uFEFF/, "");
    try {
        return JSON.parse(normalized);
    } catch {
        throw new Error(`Open511 returned non-JSON response: ${normalized.slice(0, 160)}`);
    }
};

const normalizeDirectionKey = (value: unknown): string | undefined => {
    const text = normalizeText(value)?.toUpperCase();
    if (!text) return undefined;

    if (text === "0" || text === "OB" || text === "OUTBOUND") return "OUTBOUND";
    if (text === "1" || text === "IB" || text === "INBOUND") return "INBOUND";

    if (text === "N" || text === "NB" || text === "NORTH" || text === "NORTHBOUND") return "N";
    if (text === "S" || text === "SB" || text === "SOUTH" || text === "SOUTHBOUND") return "S";
    if (text === "E" || text === "EB" || text === "EAST" || text === "EASTBOUND") return "E";
    if (text === "W" || text === "WB" || text === "WEST" || text === "WESTBOUND") return "W";

    return text;
};

const normalizeLine = (value: unknown): string | undefined => normalizeText(value)?.toUpperCase().replace(/\s+/g, " ");

const parseIsoTime = (value: unknown): string | null => {
    const text = normalizeText(value);
    if (!text) return null;
    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed)) return null;
    return new Date(parsed).toISOString();
};

const getNested = (record: unknown, key: string): unknown => {
    if (!record || typeof record !== "object") return undefined;
    return (record as Record<string, unknown>)[key];
};

const extractMonitoredCall = (journey: unknown): Record<string, unknown> | undefined => {
    const calls = asArray<Record<string, unknown>>(getNested(journey, "MonitoredCall"));
    if (calls.length > 0) return calls[0];
    const single = getNested(journey, "MonitoredCall");
    if (single && typeof single === "object") return single as Record<string, unknown>;
    return undefined;
};

const parseVisits = (json: unknown): { responseTimestamp: string | null; visits: unknown[] } => {
    const serviceDelivery = getNested(json, "ServiceDelivery") ?? getNested(getNested(json, "Siri"), "ServiceDelivery");
    const responseTimestamp = normalizeText(getNested(serviceDelivery, "ResponseTimestamp")) ?? null;
    const delivery = getNested(serviceDelivery, "StopMonitoringDelivery");

    const deliveryEntries = asArray<Record<string, unknown>>(delivery);
    const allVisits: unknown[] = [];

    for (const entry of deliveryEntries) {
        const visits = asArray(getNested(entry, "MonitoredStopVisit"));
        allVisits.push(...visits);
    }

    if (allVisits.length === 0) {
        allVisits.push(...asArray(getNested(delivery, "MonitoredStopVisit")));
    }

    return { responseTimestamp, visits: allVisits };
};

const matchesDirection = (queryDirection: string | undefined, candidateDirection: unknown): boolean => {
    const query = normalizeDirectionKey(queryDirection);
    if (!query) return true;

    const candidate = normalizeDirectionKey(candidateDirection);
    if (!candidate) return false;

    if (query === candidate) return true;

    if (query === "OUTBOUND") return candidate === "OUTBOUND" || candidate === "0";
    if (query === "INBOUND") return candidate === "INBOUND" || candidate === "1";

    return false;
};

const routeMatches = (queryLine: string | undefined, lineRef: unknown, publishedLineName: unknown): boolean => {
    const query = normalizeLine(queryLine);
    if (!query) return true;

    const line = normalizeLine(lineRef);
    const lineName = normalizeLine(publishedLineName);
    return query === line || query === lineName;
};

const extractStopMonitoringBundle = async (
    operatorId: string,
    stopId: string,
    apiKey: string,
): Promise<StopMonitoringBundle> => {
    const cacheKey = `bayarea-511:${operatorId}:${stopId}`;
    const cached = await getProviderCache<StopMonitoringBundle>(cacheKey);
    if (cached) return cached;

    const inflightKey = `${operatorId}|${stopId}`;
    const existing = inflightStopFetch.get(inflightKey);
    if (existing) return existing;

    const work = (async () => {
        const search = new URLSearchParams({
            api_key: apiKey,
            agency: operatorId,
            stopCode: stopId,
            format: "json",
        });

        const url = `${OPEN511_BASE_URL}/StopMonitoring?${search.toString()}`;
        const res = await fetch(url, {
            headers: {
                accept: "application/json",
                "user-agent": "commutelive/1.0",
            },
        });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Open511 StopMonitoring error ${res.status}: ${body.slice(0, 180)}`);
        }

        const json = await parseJsonWithBom(res);
        const parsed = parseVisits(json);

        const bundle: StopMonitoringBundle = {
            operatorId,
            stopId,
            responseTimestamp: parsed.responseTimestamp,
            visits: parsed.visits,
        };

        await setProviderCache(cacheKey, bundle, CACHE_TTL_SECONDS);
        inflightStopFetch.delete(inflightKey);
        return bundle;
    })().catch((err) => {
        inflightStopFetch.delete(inflightKey);
        throw err;
    });

    inflightStopFetch.set(inflightKey, work);
    return work;
};

const normalizeArrivals = (
    bundle: StopMonitoringBundle,
    queryLine: string,
    queryDirection: string | undefined,
): {
    arrivals: NormalizedArrival[];
    line: string;
    stopName: string;
    destination: string | undefined;
    direction: string | undefined;
} => {
    const arrivals: NormalizedArrival[] = [];

    let resolvedLine = normalizeLine(queryLine) ?? queryLine;
    let resolvedStopName = bundle.stopId;
    let resolvedDestination: string | undefined;
    let resolvedDirection: string | undefined;

    for (const visit of bundle.visits) {
        const monitoredJourney = getNested(visit, "MonitoredVehicleJourney");
        const monitoredCall = extractMonitoredCall(monitoredJourney);

        const lineRef = getNested(monitoredJourney, "LineRef");
        const publishedLineName = getNested(monitoredJourney, "PublishedLineName");
        if (!routeMatches(queryLine, lineRef, publishedLineName)) continue;

        const directionRef = getNested(monitoredJourney, "DirectionRef") ?? getNested(monitoredCall, "DirectionRef");
        if (!matchesDirection(queryDirection, directionRef)) continue;

        const arrivalTime =
            parseIsoTime(getNested(monitoredCall, "ExpectedArrivalTime")) ??
            parseIsoTime(getNested(monitoredCall, "AimedArrivalTime")) ??
            parseIsoTime(getNested(monitoredCall, "ExpectedDepartureTime")) ??
            parseIsoTime(getNested(monitoredCall, "AimedDepartureTime"));

        if (!arrivalTime) continue;

        const destination =
            normalizeText(getNested(monitoredCall, "DestinationDisplay")) ??
            normalizeText(getNested(monitoredJourney, "DestinationName"));

        const stopName =
            normalizeText(getNested(monitoredCall, "StopPointName")) ??
            normalizeText(getNested(monitoredJourney, "MonitoredCallStopName")) ??
            bundle.stopId;

        resolvedLine = normalizeLine(lineRef) ?? normalizeLine(publishedLineName) ?? resolvedLine;
        resolvedStopName = stopName;
        resolvedDestination = resolvedDestination ?? destination;
        resolvedDirection = resolvedDirection ?? normalizeDirectionKey(directionRef);

        arrivals.push({
            arrivalTime,
            scheduledTime: null,
            delaySeconds: null,
            destination,
        });
    }

    arrivals.sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime));

    return {
        arrivals,
        line: resolvedLine,
        stopName: resolvedStopName,
        destination: resolvedDestination,
        direction: normalizeDirectionKey(queryDirection) ?? resolvedDirection,
    };
};

const fetchBayAreaArrivals = async (key: string, ctx: FetchContext): Promise<FetchResult> => {
    const { params } = parseKeySegments(key);

    const operatorId = normalizeText(params.operator_id)?.toUpperCase();
    const stopId = normalizeText(params.stop);
    const line = normalizeText(params.line);
    const direction = normalizeText(params.direction);

    if (!operatorId) throw new Error("Open511 operator_id is required (use operator_id=<agency>)");
    if (!stopId) throw new Error("Open511 stop is required (use stop=<stopCode>)");
    if (!line) throw new Error("Open511 line is required (use line=<routeId>)");

    const apiKey = process.env.OPEN511_API_KEY;
    if (!apiKey) {
        throw new Error("Open511 API key is required (set OPEN511_API_KEY)");
    }

    const bundle = await extractStopMonitoringBundle(operatorId, stopId, apiKey);
    const normalized = normalizeArrivals(bundle, line, direction);

    return {
        payload: {
            provider: "bayarea-511",
            operatorId,
            line: normalized.line,
            stop: normalized.stopName,
            stopId,
            stopName: normalized.stopName,
            direction: normalized.direction,
            directionLabel: normalized.destination ?? normalized.direction,
            destination: normalized.destination,
            arrivals: normalized.arrivals,
            fetchedAt: new Date(ctx.now).toISOString(),
            responseTimestamp: bundle.responseTimestamp,
        },
        ttlSeconds: CACHE_TTL_SECONDS,
    };
};

export const bayarea511Provider: ProviderPlugin = {
    providerId: "bayarea-511",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("bayarea-511", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchBayAreaArrivals(key, ctx),
};

registerProvider(bayarea511Provider);
