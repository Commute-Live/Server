import type { ProviderPlugin, FetchContext, FetchResult } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";
import { transit_realtime } from "gtfs-realtime-bindings";
import { Buffer } from "buffer";

const FEED_MAP: Record<string, string> = {
    A: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
    C: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
    E: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
    B: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
    D: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
    F: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
    M: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
    G: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
    J: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
    Z: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
    N: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
    Q: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
    R: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
    W: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
    L: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
    "1": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
    "2": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
    "3": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
    "4": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
    "5": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
    "6": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
    "7": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
    S: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
    SI: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",
};

const FEED_CACHE_TTL_MS = 15_000;

const feedCache = new Map<string, { feed: transit_realtime.FeedMessage; expiresAt: number }>();
const inflightFeeds = new Map<string, Promise<transit_realtime.FeedMessage>>();

const fetchFeed = async (feedUrl: string, now: number, log?: FetchContext["log"]) => {
    const cached = feedCache.get(feedUrl);
    if (cached && cached.expiresAt > now) return cached.feed;

    const existing = inflightFeeds.get(feedUrl);
    if (existing) return existing;

    const work = (async () => {
        const res = await fetch(feedUrl);
        if (!res.ok) {
            throw new Error(`MTA feed error ${res.status} ${res.statusText}`);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        const feed = transit_realtime.FeedMessage.decode(buffer);
        feedCache.set(feedUrl, { feed, expiresAt: now + FEED_CACHE_TTL_MS });
        inflightFeeds.delete(feedUrl);
        return feed;
    })().catch((err) => {
        inflightFeeds.delete(feedUrl);
        log?.("[MTA]", "feed fetch failed", { feedUrl, error: err instanceof Error ? err.message : String(err) });
        throw err;
    });

    inflightFeeds.set(feedUrl, work);
    return work;
};

const pickFeedUrl = (line?: string): string | null => {
    if (!line) return null;
    const key = line.toString().trim().toUpperCase();
    return FEED_MAP[key] ?? null;
};

const normalizeLine = (line?: string) => (line ? line.trim().toUpperCase() : "");

const normalizeDirection = (direction?: string) => {
    if (!direction) return "";
    const value = direction.trim().toUpperCase();
    return value === "N" || value === "S" ? value : "";
};

const normalizeSubwayArrivals = (
    feed: transit_realtime.FeedMessage,
    filters: { line?: string; stop?: string; direction?: string }
) => {
    const line = normalizeLine(filters.line);
    const stop = filters.stop?.trim();
    const direction = normalizeDirection(filters.direction);

    const items: Array<{
        arrivalTime: string;
        scheduledTime: string | null;
        delaySeconds: number | null;
    }> = [];

    for (const entity of feed.entity) {
        const tripUpdate = entity.tripUpdate;
        if (!tripUpdate) continue;

        const routeId = normalizeLine(tripUpdate.trip?.routeId);
        if (line && routeId && routeId !== line) continue;

        for (const stu of tripUpdate.stopTimeUpdate ?? []) {
            const stopId = stu.stopId ?? "unknown";
            if (stop && stopId !== stop) continue;
            if (direction && !stopId.endsWith(direction)) continue;

            const tsSeconds = stu.arrival?.time ?? stu.departure?.time;
            if (!tsSeconds) continue;
            const delay = stu.arrival?.delay ?? stu.departure?.delay ?? null;

            const arrivalEpochMs = Number(tsSeconds) * 1000;
            const scheduledEpochMs =
                delay !== null ? arrivalEpochMs - delay * 1000 : null;

            items.push({
                arrivalTime: new Date(arrivalEpochMs).toISOString(),
                scheduledTime: scheduledEpochMs ? new Date(scheduledEpochMs).toISOString() : null,
                delaySeconds: delay,
            });
            if (items.length >= 20) break;
        }
        if (items.length >= 20) break;
    }

    return items.sort(
        (a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime)
    );
};

const sampleStops = (feed: transit_realtime.FeedMessage, limit = 12) => {
    const seen = new Set<string>();
    const samples: Array<{ routeId: string; stopId: string }> = [];
    for (const entity of feed.entity) {
        const tu = entity.tripUpdate;
        if (!tu) continue;
        const routeId = tu.trip?.routeId ?? "unknown";
        for (const stu of tu.stopTimeUpdate ?? []) {
            const stopId = stu.stopId ?? "unknown";
            const key = `${routeId}-${stopId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            samples.push({ routeId, stopId });
            if (samples.length >= limit) return samples;
        }
    }
    return samples;
};

const pickUpcomingArrivals = (
    arrivals: Array<{ arrivalTime: string; scheduledTime: string | null; delaySeconds: number | null }>,
    nowMs: number
) => {
    const graceMs = 15_000;
    const seen = new Set<string>();
    const filtered: Array<{ arrivalTime: string; scheduledTime: string | null; delaySeconds: number | null }> = [];

    for (const item of arrivals) {
        const ts = Date.parse(item.arrivalTime);
        if (!Number.isFinite(ts)) continue;
        if (ts < nowMs - graceMs) continue;
        if (seen.has(item.arrivalTime)) continue;
        seen.add(item.arrivalTime);
        filtered.push(item);
    }

    return filtered.sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime));
};

const fetchArrivals = async (key: string, ctx: FetchContext): Promise<FetchResult> => {
    const { params } = parseKeySegments(key);
    const line = params.line;
    const feedUrl = pickFeedUrl(line);
    if (!feedUrl) {
        throw new Error(`No feed mapping for line ${line}`);
    }

    const feed = await fetchFeed(feedUrl, ctx.now, ctx.log);
    let arrivals = normalizeSubwayArrivals(feed, {
        line,
        stop: params.stop,
        direction: params.direction,
    });

    if (!arrivals.length && params.stop) {
        const samples = sampleStops(feed);
        ctx.log?.("[MTA]", "no arrivals for stop filter; sample stopIds", { stop: params.stop, samples });
        // Fallback: return first stops without filtering so something is visible for debugging
        arrivals = normalizeSubwayArrivals(feed, { line, direction: params.direction });
    }

    arrivals = pickUpcomingArrivals(arrivals, ctx.now);

    return {
        payload: {
            provider: "mta",
            line,
            stop: params.stop,
            direction: params.direction,
            feedUrl,
            entities: feed.entity.length,
            arrivals,
            fetchedAt: new Date(ctx.now).toISOString(),
        },
        ttlSeconds: 15,
    };
};

export const mtaProvider: ProviderPlugin = {
    providerId: "mta",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("mta", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchArrivals(key, ctx),
};

registerProvider(mtaProvider);
