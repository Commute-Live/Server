import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";
import { transit_realtime } from "gtfs-realtime-bindings";
import { Buffer } from "buffer";
import { getProviderCache, getProviderCacheBuffer, setProviderCache, setProviderCacheBuffer } from "../../cache.ts";

type ProviderId = "njt-rail" | "njt-bus";

type TokenEntry = {
    token: string;
};

const PROVIDER_CONFIG: Record<
    ProviderId,
    {
        tokenUrl: string;
        tripUpdatesUrl: string;
        tokenCacheKey: string;
        feedCacheKey: string;
        authMode: "rail" | "bus";
    }
> = {
    "njt-rail": {
        tokenUrl: process.env.NJT_RAIL_TOKEN_URL ?? "https://raildata.njtransit.com/api/GTFSRT/getToken",
        tripUpdatesUrl: process.env.NJT_RAIL_TRIP_UPDATES_URL ?? "https://raildata.njtransit.com/api/GTFSRT/getTripUpdates",
        tokenCacheKey: "njt-rail:token",
        feedCacheKey: "njt-rail:feed",
        authMode: "rail",
    },
    "njt-bus": {
        tokenUrl: process.env.NJT_BUS_TOKEN_URL ?? "https://pcsdata.njtransit.com/api/GTFSG2/authenticateUser",
        tripUpdatesUrl: process.env.NJT_BUS_TRIP_UPDATES_URL ?? "https://pcsdata.njtransit.com/api/GTFSG2/getTripUpdates",
        tokenCacheKey: "njt-bus:token",
        feedCacheKey: "njt-bus:feed",
        authMode: "bus",
    },
};

const FEED_CACHE_TTL_S = 30;
const TOKEN_CACHE_TTL_S = 23 * 60 * 60;
const inflightFeeds = new Map<ProviderId, Promise<transit_realtime.FeedMessage>>();
const inflightTokens = new Map<ProviderId, Promise<string>>();

const normalizeLine = (line?: string | null) => (line ? line.trim().toUpperCase() : "");

const normalizeDirection = (direction?: string) => {
    if (!direction) return "";
    const value = direction.trim().toUpperCase();
    if (value === "0" || value === "1") return value;
    if (value === "N") return "0";
    if (value === "S") return "1";
    return "";
};

const parseStops = (stop?: string) =>
    new Set(
        (stop ?? "")
            .split(",")
            .map((v) => v.trim())
            .filter((v) => v.length > 0),
    );

const pickUpcomingArrivals = (
    arrivals: Array<{
        arrivalTime: string;
        scheduledTime: string | null;
        delaySeconds: number | null;
        destination?: string;
    }>,
    nowMs: number,
) => {
    const graceMs = 15_000;
    const dedupe = new Map<
        string,
        { arrivalTime: string; scheduledTime: string | null; delaySeconds: number | null; destination?: string }
    >();

    for (const item of arrivals) {
        const ts = Date.parse(item.arrivalTime);
        if (!Number.isFinite(ts) || ts < nowMs - graceMs) continue;
        const key = `${item.arrivalTime}|${item.destination ?? ""}`;
        if (!dedupe.has(key)) {
            dedupe.set(key, item);
        }
    }

    return Array.from(dedupe.values()).sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime));
};

