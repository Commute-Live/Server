import { cacheMap, getCacheEntry, loadActiveDeviceIds, markDeviceActiveInCache, markDeviceInactiveInCache, markExpired, setCacheEntry } from "./cache.ts";
import type { AggregatorEngine, FanoutMap, ProviderPlugin, Subscription } from "./types.ts";
import { providerRegistry, parseKeySegments } from "./providers/index.ts";
import { resolveStopName } from "./gtfs/stops_lookup.ts";
import { resolveDirectionLabel } from "./transit/direction_label.ts";
import { metrics } from "./metrics.ts";
import { logger } from "./logger.ts";
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
    logger.debug({ topic, payload }, "publish");
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
            logger.warn({ provider: sub.provider, deviceId: sub.deviceId }, "unknown provider");
            continue;
        }
        if (!provider.supports(sub.type)) {
            logger.warn({ provider: sub.provider, type: sub.type }, "provider does not support type");
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
            status: typeof row.status === "string" ? row.status : undefined,
            direction: typeof row.direction === "string" ? row.direction : undefined,
            line: typeof row.line === "string" ? row.line : undefined,
        };
    });
};

const stripArrivalTimeForDevice = (
    arrivals: Array<{ arrivalTime?: string; delaySeconds?: number; destination?: string; status?: string; direction?: string; line?: string }>,
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
            delaySeconds: typeof arrival.delaySeconds === "number" ? arrival.delaySeconds : undefined,
            destination: arrival.destination ?? fallbackDestination,
            status: arrival.status,
            direction: arrival.direction,
            line: arrival.line,
            eta,
        };
    });

    while (normalized.length < MAX_ARRIVALS_PER_LINE) {
        normalized.push({
            delaySeconds: undefined,
            destination: fallbackDestination,
            status: undefined,
            direction: undefined,
            line: undefined,
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
    status?: string;
    nextArrivals: Array<{ delaySeconds?: number; destination?: string; status?: string; direction?: string; line?: string; eta?: string }>;
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
    const status = nextArrivals.find((item) => typeof item.status === "string" && item.status.length > 0)?.status;

    return {
        provider: typeof body.provider === "string" && body.provider.length > 0 ? body.provider : providerId,
        line: line || undefined,
        stop: stopName ?? stopId,
        stopId,
        direction,
        directionLabel: directionLabel || undefined,
        status,
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
    const linesForDevice = lines.map(({ provider, stop, stopId, eta, ...rest }) => rest);
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
    const onlineDevices = new Set<string>();
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
                logger.warn({ key }, "no provider found for key");
                return;
            }
            const now = Date.now();
            const providerTag = `provider:${providerId}`;
            try {
                const fetchStart = Date.now();
                const result = await provider.fetch(key, {
                    now,
                    key,
                    log: (...args: unknown[]) => logger.debug({ key }, String(args[0] ?? "")),
                });
                metrics.histogram("engine.fetch.duration", Date.now() - fetchStart, [providerTag]);
                await setCacheEntry(key, result.payload, result.ttlSeconds, now);
                const deviceIds = fanout.get(key);
                if (deviceIds?.size) {
                    for (const deviceId of deviceIds) {
                        if (!onlineDevices.has(deviceId)) continue;
                        await publishDeviceCommand(deviceId);
                    }
                }
            } catch (err) {
                logger.error({ key, err }, "fetch failed");
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
            metrics.gauge("engine.devices.active", onlineDevices.size);
            for (const [key, deviceIds] of fanout.entries()) {
                const anyActive = [...deviceIds].some((id) => onlineDevices.has(id));
                if (!anyActive) continue;
                const entry = await getCacheEntry(key);
                const expired = !entry || entry.expiresAt <= now;
                if (expired) {
                    const ttlRemaining = entry ? entry.expiresAt - now : -1;
                    logger.debug({ key, ttlRemaining, hasEntry: !!entry }, "cache miss");
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
            for (const deviceId of allDeviceIds) {
                if (!onlineDevices.has(deviceId)) continue;
                await publishDeviceCommand(deviceId);
            }
        } finally {
            pushLoopRunning = false;
        }
    };

    const rebuildMaps = async () => {
        const subs = await loadSubscriptions();
        const activeSubs = subs.filter((sub) => onlineDevices.has(sub.deviceId));
        const maps = buildFanoutMaps(activeSubs, providers);
        fanout = maps.fanout;
        deviceToKeys = maps.deviceToKeys;
        deviceOptions = maps.deviceOptions;
        metrics.gauge("engine.devices.registered", deviceToKeys.size);
        metrics.gauge("engine.fanout.keys", fanout.size);
    };

    const rebuild = async () => {
        await rebuildMaps();
        await scheduleFetches();
    };

    const ready = loadActiveDeviceIds()
        .then((persisted) => {
            for (const deviceId of persisted) {
                onlineDevices.add(deviceId);
            }
            logger.info({ count: persisted.size }, "restored active devices from Redis");
        })
        .catch((err) => logger.error({ err }, "failed to restore active devices from Redis"))
        .then(() => rebuild());

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
        await markDeviceActive(deviceId);
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

    const markDeviceActive = async (deviceId: string): Promise<void> => {
        onlineDevices.add(deviceId);
        markDeviceActiveInCache(deviceId).catch((err) => logger.error({ err, deviceId }, "failed to persist device active state"));
        await rebuildMaps();
    };

    const markDeviceInactive = async (deviceId: string): Promise<void> => {
        onlineDevices.delete(deviceId);
        markDeviceInactiveInCache(deviceId).catch((err) => logger.error({ err, deviceId }, "failed to persist device inactive state"));
        await rebuildMaps();
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
