import { cacheMap, getCacheEntry, getActiveDeviceIds, markDeviceActiveInCache, markDeviceInactiveInCache, markExpired, setCacheEntry } from "./cache.ts";
import type { AggregatorEngine, FanoutMap, ProviderPlugin, Subscription } from "./types.ts";
import { providerRegistry, parseKeySegments } from "./providers/index.ts";
import { resolveStopName } from "./gtfs/stops_lookup.ts";
import { resolveDirectionLabel } from "./transit/direction_label.ts";
import { metrics } from "./metrics.ts";
import "./providers/register.ts";

type EngineOptions = {
    providers?: Map<string, ProviderPlugin>;
    loadSubscriptions: () => Promise<Subscription[]>;
    refreshIntervalMs?: number;
    pushIntervalMs?: number;
    publish?: (topic: string, payload: unknown) => void;
};

type DeviceOptions = {
    displayType: number;
    scrolling: boolean;
    arrivalsToDisplay: number;
};

const defaultPublish = (topic: string, payload: unknown) => {
    console.log("[PUBLISH]", topic, JSON.stringify(payload));
};

const MAX_ARRIVALS_PER_LINE = 3;
const clampArrivalsToDisplay = (value: unknown) => {
    if (typeof value !== "number" || Number.isNaN(value)) return 1;
    if (value < 1) return 1;
    if (value > 3) return 3;
    return Math.trunc(value);
};

// Creates Key --> DeviceIds && DeviceIds --> Keys
const buildFanoutMaps = (subs: Subscription[], providers: Map<string, ProviderPlugin>) => {
    const fanout: FanoutMap = new Map();
    const deviceToKeys = new Map<string, Set<string>>();
    const deviceOptions = new Map<string, DeviceOptions>();

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

        if (!deviceOptions.has(sub.deviceId)) {
            deviceOptions.set(sub.deviceId, {
                displayType: typeof sub.displayType === "number" ? sub.displayType : 1,
                scrolling: typeof sub.scrolling === "boolean" ? sub.scrolling : false,
                arrivalsToDisplay: clampArrivalsToDisplay(sub.arrivalsToDisplay),
            });
        }
    }

    return { fanout, deviceToKeys, deviceOptions };
};

const extractNextArrivals = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return [];
    const body = payload as Record<string, unknown>;
    const arrivalsRaw = body.arrivals;
    if (!Array.isArray(arrivalsRaw)) return [];

    return arrivalsRaw.slice(0, MAX_ARRIVALS_PER_LINE).map((item) => {
        const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        return {
            arrivalTime: typeof row.arrivalTime === "string" ? row.arrivalTime : undefined,
            delaySeconds: typeof row.delaySeconds === "number" ? row.delaySeconds : undefined,
            destination: typeof row.destination === "string" ? row.destination : undefined,
        };
    });
};

const stripArrivalTimeForDevice = (
    arrivals: Array<{ arrivalTime?: string; delaySeconds?: number; destination?: string }>,
    fetchedAt?: string,
    fallbackDestination?: string,
) => {
    const baseline = parseIsoMs(fetchedAt) ?? Date.now();
    const normalized = arrivals.map((arrival) => {
        let eta = "--";
        const ts = parseIsoMs(arrival.arrivalTime);
        if (ts !== undefined) {
            const diffSec = Math.max(0, Math.floor((ts - baseline) / 1000));
            const mins = Math.floor((diffSec + 59) / 60);
            eta = mins <= 1 ? "DUE" : `${mins}m`;
        }

        return {
            delaySeconds: typeof arrival.delaySeconds === "number" ? arrival.delaySeconds : 0,
            destination: arrival.destination ?? fallbackDestination,
            eta,
        };
    });

    while (normalized.length < MAX_ARRIVALS_PER_LINE) {
        normalized.push({
            delaySeconds: 0,
            destination: fallbackDestination,
            eta: "--",
        });
    }

    return normalized.slice(0, MAX_ARRIVALS_PER_LINE);
};

const parseIsoMs = (value?: string) => {
    if (!value) return undefined;
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : undefined;
};