const extractTokenFromJson = (payload: unknown, authMode: "rail" | "bus"): string | null => {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;

    if (authMode === "rail") {
        const authenticated = String(record.Authenticated ?? record.authenticated ?? "").toLowerCase();
        if (authenticated && authenticated !== "true") {
            throw new Error("NJ Transit rail authentication failed");
        }
    }

    for (const key of ["UserToken", "userToken", "token", "Token", "accessToken", "AccessToken"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }

    if (typeof record.errorMessage === "string" && record.errorMessage.trim()) {
        throw new Error(record.errorMessage.trim());
    }

    return null;
};

const getCredentials = () => {
    const username = process.env.NJT_API_USERNAME ?? "";
    const password = process.env.NJT_API_PASSWORD ?? "";
    if (!username || !password) {
        throw new Error("NJ Transit credentials are required (set NJT_API_USERNAME and NJT_API_PASSWORD)");
    }
    return { username, password };
};

const fetchToken = async (providerId: ProviderId): Promise<string> => {
    const config = PROVIDER_CONFIG[providerId];
    const cached = await getProviderCache<TokenEntry>(config.tokenCacheKey);
    if (cached?.token) return cached.token;

    const existing = inflightTokens.get(providerId);
    if (existing) return existing;

    const work = (async () => {
        const { username, password } = getCredentials();
        const form = new FormData();
        form.set("username", username);
        form.set("password", password);

        const res = await fetch(config.tokenUrl, {
            method: "POST",
            body: form,
        });
        if (!res.ok) {
            throw new Error(`NJ Transit token error ${res.status} ${res.statusText}`);
        }

        const raw = await res.text();
        let token = raw.trim();
        if (raw.trim().startsWith("{")) {
            token = extractTokenFromJson(JSON.parse(raw), config.authMode) ?? "";
        }
        if (!token) {
            throw new Error("NJ Transit token response did not include a token");
        }

        await setProviderCache(config.tokenCacheKey, { token }, TOKEN_CACHE_TTL_S);
        inflightTokens.delete(providerId);
        return token;
    })().catch((err) => {
        inflightTokens.delete(providerId);
        throw err;
    });

    inflightTokens.set(providerId, work);
    return work;
};

const clearToken = async (providerId: ProviderId) => {
    await setProviderCache(PROVIDER_CONFIG[providerId].tokenCacheKey, { token: "" }, 1);
};

const postTripUpdates = async (providerId: ProviderId, token: string): Promise<Buffer> => {
    const config = PROVIDER_CONFIG[providerId];
    const form = new FormData();
    form.set("token", token);

    const res = await fetch(config.tripUpdatesUrl, {
        method: "POST",
        body: form,
    });
    if (!res.ok) {
        throw new Error(`NJ Transit trip updates error ${res.status} ${res.statusText}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "";
    const textLike = contentType.includes("json") || contentType.includes("text") || buffer[0] === 0x7b;
    if (textLike) {
        const raw = buffer.toString("utf8").trim();
        if (raw.startsWith("{")) {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const message = typeof parsed.errorMessage === "string" ? parsed.errorMessage : "";
            if (message.toLowerCase().includes("invalid token")) {
                throw new Error("INVALID_TOKEN");
            }
            throw new Error(message || `Unexpected NJ Transit ${providerId} response`);
        }
    }

    return buffer;
};

const fetchFeed = async (providerId: ProviderId, log?: FetchContext["log"]) => {
    const config = PROVIDER_CONFIG[providerId];
    const cachedBuf = await getProviderCacheBuffer(config.feedCacheKey);
    if (cachedBuf) return transit_realtime.FeedMessage.decode(cachedBuf);

    const existing = inflightFeeds.get(providerId);
    if (existing) return existing;

    const work = (async () => {
        let token = await fetchToken(providerId);
        let buffer: Buffer;

        try {
            buffer = await postTripUpdates(providerId, token);
        } catch (err) {
            if (!(err instanceof Error) || err.message !== "INVALID_TOKEN") throw err;
            await clearToken(providerId);
            token = await fetchToken(providerId);
            buffer = await postTripUpdates(providerId, token);
        }

        const feed = transit_realtime.FeedMessage.decode(buffer);
        await setProviderCacheBuffer(config.feedCacheKey, buffer, FEED_CACHE_TTL_S);
        inflightFeeds.delete(providerId);
        return feed;
    })().catch((err) => {
        inflightFeeds.delete(providerId);
        log?.("[NJT]", "feed fetch failed", {
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

const fetchArrivals =
    (providerId: ProviderId) =>
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
                entities: feed.entity.length,
                arrivals,
                fetchedAt: new Date(ctx.now).toISOString(),
            },
            ttlSeconds: FEED_CACHE_TTL_S,
        };
    };

export const njtRailProvider: ProviderPlugin = {
    providerId: "njt-rail",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("njt-rail", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchArrivals("njt-rail")(key, ctx),
};

export const njtBusProvider: ProviderPlugin = {
    providerId: "njt-bus",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("njt-bus", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchArrivals("njt-bus")(key, ctx),
};

registerProvider(njtRailProvider);
registerProvider(njtBusProvider);
