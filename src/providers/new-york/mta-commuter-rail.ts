import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";
import { transit_realtime } from "gtfs-realtime-bindings";
import { Buffer } from "buffer";
import { getProviderCacheBuffer, setProviderCacheBuffer } from "../../cache.ts";

const FEED_URLS = {
    "mta-lirr": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr",
    "mta-mnr": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr",
} as const;

const FEED_CACHE_TTL_S = 30;
const inflightFeeds = new Map<string, Promise<transit_realtime.FeedMessage>>();

const normalizeLine = (line?: string | null) => (line ? line.trim().toUpperCase() : "");

const normalizeDirection = (direction?: string) => {
    if (!direction) return "";
    const value = direction.trim().toUpperCase();
    if (value === "0" || value === "1") return value;
    if (value === "N") return "0";
    if (value === "S") return "1";
    return "";
};

const parseStops = (stop?: string) => {
    const values = (stop ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    return new Set(values);
};

const pickUpcomingArrivals = (
    arrivals: Array<{ arrivalTime: string; scheduledTime: string | null; delaySeconds: number | null; destination?: string }>,
    nowMs: number,
) => {
    const graceMs = 15_000;
    const dedupe = new Map<string, { arrivalTime: string; scheduledTime: string | null; delaySeconds: number | null; destination?: string }>();

    for (const item of arrivals) {
        const ts = Date.parse(item.arrivalTime);
        if (!Number.isFinite(ts)) continue;
        if (ts < nowMs - graceMs) continue;
        const key = `${item.arrivalTime}|${item.destination ?? ""}`;
        if (!dedupe.has(key)) {
            dedupe.set(key, item);
        }
    }

    return Array.from(dedupe.values()).sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime));
};

const feedCacheKey = (providerId: "mta-lirr" | "mta-mnr") => `${providerId}:feed`;

const fetchFeed = async (providerId: "mta-lirr" | "mta-mnr", log?: FetchContext["log"]) => {
    const cachedBuf = await getProviderCacheBuffer(feedCacheKey(providerId));
    if (cachedBuf) return transit_realtime.FeedMessage.decode(cachedBuf);

    const existing = inflightFeeds.get(providerId);
    if (existing) return existing;

    const work = (async () => {
        const res = await fetch(FEED_URLS[providerId]);
        if (!res.ok) {
            throw new Error(`MTA commuter rail feed error ${res.status} ${res.statusText}`);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        const feed = transit_realtime.FeedMessage.decode(buffer);
        await setProviderCacheBuffer(feedCacheKey(providerId), buffer, FEED_CACHE_TTL_S);
        inflightFeeds.delete(providerId);
        return feed;
    })().catch((err) => {
        inflightFeeds.delete(providerId);
        log?.("[MTA-Rail]", "feed fetch failed", {
            providerId,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    });

    inflightFeeds.set(providerId, work);
    return work;
};

const normalizeArrivals = (
    feed: transit_realtime.FeedMessage,
    filters: { line?: string; stop?: string; direction?: string },
) => {
    const line = normalizeLine(filters.line);
    const stopSet = parseStops(filters.stop);
    const direction = normalizeDirection(filters.direction);

    const items: Array<{
        arrivalTime: string;
        scheduledTime: string | null;
        delaySeconds: number | null;
        destination?: string;
    }> = [];

    for (const entity of feed.entity) {
        const tripUpdate = entity.tripUpdate;
        if (!tripUpdate) continue;

        const routeId = normalizeLine(tripUpdate.trip?.routeId);
        if (line && routeId && routeId !== line) continue;

        const tripDirectionId =
            tripUpdate.trip?.directionId !== undefined && tripUpdate.trip?.directionId !== null
                ? String(Number(tripUpdate.trip.directionId))
                : "";
        if (direction && tripDirectionId && tripDirectionId !== direction) continue;

        for (const stu of tripUpdate.stopTimeUpdate ?? []) {
            const stopId = (stu.stopId ?? "").trim();
            if (stopSet.size > 0 && !stopSet.has(stopId)) continue;

            const tsSeconds = stu.arrival?.time ?? stu.departure?.time;
            if (!tsSeconds) continue;
            const delay = stu.arrival?.delay ?? stu.departure?.delay ?? null;

            const arrivalEpochMs = Number(tsSeconds) * 1000;
            const scheduledEpochMs = delay !== null ? arrivalEpochMs - delay * 1000 : null;
            const stuAny = stu as unknown as { stopHeadsign?: string | null };
            const destination = (stuAny.stopHeadsign ?? "").trim() || undefined;

            items.push({
                arrivalTime: new Date(arrivalEpochMs).toISOString(),
                scheduledTime: scheduledEpochMs ? new Date(scheduledEpochMs).toISOString() : null,
                delaySeconds: delay,
                destination,
            });
            if (items.length >= 50) break;
        }

        if (items.length >= 50) break;
    }

    return items;
};

const fetchCommuterRailArrivals =
    (providerId: "mta-lirr" | "mta-mnr") =>
    async (key: string, ctx: FetchContext): Promise<FetchResult> => {
        const { params } = parseKeySegments(key);

        const feed = await fetchFeed(providerId, ctx.log);
        let arrivals = normalizeArrivals(feed, {
            line: params.line,
            stop: params.stop,
            direction: params.direction,
        });

        arrivals = pickUpcomingArrivals(arrivals, ctx.now);

        return {
            payload: {
                provider: providerId,
                line: params.line,
                stop: params.stop,
                direction: normalizeDirection(params.direction) || params.direction || null,
                feedUrl: FEED_URLS[providerId],
                entities: feed.entity.length,
                arrivals,
                fetchedAt: new Date(ctx.now).toISOString(),
            },
            ttlSeconds: FEED_CACHE_TTL_S,
        };
    };

export const mtaLirrProvider: ProviderPlugin = {
    providerId: "mta-lirr",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("mta-lirr", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchCommuterRailArrivals("mta-lirr")(key, ctx),
};

export const mtaMnrProvider: ProviderPlugin = {
    providerId: "mta-mnr",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("mta-mnr", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchCommuterRailArrivals("mta-mnr")(key, ctx),
};

registerProvider(mtaLirrProvider);
registerProvider(mtaMnrProvider);