const etaTextFromArrivals = (
    arrivals: Array<{ arrivalTime?: string; delaySeconds?: number; destination?: string }>,
    fetchedAt?: string,
) => {
    if (!arrivals.length) return "--";

    const baseline = parseIsoMs(fetchedAt) ?? Date.now();
    let sawDue = false;

    for (const arrival of arrivals) {
        const ts = parseIsoMs(arrival.arrivalTime);
        if (ts === undefined) continue;
        const diffSec = Math.max(0, Math.floor((ts - baseline) / 1000));
        const mins = Math.floor((diffSec + 59) / 60);
        if (mins <= 1) {
            sawDue = true;
            continue;
        }
        return `${mins}m`;
    }

    return sawDue ? "DUE" : "--";
};

type DeviceLinePayload = {
    provider?: string;
    line?: string;
    stop?: string;
    stopId?: string;
    direction?: string;
    directionLabel?: string;
    nextArrivals: Array<{ delaySeconds?: number; destination?: string; eta?: string }>;
    destination?: string;
    eta?: string;
};

const buildDeviceLinePayload = (key: string, payload: unknown): DeviceLinePayload => {
    const { providerId, params } = parseKeySegments(key);
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
    const stopFromPayload = typeof body.stop === "string" && body.stop.length > 0 ? body.stop : undefined;
    const stopNameFromPayload = typeof body.stopName === "string" && body.stopName.length > 0 ? body.stopName : undefined;
    const stopName =
        stopNameFromPayload ??
        (stopFromPayload && stopFromPayload !== stopId ? stopFromPayload : undefined) ??
        (stopId ? resolveStopName(stopId) : undefined);
    const directionFromPayload = typeof body.direction === "string" ? body.direction : undefined;
    const directionFromKey = typeof params.direction === "string" && params.direction.length > 0 ? params.direction : undefined;
    const direction = directionFromPayload ?? directionFromKey;
    const directionLabelFromPayload =
        typeof body.directionLabel === "string" && body.directionLabel.length > 0 ? body.directionLabel : undefined;
    const directionLabel =
        directionLabelFromPayload ??
        resolveDirectionLabel({
            line: line || undefined,
            direction,
            stop: stopName,
        });

    const fetchedAt = typeof body.fetchedAt === "string" ? body.fetchedAt : new Date().toISOString();
    const nextArrivals = extractNextArrivals(payload);
    const eta = etaTextFromArrivals(nextArrivals, fetchedAt);

    return {
        provider: typeof body.provider === "string" && body.provider.length > 0 ? body.provider : providerId,
        line: line || undefined,
        stop: stopName ?? stopId,
        stopId,
        direction,
        directionLabel: directionLabel || undefined,
        destination:
            typeof body.destination === "string" && body.destination.length > 0
                ? body.destination
                : undefined,
        nextArrivals: stripArrivalTimeForDevice(
            nextArrivals,
            fetchedAt,
            typeof body.destination === "string" && body.destination.length > 0
                ? body.destination
                : undefined,
        ),
        eta,
    };
};

