import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";
import { getProviderCache, setProviderCache } from "../../cache.ts";

type MbtaPrediction = {
    id: string;
    type: "prediction";
    attributes: {
        arrival_time: string | null;
        departure_time: string | null;
        direction_id: number | null;
        schedule_relationship?: string | null;
    };
    relationships: {
        stop?: { data?: { id?: string | null } | null };
        route?: { data?: { id?: string | null } | null };
        trip?: { data?: { id?: string | null } | null };
    };
};

type MbtaIncluded =
    | {
          type: "stop";
          id: string;
          attributes?: {
              name?: string;
          };
      }
    | {
          type: "route";
          id: string;
          attributes?: {
              short_name?: string | null;
              long_name?: string | null;
              direction_names?: string[] | null;
              direction_destinations?: string[] | null;
          };
      }
    | {
          type: "trip";
          id: string;
          attributes?: {
              headsign?: string | null;
          };
      };

type IncludedByType<T extends MbtaIncluded["type"]> = Extract<MbtaIncluded, { type: T }>;

type MbtaResponse = {
    data?: MbtaPrediction[] | null;
    included?: MbtaIncluded[] | null;
    errors?: Array<{ detail?: string }>;
};

const MBTA_BASE_URL = "https://api-v3.mbta.com";
const CACHE_TTL_SECONDS = 20;

const inflightRouteFetch = new Map<string, Promise<{ predictions: MbtaPrediction[]; included: MbtaIncluded[] }>>();

const routeCacheKey = (key: string) => `mbta:route:${key}`;

type ArrivalItem = {
    arrivalTime: string;
    scheduledTime: string | null;
    delaySeconds: number | null;
    directionId: number | null | undefined;
    route?: IncludedByType<"route">;
    trip?: IncludedByType<"trip">;
};

const pickIncluded = <T extends MbtaIncluded["type"]>(
    included: MbtaIncluded[] | undefined | null,
    type: T,
    id?: string | null
): IncludedByType<T> | undefined =>
    included?.find((item) => item.type === type && (!id || item.id === id)) as IncludedByType<T> | undefined;

const normalizeArrivalTime = (prediction: MbtaPrediction) => {
    const arrival = prediction.attributes.arrival_time;
    const departure = prediction.attributes.departure_time;
    const ts = arrival ?? departure;
    if (!ts) return null;
    const parsed = Date.parse(ts);
    if (!Number.isFinite(parsed)) return null;
    return new Date(parsed).toISOString();
};

const normalizeDirection = (directionId: number | null | undefined, fallback?: string) => {
    if (directionId === 0 || directionId === 1) return directionId.toString();
    if (fallback && fallback.trim()) return fallback.trim();
    return undefined;
};

const pickUpcomingArrivals = (
    arrivals: ArrivalItem[],
    nowMs: number
) => {
    const graceMs = 15_000;
    return arrivals
        .filter((item) => {
            const ts = Date.parse(item.arrivalTime);
            return Number.isFinite(ts) && ts >= nowMs - graceMs;
        })
        .sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime));
};

const buildDirectionLabel = (opts: {
    directionId?: number | null;
    route?: MbtaIncluded & { type: "route" };
    trip?: MbtaIncluded & { type: "trip" };
}) => {
    const { directionId, route, trip } = opts;
    if (trip?.attributes?.headsign) return trip.attributes.headsign;
    if ((directionId === 0 || directionId === 1) && route?.attributes?.direction_destinations) {
        const label = route.attributes.direction_destinations[directionId];
        if (label) return label;
    }
    if (directionId === 0) return "Outbound";
    if (directionId === 1) return "Inbound";
    return undefined;
};

