import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";

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
    const directionRaw = params.direction?.trim();
    const directionId = /^\d$/.test(directionRaw ?? "") ? Number(directionRaw) : undefined;

    const apiKey = process.env.MBTA_API_KEY;
    if (!apiKey) {
        throw new Error("MBTA API key is required (set MBTA_API_KEY)");
    }

    const search = new URLSearchParams({
        "filter[stop]": stop,
        "page[limit]": "10",
        include: "stop,route,trip",
        sort: "arrival_time",
    });
    if (line) search.set("filter[route]", line);
    if (directionId === 0 || directionId === 1) search.set("filter[direction_id]", directionId.toString());

    const url = `${MBTA_BASE_URL}/predictions?${search.toString()}`;
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

    const predictions = (json.data ?? []).filter((p): p is MbtaPrediction => !!p && p.type === "prediction");
    const included = json.included ?? [];

    let arrivals: ArrivalItem[] = predictions
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
    const stopIncluded =
        pickIncluded(included, "stop", predictions[0]?.relationships.stop?.data?.id ?? undefined) ??
        pickIncluded(included, "stop", stop);
    const routeIncluded =
        pickIncluded(included, "route", predictions[0]?.relationships.route?.data?.id ?? undefined) ??
        pickIncluded(included, "route", line);
    const tripIncluded = firstPrediction?.trip;

    const resolvedLine =
        routeIncluded?.attributes?.short_name?.trim() ||
        routeIncluded?.attributes?.long_name?.trim() ||
        routeIncluded?.id ||
        line;

    const resolvedDirectionId = firstPrediction?.directionId ?? directionId;
    const directionLabel = buildDirectionLabel({
        directionId: resolvedDirectionId ?? undefined,
        route: routeIncluded,
        trip: tripIncluded,
    });

    return {
        payload: {
            provider: "mbta",
            line: resolvedLine,
            stop: stopIncluded?.attributes?.name || stop,
            stopId: stop,
            stopName: stopIncluded?.attributes?.name,
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