const buildDeviceCommandPayload = async (keys: Set<string>, deviceOptions?: DeviceOptions) => {
    const lines: DeviceLinePayload[] = [];

    for (const key of keys.values()) {
        const entry = await getCacheEntry(key);
        if (!entry) continue;
        const linePayload = buildDeviceLinePayload(key, entry.payload);
        if (!linePayload.line) continue;
        lines.push(linePayload);
    }

    lines.sort((a, b) => (a.line ?? "").localeCompare(b.line ?? ""));

    const primary = lines[0];
    const linesForDevice = lines.map(({ provider, stop, stopId, direction, eta, ...rest }) => rest);
    return {
        displayType: deviceOptions?.displayType ?? 1,
        scrolling: deviceOptions?.scrolling ?? false,
        arrivalsToDisplay: clampArrivalsToDisplay(deviceOptions?.arrivalsToDisplay),
        provider: primary?.provider,
        stop: primary?.stop,
        stopId: primary?.stopId,
        direction: primary?.direction,
        directionLabel: primary?.directionLabel,
        destination: primary?.destination,
        lines: linesForDevice,
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
    let deviceOptions = new Map<string, DeviceOptions>();
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let pushTimer: ReturnType<typeof setInterval> | null = null;
    let refreshLoopRunning = false;
    let pushLoopRunning = false;

    const publishDeviceCommand = async (deviceId: string) => {
        const keys = deviceToKeys.get(deviceId);
        if (!keys?.size) {
            return;
        }

        const command = await buildDeviceCommandPayload(keys, deviceOptions.get(deviceId));
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
            const providerTag = `provider:${providerId}`;
            try {
                const fetchStart = Date.now();
                const result = await provider.fetch(key, {
                    now,
                    key,
                    log: (...args: unknown[]) => console.log("[FETCH]", key, ...args),
                });
                metrics.histogram("engine.fetch.duration", Date.now() - fetchStart, [providerTag]);
                await setCacheEntry(key, result.payload, result.ttlSeconds, now);
                const deviceIds = fanout.get(key);
                if (deviceIds?.size) {
                    const activeIds = await getActiveDeviceIds([...deviceIds]);
                    for (const deviceId of deviceIds) {
                        if (!activeIds.has(deviceId)) continue;
                        await publishDeviceCommand(deviceId);
                    }
                }
            } catch (err) {
                console.error(`[ENGINE] fetch failed for key ${key}:`, err);
                metrics.increment("engine.fetch.error", [providerTag]);
            } finally {
                inflight.delete(key);
            }
        })();

        inflight.set(key, work);
        return work;
    };

    const scheduleFetches = async () => {
        if (refreshLoopRunning) return;
        refreshLoopRunning = true;
        const now = Date.now();
        try {
            const allDeviceIds = [...deviceToKeys.keys()];
            const activeIds = await getActiveDeviceIds(allDeviceIds);
            for (const [key, deviceIds] of fanout.entries()) {
                const anyActive = [...deviceIds].some((id) => activeIds.has(id));
                if (!anyActive) continue;
                const entry = await getCacheEntry(key);
                const expired = !entry || entry.expiresAt <= now;
                if (expired) {
                    const ttlRemaining = entry ? entry.expiresAt - now : -1;
                    console.log(`[ENGINE] cache miss for ${key} (ttlRemaining=${ttlRemaining}ms, hasEntry=${!!entry})`);
                    metrics.increment("engine.cache.miss");
                    void fetchKey(key);
                } else {
                    metrics.increment("engine.cache.hit");
                }
            }
            metrics.gauge("engine.inflight", inflight.size);
        } finally {
            refreshLoopRunning = false;
        }
    };

    const pushCachedPayloads = async () => {
        if (pushLoopRunning) return;
        pushLoopRunning = true;
        try {
            const allDeviceIds = [...deviceToKeys.keys()];
            const activeIds = await getActiveDeviceIds(allDeviceIds);
            for (const deviceId of allDeviceIds) {
                if (!activeIds.has(deviceId)) continue;
                await publishDeviceCommand(deviceId);
            }
        } finally {
            pushLoopRunning = false;
        }
    };

    const rebuild = async () => {
        const subs = await loadSubscriptions();
        const maps = buildFanoutMaps(subs, providers);
        fanout = maps.fanout;
        deviceToKeys = maps.deviceToKeys;
        deviceOptions = maps.deviceOptions;
        metrics.gauge("engine.devices.active", deviceToKeys.size);
        metrics.gauge("engine.fanout.keys", fanout.size);
        await scheduleFetches();
    };

    const ready = rebuild();

    refreshTimer = setInterval(() => {
        void scheduleFetches();
    }, refreshIntervalMs);
    pushTimer = setInterval(() => {
        void pushCachedPayloads();
    }, pushIntervalMs);

    const refreshKey = async (key: string) => {
        const now = Date.now();
        await markExpired(key, now);
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
            await markExpired(key, now);
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

    const markDeviceActive = (deviceId: string): Promise<void> => {
        return markDeviceActiveInCache(deviceId);
    };

    const markDeviceInactive = (deviceId: string): Promise<void> => {
        return markDeviceInactiveInCache(deviceId);
    };

    return {
        refreshKey,
        refreshDevice,
        reloadSubscriptions,
        markDeviceActive,
        markDeviceInactive,
        getFanout: () => fanout,
        getCache: () => cacheMap(),
        stop,
        ready,
    };
}
