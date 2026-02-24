import { transit_realtime } from "gtfs-realtime-bindings";
import { Buffer } from "buffer";
import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";
import { getProviderCacheBuffer, setProviderCacheBuffer } from "../../cache.ts";
import { fillSeptaScheduledArrivals } from "./schedule_fill.ts";

const TRIP_FEED_URL =
    process.env.SEPTA_LIVE_BUS_RT_URL ?? "https://www3.septa.org/gtfsrt/septa-pa-us/Trip/rtTripUpdates.pb";
const TRIP_PRINT_URL =
    process.env.SEPTA_LIVE_BUS_PRINT_URL ?? "https://www3.septa.org/gtfsrt/septa-pa-us/Trip/print.php";
const FEED_TTL_S = 15;
const CACHE_TTL_SECONDS = 20;
const FEED_CACHE_KEY = "septa-bus:feed";
const PRINT_FEED_CACHE_KEY = "septa-bus:print";

let inflight: Promise<transit_realtime.FeedMessage> | null = null;
let printInflight: Promise<string> | null = null;

type NormalizedArrival = {
    arrivalTime: string;
    scheduledTime: string | null;
    delaySeconds: number | null;
    destination?: string;
};

type PrintTripUpdate = {
    routeId?: string;
    directionId?: string;
    tripId?: string;
    arrivals: Array<{
        stopId?: string;
        arrivalEpochMs?: number;
        departureEpochMs?: number;
        delaySeconds?: number;
    }>;
};

