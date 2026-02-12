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

export function startAggregatorEngine(options: EngineOptions): AggregatorEngine {
    const providers = options.providers ?? providerRegistry;
    const loadSubscriptions = options.loadSubscriptions;
    const publish = options.publish ?? defaultPublish;
    const refreshIntervalMs = options.refreshIntervalMs ?? 1000;
    const pushIntervalMs = options.pushIntervalMs ?? 15_000;

    const inflight = new Map<string, Promise<void>>();
    let fanout: FanoutMap = new Map();
    let deviceToKeys = new Map<string, Set<string>>();
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let pushTimer: ReturnType<typeof setInterval> | null = null;

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
            } catch (err) {
                console.error(`[ENGINE] fetch failed for key ${key}:`, err);
            } finally {
                inflight.delete(key);
            }
        })();

        inflight.set(key, work);
        return work;
    };

    const publishPayloads = (key: string) => {
        const deviceIds = fanout.get(key);
        if (!deviceIds?.size) {
            console.log("[MQTT] no device subscribers for key", key);
            return;
        }

        const { params } = parseKeySegments(key);
        const msg = {
            type: "render_route",
            route: params.line ?? "unknown",
            sentAt: new Date().toISOString(),
        };

        for (const deviceId of deviceIds) {
            const topic = `/device/${deviceId}/commands`;
            console.log("[MQTT] publish device command", { deviceId, key, topic, msg });
            publish(topic, msg);
        }
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
        for (const [key] of cacheMap()) {
            if (!fanout.has(key)) continue;
            publishPayloads(key);
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
