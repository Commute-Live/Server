import { cacheMap, getCacheEntry, markExpired, setCacheEntry } from "./cache.ts";
import type { AggregatorEngine, FanoutMap, ProviderPlugin, Subscription } from "./types.ts";
import { providerRegistry, parseKeySegments } from "./providers/index.ts";
import "./providers/mta.ts";
import "./providers/mta-bus.ts";

type EngineOptions = {
    providers?: Map<string, ProviderPlugin>;
    loadSubscriptions: () => Promise<Subscription[]>;
    refreshIntervalMs?: number;
    pushIntervalMs?: number;
    publish?: (topic: string, payload: unknown) => void;
};

const defaultPublish = (topic: string, payload: unknown) => {
    console.log("[PUBLISH]", topic, JSON.stringify(payload));
};

// Creates Key --> DeviceIds && DeviceIds --> Keys
const buildFanoutMaps = (subs: Subscription[], providers: Map<string, ProviderPlugin>) => {
    const fanout: FanoutMap = new Map();
    const deviceToKeys = new Map<string, Set<string>>();

    for (const sub of subs) {
        const provider = providers.get(sub.provider);
        if (!provider) {
            console.warn(`[ENGINE] Unknown provider ${sub.provider} for device ${sub.deviceId}`);
            continue;
        }
        if (!provider.supports(sub.type)) {
            console.warn(`[ENGINE] Provider ${sub.provider} does not support type ${sub.type}`);
            continue;
        }
        const key = provider.toKey({ type: sub.type, config: sub.config });
        if (!fanout.has(key)) {
            fanout.set(key, new Set());
        }
        fanout.get(key)!.add(sub.deviceId);

        if (!deviceToKeys.has(sub.deviceId)) {
            deviceToKeys.set(sub.deviceId, new Set());
        }
        deviceToKeys.get(sub.deviceId)!.add(key);
    }

    return { fanout, deviceToKeys };
};

const extractNextArrivals = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return [];
    const body = payload as Record<string, unknown>;
    const arrivalsRaw = body.arrivals;
    if (!Array.isArray(arrivalsRaw)) return [];

    return arrivalsRaw.slice(0, 3).map((item) => {
        const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        return {
            arrivalTime: typeof row.arrivalTime === "string" ? row.arrivalTime : undefined,
            delaySeconds: typeof row.delaySeconds === "number" ? row.delaySeconds : undefined,
        };
    });
};

const buildDeviceCommandPayload = (key: string, payload: unknown) => {
    const { params } = parseKeySegments(key);
    const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

    const lineFromPayload = typeof body.line === "string" ? body.line : "";
    const lineFromKey = typeof params.line === "string" ? params.line : "";
    const line = lineFromPayload || lineFromKey;

    return {
        provider: typeof body.provider === "string" ? body.provider : undefined,
        line: line || undefined,
        stop:
            typeof body.stop === "string"
                ? body.stop
                : typeof params.stop === "string" && params.stop.length > 0
                  ? params.stop
                  : undefined,
        direction:
            typeof body.direction === "string"
                ? body.direction
                : typeof params.direction === "string" && params.direction.length > 0
                  ? params.direction
                  : undefined,
        fetchedAt: typeof body.fetchedAt === "string" ? body.fetchedAt : new Date().toISOString(),
        nextArrivals: extractNextArrivals(payload),
    };
};

export function startAggregatorEngine(options: EngineOptions): AggregatorEngine {
    const providers = options.providers ?? providerRegistry;
    const loadSubscriptions = options.loadSubscriptions;
    const publish = options.publish ?? defaultPublish;
    const refreshIntervalMs = options.refreshIntervalMs ?? 1000;
    const pushIntervalMs = options.pushIntervalMs ?? 30_000;

    const inflight = new Map<string, Promise<void>>();
    let fanout: FanoutMap = new Map();
    let deviceToKeys = new Map<string, Set<string>>();
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let pushTimer: ReturnType<typeof setInterval> | null = null;

    const publishToDeviceTopics = (key: string, payload: unknown) => {
        const deviceIds = fanout.get(key);
        if (!deviceIds?.size) {
            return;
        }

        const command = buildDeviceCommandPayload(key, payload);

        for (const deviceId of deviceIds) {
            publish(`/device/${deviceId}/commands`, command);
        }
    };

    const fetchKey = async (key: string) => {
        if (inflight.has(key)) {
            return inflight.get(key);
        }
        const work = (async () => {
            const { providerId } = parseKeySegments(key);
            const provider = providers.get(providerId);
            if (!provider) {
                console.warn(`[ENGINE] No provider found for key ${key}`);
                return;
            }
            const now = Date.now();
            try {
                const result = await provider.fetch(key, {
                    now,
                    key,
                    log: (...args: unknown[]) => console.log("[FETCH]", key, ...args),
                });
                setCacheEntry(key, result.payload, result.ttlSeconds, now);
                publishToDeviceTopics(key, result.payload);
            } catch (err) {
                console.error(`[ENGINE] fetch failed for key ${key}:`, err);
            } finally {
                inflight.delete(key);
            }
        })();

        inflight.set(key, work);
        return work;
    };

    const scheduleFetches = () => {
        const now = Date.now();
        for (const key of fanout.keys()) {
            const entry = getCacheEntry(key);
            const expired = !entry || entry.expiresAt <= now;
            if (expired) {
                void fetchKey(key);
            }
        }
    };

    const pushCachedPayloads = () => {
        for (const [key, entry] of cacheMap()) {
            if (!fanout.has(key)) continue;
            publishToDeviceTopics(key, entry.payload);
        }
    };

    const rebuild = async () => {
        const subs = await loadSubscriptions();
        const maps = buildFanoutMaps(subs, providers);
        fanout = maps.fanout;
        deviceToKeys = maps.deviceToKeys;
        scheduleFetches();
    };

    const ready = rebuild();

    refreshTimer = setInterval(scheduleFetches, refreshIntervalMs);
    pushTimer = setInterval(pushCachedPayloads, pushIntervalMs);

    const refreshKey = async (key: string) => {
        const now = Date.now();
        markExpired(key, now);
        await ready;
        if (fanout.has(key)) {
            await fetchKey(key);
        }
    };

    const refreshDevice = async (deviceId: string) => {
        await ready;
        const keys = deviceToKeys.get(deviceId);
        if (!keys?.size) return;
        const now = Date.now();
        const promises: Promise<void>[] = [];
        for (const key of keys) {
            markExpired(key, now);
            promises.push(fetchKey(key));
        }
        await Promise.all(promises);
    };

    const reloadSubscriptions = async () => {
        await rebuild();
    };

    const stop = () => {
        if (refreshTimer) clearInterval(refreshTimer);
        if (pushTimer) clearInterval(pushTimer);
    };

    return {
        refreshKey,
        refreshDevice,
        reloadSubscriptions,
        getFanout: () => fanout,
        getCache: () => cacheMap(),
        stop,
        ready,
    };
}