const fetchMbtaArrivals = async (key: string, ctx: FetchContext): Promise<FetchResult> => {
    const { params } = parseKeySegments(key);
    const stop = params.stop?.trim();
    if (!stop) throw new Error("MBTA stop is required (use stop=<stopId>)");

    const line = params.line?.trim();
    if (!line) throw new Error("MBTA line/route is required (use line=<routeId>)");
    const directionRaw = params.direction?.trim();
    const directionId = /^\d$/.test(directionRaw ?? "") ? Number(directionRaw) : undefined;

    const apiKey = process.env.MBTA_API_KEY;
    if (!apiKey) {
        throw new Error("MBTA API key is required (set MBTA_API_KEY)");
    }

    const fetchJson = async (url: string): Promise<MbtaResponse> => {
        const res = await fetch(url, {
            headers: {
                "x-api-key": apiKey,
            },
        });

        if (!res.ok) {
            throw new Error(`MBTA error ${res.status} ${res.statusText}`);
        }

        const json = (await res.json()) as MbtaResponse;
        if (json.errors?.length) {
            const first = json.errors[0]?.detail ?? "Unknown MBTA error";
            throw new Error(first);
        }
        return json;
    };

    const buildUrl = (opts: { line: string; directionId?: number | null }) => {
        const search = new URLSearchParams({
            "page[limit]": "200",
            include: "stop,route,trip",
            sort: "arrival_time",
        });
        search.set("filter[route]", opts.line);
        if (opts.directionId === 0 || opts.directionId === 1) search.set("filter[direction_id]", opts.directionId.toString());
        return `${MBTA_BASE_URL}/predictions?${search.toString()}`;
    };

    const buildUrlWithStop = (opts: { line: string; stop: string; directionId?: number | null }) => {
        const search = new URLSearchParams({
            "page[limit]": "50",
            include: "stop,route,trip",
            sort: "arrival_time",
        });
        search.set("filter[route]", opts.line);
        search.set("filter[stop]", opts.stop);
        if (opts.directionId === 0 || opts.directionId === 1) search.set("filter[direction_id]", opts.directionId.toString());
        return `${MBTA_BASE_URL}/predictions?${search.toString()}`;
    };

    const fetchPredictions = async (url: string) => {
        const json = await fetchJson(url);
        return {
            predictions: (json.data ?? []).filter((p): p is MbtaPrediction => !!p && p.type === "prediction"),
            included: json.included ?? [],
        };
    };

    const cacheKey = `${line}|${directionId ?? "any"}`;

    const getRouteBundle = async (): Promise<{ predictions: MbtaPrediction[]; included: MbtaIncluded[] }> => {
        const cached = await getProviderCache<{ predictions: MbtaPrediction[]; included: MbtaIncluded[] }>(routeCacheKey(cacheKey));
        if (cached) return cached;

        const existing = inflightRouteFetch.get(cacheKey);
        if (existing) return existing;

        const work = fetchPredictions(buildUrl({ line, directionId })).then(async (bundle) => {
            await setProviderCache(routeCacheKey(cacheKey), bundle, CACHE_TTL_SECONDS);
            inflightRouteFetch.delete(cacheKey);
            return bundle;
        });
        inflightRouteFetch.set(cacheKey, work);
        return work;
    };

    const bundle = await getRouteBundle();
    let { predictions, included } = bundle;

    let arrivals: ArrivalItem[] = predictions
        .filter((p) => {
            if (!stop) return true;
            const stopId = p.relationships.stop?.data?.id;
            return stopId === stop;
        })
        .map((p): ArrivalItem | null => {
            const arrivalIso = normalizeArrivalTime(p);
            if (!arrivalIso) return null;
            const trip = p.relationships.trip?.data?.id ? pickIncluded(included, "trip", p.relationships.trip.data.id) : undefined;
            const route = p.relationships.route?.data?.id ? pickIncluded(included, "route", p.relationships.route.data.id) : undefined;
            return {
                arrivalTime: arrivalIso,
                scheduledTime: null,
                delaySeconds: null,
                directionId: p.attributes.direction_id,
                route,
                trip,
            };
        })
        .filter((item): item is ArrivalItem => !!item)
        .sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime));

    arrivals = pickUpcomingArrivals(arrivals, ctx.now);

    const firstPrediction = arrivals[0];
    const resolvedStopId = predictions[0]?.relationships.stop?.data?.id ?? stop;

    const stopIncluded =
        pickIncluded(included, "stop", predictions[0]?.relationships.stop?.data?.id ?? undefined) ??
        pickIncluded(included, "stop", stop) ??
        (resolvedStopId ? pickIncluded(included, "stop", resolvedStopId) : undefined);

    const routeIncluded =
        pickIncluded(included, "route", predictions[0]?.relationships.route?.data?.id ?? undefined) ??
        pickIncluded(included, "route", line) ??
        (firstPrediction?.route?.id ? pickIncluded(included, "route", firstPrediction.route.id) : undefined);

    const tripIncluded = firstPrediction?.trip;

    const resolvedLine =
        routeIncluded?.id?.trim() ||
        routeIncluded?.attributes?.short_name?.trim() ||
        routeIncluded?.attributes?.long_name?.trim() ||
        line;

    const resolvedDirectionId = firstPrediction?.directionId ?? directionId;
    const directionLabel = buildDirectionLabel({
        directionId: resolvedDirectionId ?? undefined,
        route: routeIncluded,
        trip: tripIncluded,
    });

    // If still empty for this stop, fall back to a stop-specific fetch once.
    if (!arrivals.length) {
        const stopBundle = await fetchPredictions(buildUrlWithStop({ line, stop, directionId }));
        const { predictions: stopPreds, included: stopIncluded } = stopBundle;
        const stopArrivals: ArrivalItem[] = stopPreds
            .map((p): ArrivalItem | null => {
                const arrivalIso = normalizeArrivalTime(p);
                if (!arrivalIso) return null;
                const trip = p.relationships.trip?.data?.id
                    ? pickIncluded(stopIncluded, "trip", p.relationships.trip.data.id)
                    : undefined;
                const route = p.relationships.route?.data?.id
                    ? pickIncluded(stopIncluded, "route", p.relationships.route.data.id)
                    : undefined;
                return {
                    arrivalTime: arrivalIso,
                    scheduledTime: null,
                    delaySeconds: null,
                    directionId: p.attributes.direction_id,
                    route,
                    trip,
                };
            })
            .filter((item): item is ArrivalItem => !!item)
            .sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime));

        const filteredStopArrivals = pickUpcomingArrivals(stopArrivals, ctx.now);
        if (filteredStopArrivals.length) {
            arrivals = filteredStopArrivals;
            // refresh metadata from this bundle
            const first = arrivals[0];
            const stopInc =
                pickIncluded(stopIncluded, "stop", stopPreds[0]?.relationships.stop?.data?.id ?? undefined) ??
                pickIncluded(stopIncluded, "stop", stop);
            const routeInc =
                pickIncluded(stopIncluded, "route", stopPreds[0]?.relationships.route?.data?.id ?? undefined) ??
                pickIncluded(stopIncluded, "route", line);
            stopIncluded && (included = stopIncluded);
            firstPrediction && (firstPrediction.route = routeInc);
        }
    }

    return {
        payload: {
            provider: "mbta",
            line: resolvedLine,
            stop: stopIncluded?.attributes?.name || resolvedStopId || stop,
            stopId: resolvedStopId || stop,
            stopName: stopIncluded?.attributes?.name ?? stopIncluded?.id,
            direction: normalizeDirection(resolvedDirectionId, directionRaw),
            directionLabel: directionLabel ?? undefined,
            arrivals: arrivals.map((item) => ({
                arrivalTime: item.arrivalTime,
                scheduledTime: item.scheduledTime,
                delaySeconds: item.delaySeconds,
            })),
            fetchedAt: new Date(ctx.now).toISOString(),
        },
        ttlSeconds: CACHE_TTL_SECONDS,
    };
};

export const mbtaProvider: ProviderPlugin = {
    providerId: "mbta",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("mbta", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchMbtaArrivals(key, ctx),
};

registerProvider(mbtaProvider);