const fetchFeed = async (now: number) => {
    const cachedBuf = await getProviderCacheBuffer(FEED_CACHE_KEY);
    if (cachedBuf) return transit_realtime.FeedMessage.decode(cachedBuf);

    if (inflight) return inflight;
    inflight = (async () => {
        const res = await fetch(TRIP_FEED_URL);
        if (!res.ok) throw new Error(`SEPTA trip feed error ${res.status} ${res.statusText}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const feed = transit_realtime.FeedMessage.decode(buffer);
        await setProviderCacheBuffer(FEED_CACHE_KEY, buffer, FEED_TTL_S);
        inflight = null;
        return feed;
    })().catch((err) => {
        inflight = null;
        throw err;
    });
    return inflight;
};

const parseTripPrintUpdates = (body: string): PrintTripUpdate[] => {
    const updates: PrintTripUpdate[] = [];
    const entityMatches = body.match(/entity\s*\{[\s\S]*?\n\}/g) ?? [];
    for (const entity of entityMatches) {
        const tuMatch = entity.match(/trip_update\s*\{([\s\S]*?)\n\s*\}/);
        if (!tuMatch?.[1]) continue;
        const tripUpdateBody = tuMatch[1];

        const routeId = tripUpdateBody.match(/route_id:\s*"([^"]+)"/)?.[1];
        const directionId = tripUpdateBody.match(/direction_id:\s*(\d+)/)?.[1];
        const tripId = tripUpdateBody.match(/trip_id:\s*"([^"]+)"/)?.[1];

        const stopBlocks = tripUpdateBody.match(/stop_time_update\s*\{([\s\S]*?)\n\s*\}/g) ?? [];
        const arrivals = stopBlocks.map((block) => {
            const stopId = block.match(/stop_id:\s*"([^"]+)"/)?.[1];
            const arrivalSecondsRaw = block.match(/arrival\s*\{[\s\S]*?time:\s*(\d+)/)?.[1];
            const departureSecondsRaw = block.match(/departure\s*\{[\s\S]*?time:\s*(\d+)/)?.[1];
            const delayRaw = block.match(/(?:arrival|departure)\s*\{[\s\S]*?delay:\s*(-?\d+)/)?.[1];

            const arrivalEpochMs = arrivalSecondsRaw ? Number(arrivalSecondsRaw) * 1000 : undefined;
            const departureEpochMs = departureSecondsRaw ? Number(departureSecondsRaw) * 1000 : undefined;
            const delaySeconds = delayRaw ? Number(delayRaw) : undefined;
            return {
                stopId,
                arrivalEpochMs: Number.isFinite(arrivalEpochMs) ? arrivalEpochMs : undefined,
                departureEpochMs: Number.isFinite(departureEpochMs) ? departureEpochMs : undefined,
                delaySeconds: Number.isFinite(delaySeconds) ? delaySeconds : undefined,
            };
        });

        updates.push({ routeId, directionId, tripId, arrivals });
    }

    return updates;
};

const fetchPrintSnapshot = async () => {
    const cached = await getProviderCacheBuffer(PRINT_FEED_CACHE_KEY);
    if (cached) return Buffer.from(cached).toString("utf8");

    if (printInflight) return printInflight;
    printInflight = (async () => {
        const res = await fetch(TRIP_PRINT_URL);
        if (!res.ok) throw new Error(`SEPTA trip print error ${res.status} ${res.statusText}`);
        const text = await res.text();
        await setProviderCacheBuffer(PRINT_FEED_CACHE_KEY, Buffer.from(text, "utf8"), FEED_TTL_S);
        printInflight = null;
        return text;
    })().catch((err) => {
        printInflight = null;
        throw err;
    });

    return printInflight;
};

const pickArrivalsFromPrint = (
    snapshot: string,
    filters: { route?: string; stop?: string; direction?: string },
    nowMs: number,
): NormalizedArrival[] => {
    const route = filters.route?.trim();
    const stop = filters.stop?.trim();
    const direction = filters.direction?.trim();
    const out: NormalizedArrival[] = [];
    for (const item of parseTripPrintUpdates(snapshot)) {
        if (route && item.routeId?.trim() !== route) continue;
        if (direction && item.directionId?.trim() !== direction) continue;

        for (const arrival of item.arrivals) {
            if (stop && arrival.stopId?.trim() !== stop) continue;
            const ts = arrival.arrivalEpochMs ?? arrival.departureEpochMs;
            if (!ts || !Number.isFinite(ts)) continue;
            if (ts < nowMs - 15_000) continue;

            out.push({
                arrivalTime: new Date(ts).toISOString(),
                scheduledTime:
                    typeof arrival.delaySeconds === "number"
                        ? new Date(ts - arrival.delaySeconds * 1000).toISOString()
                        : null,
                delaySeconds: typeof arrival.delaySeconds === "number" ? arrival.delaySeconds : null,
                destination: undefined,
            });
        }
    }

    const seen = new Set<string>();
    return out
        .filter((a) => {
            if (seen.has(a.arrivalTime)) return false;
            seen.add(a.arrivalTime);
            return true;
        })
        .sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime))
        .slice(0, 20);
};

const normalizeDirection = (value?: string | null) => {
    if (!value) return undefined;
    const v = value.trim().toUpperCase();
    if (v === "N" || v === "0") return "0";
    if (v === "S" || v === "1") return "1";
    return v || undefined;
};

const pickArrivals = (
    feed: transit_realtime.FeedMessage,
    filters: { route?: string; stop?: string; direction?: string },
    nowMs: number
) => {
    const arrivals: Array<{
        arrivalTime: string;
        scheduledTime: string | null;
        delaySeconds: number | null;
        destination?: string;
    }> = [];
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
            const trip = tu.trip as unknown as {
                tripId?: string;
                routeId?: string;
                directionId?: number;
                tripHeadsign?: string;
            };
            const destinationFromTrip = (trip?.tripHeadsign ?? "").trim() || undefined;
            const destination = destinationFromTrip;
            arrivals.push({
                arrivalTime: new Date(arrivalEpochMs).toISOString(),
                scheduledTime: scheduledEpochMs ? new Date(scheduledEpochMs).toISOString() : null,
                delaySeconds: delay,
                destination,
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

const normalizeRoute = (value?: string | null) =>
    (value ?? "").trim().toUpperCase().replace(/\s+/g, " ");

export const fetchSeptaSurfaceArrivals = async (
    key: string,
    ctx: FetchContext,
    providerId = "septa-bus",
): Promise<FetchResult> => {
    const { params } = parseKeySegments(key);
    const route = normalizeRoute(params.line ?? "");
    const stop = (params.stop ?? "").trim();
    const direction = normalizeDirection(params.direction);
    if (!route) throw new Error("SEPTA bus route is required (line=<routeId>)");
    if (!stop) throw new Error("SEPTA bus stop is required (stop=<stopId>)");

    let arrivals: NormalizedArrival[] = [];
    try {
        const feed = await fetchFeed(ctx.now);
        arrivals = pickArrivals(feed, { route, stop, direction }, ctx.now);
    } catch {
        // Fall through to print.php snapshot fallback.
    }

    if (!arrivals.length) {
        try {
            const snapshot = await fetchPrintSnapshot();
            arrivals = pickArrivalsFromPrint(snapshot, { route, stop, direction }, ctx.now);
        } catch {
            // Keep empty arrivals.
        }
    }
    if (arrivals.length < 3) {
        const mode = providerId === "septa-trolley" ? "trolley" : "bus";
        const fallback = await fillSeptaScheduledArrivals({
            mode,
            routeId: route,
            stopInput: stop,
            direction,
            nowMs: ctx.now,
            limit: 3 - arrivals.length,
        });
        const seen = new Set(arrivals.map((a) => `${a.arrivalTime}:${a.destination ?? ""}`));
        for (const row of fallback) {
            const key = `${row.arrivalTime}:${row.destination ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            arrivals.push({
                arrivalTime: row.arrivalTime,
                scheduledTime: row.scheduledTime,
                delaySeconds: null,
                destination: row.destination,
            });
            if (arrivals.length >= 3) break;
        }
        arrivals = arrivals.sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime));
    }
    const stopName = stop;
    const destination = arrivals.find((a) => typeof a.destination === "string" && a.destination.length > 0)?.destination;

    return {
        payload: {
            provider: providerId,
            line: route,
            stop: stopName ?? stop,
            stopId: stop,
            stopName: stopName ?? stop,
            direction,
            directionLabel: destination ?? direction ?? stopName ?? stop,
            destination,
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
    fetch: (key: string, ctx: FetchContext) =>
        fetchSeptaSurfaceArrivals(key, ctx, "septa-bus"),
};

registerProvider(septaBusProvider);
