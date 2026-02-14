import { transit_realtime } from "gtfs-realtime-bindings";
import { Buffer } from "buffer";
import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";
import { readFileSync } from "node:fs";

const TRIP_FEED_URL = "https://www3.septa.org/gtfsrt/septa-pa-us/Trip/rtTripUpdates.pb";
const FEED_TTL_MS = 15_000;
const CACHE_TTL_SECONDS = 20;

const feedCache: { feed: transit_realtime.FeedMessage; expiresAt: number } = { feed: undefined as any, expiresAt: 0 };
let inflight: Promise<transit_realtime.FeedMessage> | null = null;

const loadStopNames = (() => {
    let map: Map<string, string> | null = null;
    return () => {
        if (map) return map;
        map = new Map<string, string>();
        try {
            const csv = readFileSync("data/septa/bus/stops.txt", "utf8").split(/\r?\n/);
            const header = csv.shift()?.split(",") ?? [];
            const idIdx = header.indexOf("stop_id");
            const nameIdx = header.indexOf("stop_name");
            for (const line of csv) {
                if (!line) continue;
                const cols = line.split(",");
                const id = cols[idIdx]?.trim();
                const name = cols[nameIdx]?.trim();
                if (id) map.set(id, name ?? id);
            }
        } catch {
            // ignore
        }
        return map;
    };
})();

const fetchFeed = async (now: number) => {
    if (feedCache.feed && feedCache.expiresAt > now) return feedCache.feed;
    if (inflight) return inflight;
    inflight = (async () => {
        const res = await fetch(TRIP_FEED_URL);
        if (!res.ok) throw new Error(`SEPTA trip feed error ${res.status} ${res.statusText}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const feed = transit_realtime.FeedMessage.decode(buffer);
        feedCache.feed = feed;
        feedCache.expiresAt = now + FEED_TTL_MS;
        inflight = null;
        return feed;
    })().catch((err) => {
        inflight = null;
        throw err;
    });
    return inflight;
};

const pickArrivals = (
    feed: transit_realtime.FeedMessage,
    filters: { route?: string; stop?: string; direction?: string },
    nowMs: number
) => {
    const arrivals: Array<{ arrivalTime: string; scheduledTime: string | null; delaySeconds: number | null }> = [];
    const route = filters.route?.trim();
    const stop = filters.stop?.trim();
    const direction = filters.direction?.trim();

    for (const entity of feed.entity) {
        const tu = entity.tripUpdate;
        if (!tu) continue;
        const routeId = tu.trip?.routeId;
        if (route && routeId !== route) continue;
        for (const stu of tu.stopTimeUpdate ?? []) {
            const stopId = stu.stopId ?? "";
            if (stop && stopId !== stop) continue;
            // direction not reliably present; skip unless encoded in stopId suffix (N/S)
            if (direction && !(stopId.endsWith(direction) || tu.trip?.directionId?.toString() === direction)) continue;

            const tsSeconds = stu.arrival?.time ?? stu.departure?.time;
            if (!tsSeconds) continue;
            const delay = stu.arrival?.delay ?? stu.departure?.delay ?? null;
            const arrivalEpochMs = Number(tsSeconds) * 1000;
            if (!Number.isFinite(arrivalEpochMs)) continue;

            const scheduledEpochMs = delay !== null ? arrivalEpochMs - delay * 1000 : null;
            arrivals.push({
                arrivalTime: new Date(arrivalEpochMs).toISOString(),
                scheduledTime: scheduledEpochMs ? new Date(scheduledEpochMs).toISOString() : null,
                delaySeconds: delay,
            });
            if (arrivals.length >= 20) break;
        }
        if (arrivals.length >= 20) break;
    }

    const graceMs = 15_000;
    const seen = new Set<string>();
    return arrivals
        .filter((a) => {
            const ts = Date.parse(a.arrivalTime);
            return Number.isFinite(ts) && ts >= nowMs - graceMs;
        })
        .filter((a) => {
            if (seen.has(a.arrivalTime)) return false;
            seen.add(a.arrivalTime);
            return true;
        })
        .sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime));
};

const fetchSeptaBusArrivals = async (key: string, ctx: FetchContext): Promise<FetchResult> => {
    const { params } = parseKeySegments(key);
    const route = params.line;
    const stop = params.stop;
    const direction = params.direction;
    if (!route) throw new Error("SEPTA bus route is required (line=<routeId>)");
    if (!stop) throw new Error("SEPTA bus stop is required (stop=<stopId>)");

    const feed = await fetchFeed(ctx.now);
    let arrivals = pickArrivals(feed, { route, stop, direction }, ctx.now);
    // Fallback: if nothing matched with the stop filter, retry without stop to avoid over-filtering.
    if (!arrivals.length && stop) {
        arrivals = pickArrivals(feed, { route, stop: undefined, direction }, ctx.now);
    }
    const stopNames = loadStopNames();
    const stopName = stopNames.get(stop);

    return {
        payload: {
            provider: "septa-bus",
            line: route,
            stop: stopName ?? stop,
            stopId: stop,
            direction,
            directionLabel: stopName ?? stop,
            arrivals,
            fetchedAt: new Date(ctx.now).toISOString(),
        },
        ttlSeconds: CACHE_TTL_SECONDS,
    };
};

export const septaBusProvider: ProviderPlugin = {
    providerId: "septa-bus",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("septa-bus", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchSeptaBusArrivals(key, ctx),
};

registerProvider(septaBusProvider);
