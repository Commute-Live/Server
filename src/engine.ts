import { cacheMap, getCacheEntry, markExpired, setCacheEntry } from "./cache.ts";
import type { AggregatorEngine, FanoutMap, ProviderPlugin, Subscription } from "./types.ts";
import { providerRegistry, parseKeySegments } from "./providers/index.ts";
import { resolveStopName } from "./gtfs/stops_lookup.ts";
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

type DeviceLinePayload = {
    provider?: string;
    line?: string;
    stop?: string;
    stopId?: string;
    direction?: string;
    fetchedAt?: string;
    nextArrivals: Array<{ arrivalTime?: string; delaySeconds?: number }>;
};

const buildDeviceLinePayload = (key: string, payload: unknown): DeviceLinePayload => {
    const { params } = parseKeySegments(key);
    const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

    const lineFromPayload = typeof body.line === "string" ? body.line : "";
    const lineFromKey = typeof params.line === "string" ? params.line : "";
    const line = lineFromPayload || lineFromKey;

    const stopId =
        typeof body.stopId === "string"
            ? body.stopId
            : typeof params.stop === "string" && params.stop.length > 0
              ? params.stop
              : undefined;
    const stopName = stopId ? resolveStopName(stopId) : undefined;

    return {
        provider: typeof body.provider === "string" ? body.provider : undefined,
        line: line || undefined,
        stop: stopName ?? stopId,
        stopId,
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

const buildDeviceCommandPayload = (keys: Set<string>) => {
    const lines: DeviceLinePayload[] = [];

    for (const key of keys) {
        const entry = getCacheEntry(key);
        if (!entry) continue;
        const linePayload = buildDeviceLinePayload(key, entry.payload);
        if (!linePayload.line) continue;
        lines.push(linePayload);
    }

    lines.sort((a, b) => (a.line ?? "").localeCompare(b.line ?? ""));

    const primary = lines[0];
    return {
        provider: primary?.provider,
        line: primary?.line,
        stop: primary?.stop,
        stopId: primary?.stopId,
        direction: primary?.direction,
        fetchedAt: new Date().toISOString(),
        nextArrivals: primary?.nextArrivals ?? [],
        lines,
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

    const publishDeviceCommand = (deviceId: string) => {
        const keys = deviceToKeys.get(deviceId);
        if (!keys?.size) {
            return;
        }

        const command = buildDeviceCommandPayload(keys);
        publish(`/device/${deviceId}/commands`, command);
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
                const deviceIds = fanout.get(key);
                if (deviceIds?.size) {
                    for (const deviceId of deviceIds) {
                        publishDeviceCommand(deviceId);
                    }
                }
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
        for (const deviceId of deviceToKeys.keys()) {
            publishDeviceCommand(deviceId);
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
