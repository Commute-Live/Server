import type { ProviderPlugin, FetchContext, FetchResult } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";
import { transit_realtime } from "gtfs-realtime-bindings";
import { Buffer } from "buffer";
import { getProviderCacheBuffer, setProviderCacheBuffer } from "../../cache.ts";
import { readFileSync } from "node:fs";
import { resolveDirectionLabel } from "../../transit/direction_label.ts";

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

const FEED_CACHE_TTL_S = 30;

const inflightFeeds = new Map<string, Promise<transit_realtime.FeedMessage>>();
let tripHeadsignByTripId: Map<string, string> | null = null;

const TERMINAL_BY_LINE_DIRECTION: Record<string, { N?: string; S?: string }> = {
    "1": { N: "Van Cortlandt Park-242 St", S: "South Ferry" },
    "2": { N: "Wakefield-241 St", S: "Flatbush Av-Brooklyn College" },
    "3": { N: "Harlem-148 St", S: "New Lots Av" },
    "4": { N: "Woodlawn", S: "Crown Hts-Utica Av" },
    "5": { N: "Eastchester-Dyre Av", S: "Flatbush Av-Brooklyn College" },
    "6": { N: "Pelham Bay Park", S: "Brooklyn Bridge-City Hall" },
    "7": { N: "Flushing-Main St", S: "34 St-Hudson Yards" },
    A: { N: "Inwood-207 St", S: "Far Rockaway-Mott Av" },
    C: { N: "168 St", S: "Euclid Av" },
    E: { N: "Jamaica Center-Parsons/Archer", S: "World Trade Center" },
    B: { N: "Bedford Park Blvd", S: "Brighton Beach" },
    D: { N: "Norwood-205 St", S: "Coney Island-Stillwell Av" },
    F: { N: "Jamaica-179 St", S: "Coney Island-Stillwell Av" },
    M: { N: "Forest Hills-71 Av", S: "Middle Village-Metropolitan Av" },
    G: { N: "Court Sq", S: "Church Av" },
    J: { N: "Jamaica Center-Parsons/Archer", S: "Broad St" },
    Z: { N: "Jamaica Center-Parsons/Archer", S: "Broad St" },
    L: { N: "8 Av", S: "Canarsie-Rockaway Pkwy" },
    N: { N: "Astoria-Ditmars Blvd", S: "Coney Island-Stillwell Av" },
    Q: { N: "96 St", S: "Coney Island-Stillwell Av" },
    R: { N: "Forest Hills-71 Av", S: "Bay Ridge-95 St" },
    W: { N: "Astoria-Ditmars Blvd", S: "Whitehall St-South Ferry" },
    SI: { N: "St George", S: "Tottenville" },
    S: { N: "Times Sq-42 St", S: "Grand Central-42 St" },
};

const parseCsvLine = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (ch === "," && !inQuotes) {
            out.push(cur);
            cur = "";
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out;
};

const getTripHeadsignMap = () => {
    if (tripHeadsignByTripId) return tripHeadsignByTripId;
    const map = new Map<string, string>();
    const path = "data/mta/trips.txt";

    try {
        const lines = readFileSync(path, "utf8")
            .split(/\r?\n/)
            .filter((line) => line.length > 0);
        if (lines.length === 0) {
            tripHeadsignByTripId = map;
            return map;
        }

        const header = parseCsvLine(lines[0] ?? "");
        const tripIdIdx = header.indexOf("trip_id");
        const headsignIdx = header.indexOf("trip_headsign");

        if (tripIdIdx < 0 || headsignIdx < 0) {
            tripHeadsignByTripId = map;
            return map;
        }

        for (let i = 1; i < lines.length; i++) {
            const cols = parseCsvLine(lines[i] ?? "");
            const tripId = (cols[tripIdIdx] ?? "").trim();
            const headsign = (cols[headsignIdx] ?? "").trim();
            if (!tripId || !headsign) continue;
            map.set(tripId, headsign);
        }
    } catch {
        // Keep empty map on file or parse failures.
    }

    tripHeadsignByTripId = map;
    return map;
};

const feedCacheKey = (feedUrl: string) => `mta-subway:feed:${feedUrl}`;

const fetchFeed = async (feedUrl: string, now: number, log?: FetchContext["log"]) => {
    const cachedBuf = await getProviderCacheBuffer(feedCacheKey(feedUrl));
    if (cachedBuf) return transit_realtime.FeedMessage.decode(cachedBuf);

    const existing = inflightFeeds.get(feedUrl);
    if (existing) return existing;

    const work = (async () => {
        const res = await fetch(feedUrl);
        if (!res.ok) {
            throw new Error(`MTA feed error ${res.status} ${res.statusText}`);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        const feed = transit_realtime.FeedMessage.decode(buffer);
        await setProviderCacheBuffer(feedCacheKey(feedUrl), buffer, FEED_CACHE_TTL_S);
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

const normalizeLine = (line?: string | null) => (line ? line.trim().toUpperCase() : "");

const normalizeDirection = (direction?: string) => {
    if (!direction) return "";
    const value = direction.trim().toUpperCase();
    return value === "N" || value === "S" ? value : "";
};

const fallbackDestination = (line?: string, direction?: string) => {
    const route = normalizeLine(line);
    const dir = normalizeDirection(direction);
    if (!route || !dir) return undefined;
    return TERMINAL_BY_LINE_DIRECTION[route]?.[dir] ?? undefined;
};

const normalizeSubwayArrivals = (
    feed: transit_realtime.FeedMessage,
    filters: { line?: string; stop?: string; direction?: string }
) => {
    const line = normalizeLine(filters.line);
    const stop = filters.stop?.trim();
    const direction = normalizeDirection(filters.direction);
    const fallback = fallbackDestination(line, direction);

    const items: Array<{
        arrivalTime: string;
        scheduledTime: string | null;
        delaySeconds: number | null;
        destination?: string;
    }> = [];

    const tripHeadsigns = getTripHeadsignMap();

    for (const entity of feed.entity) {
        const tripUpdate = entity.tripUpdate;
        if (!tripUpdate) continue;

        const routeId = normalizeLine(tripUpdate.trip?.routeId);
        if (line && routeId && routeId !== line) continue;
        const tripId = tripUpdate.trip?.tripId ?? "";
        const destination = tripId ? tripHeadsigns.get(tripId) : undefined;

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
                destination: destination || fallback,
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
    arrivals: Array<{ arrivalTime: string; scheduledTime: string | null; delaySeconds: number | null; destination?: string }>,
    nowMs: number
) => {
    const graceMs = 15_000;
    const seen = new Set<string>();
    const filtered: Array<{ arrivalTime: string; scheduledTime: string | null; delaySeconds: number | null; destination?: string }> = [];

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
    const normalizedDirection = normalizeDirection(params.direction);
    const directionLabel =
        resolveDirectionLabel({
            line,
            direction: normalizedDirection,
            stop: params.stop,
        }) ||
        undefined;
    const destination = arrivals[0]?.destination ?? fallbackDestination(line, normalizedDirection);

    return {
        payload: {
            provider: "mta-subway",
            line,
            stop: params.stop,
            direction: normalizedDirection || params.direction,
            directionLabel,
            destination,
            feedUrl,
            entities: feed.entity.length,
            arrivals,
            fetchedAt: new Date(ctx.now).toISOString(),
        },
        ttlSeconds: 30,
    };
};

export const mtaProvider: ProviderPlugin = {
    providerId: "mta-subway",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("mta-subway", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchArrivals(key, ctx),
};

registerProvider(mtaProvider);
