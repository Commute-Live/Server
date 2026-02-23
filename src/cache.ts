import { createClient, commandOptions } from "redis";
import type { CacheEntry } from "./types.ts";

const CACHE_PREFIX = "commutelive:arrivals-cache:";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
type RedisClient = ReturnType<typeof createClient>;

let redisClient: RedisClient | null = null;
let connectPromise: Promise<RedisClient> | null = null;

const toRedisKey = (key: string) => `${CACHE_PREFIX}${key}`;

const fromRedisKey = (redisKey: string) => redisKey.slice(CACHE_PREFIX.length);

const parseEntry = (raw: string | null): CacheEntry | null => {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<CacheEntry> | null;
        if (!parsed || typeof parsed !== "object") return null;
        if (typeof parsed.fetchedAt !== "number") return null;
        if (typeof parsed.expiresAt !== "number") return null;
        return {
            payload: parsed.payload,
            fetchedAt: parsed.fetchedAt,
            expiresAt: parsed.expiresAt,
        };
    } catch {
        return null;
    }
};

const getRedisClient = async (): Promise<RedisClient> => {
    if (redisClient?.isOpen) {
        return redisClient;
    }
    if (connectPromise) {
        return connectPromise;
    }

    const client = createClient({ url: REDIS_URL });
    client.on("error", (err) => {
        console.error("[CACHE] Redis error:", err.message);
    });

    connectPromise = client
        .connect()
        .then(() => {
            redisClient = client;
            connectPromise = null;
            return client;
        })
        .catch((err) => {
            connectPromise = null;
            throw err;
        });

    const connected = await connectPromise;
    return connected;
};

export const initCache = async () => {
    const client = await getRedisClient();
    await client.ping();
    console.log(`[CACHE] Redis connected: ${REDIS_URL}`);
};

export const getCacheEntry = async (key: string): Promise<CacheEntry | null> => {
    const client = await getRedisClient();
    const raw = await client.get(toRedisKey(key));
    return parseEntry(raw);
};

export const setCacheEntry = async (
    key: string,
    payload: unknown,
    ttlSeconds: number,
    now: number,
): Promise<void> => {
    const client = await getRedisClient();
    const entry: CacheEntry = {
        payload,
        fetchedAt: now,
        expiresAt: now + ttlSeconds * 1000,
    };
    await client.set(toRedisKey(key), JSON.stringify(entry), {
        EX: Math.max(1, Math.floor(ttlSeconds)),
    });
};

export const markExpired = async (key: string, now: number): Promise<void> => {
    const client = await getRedisClient();
    const existing = await getCacheEntry(key);
    if (existing) {
        const keepSeconds = Math.max(1, Math.ceil((existing.expiresAt - now) / 1000));
        const entry: CacheEntry = {
            ...existing,
            expiresAt: now,
        };
        await client.set(toRedisKey(key), JSON.stringify(entry), { EX: keepSeconds });
        return;
    }

    const placeholder: CacheEntry = {
        payload: null,
        fetchedAt: now,
        expiresAt: now,
    };
    await client.set(toRedisKey(key), JSON.stringify(placeholder), { EX: 5 });
};

// ── Provider-level cache helpers ─────────────────────────────────────────────
const PROVIDER_PREFIX = "commutelive:provider:";

export const getProviderCache = async <T>(key: string): Promise<T | null> => {
    const client = await getRedisClient();
    const raw = await client.get(`${PROVIDER_PREFIX}${key}`);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
};

export const setProviderCache = async <T>(key: string, value: T, ttlSeconds: number): Promise<void> => {
    const client = await getRedisClient();
    await client.set(`${PROVIDER_PREFIX}${key}`, JSON.stringify(value), {
        EX: Math.max(1, Math.floor(ttlSeconds)),
    });
};

export const getProviderCacheBuffer = async (key: string): Promise<Buffer | null> => {
    const client = await getRedisClient();
    const raw = await client.get(commandOptions({ returnBuffers: true }), `${PROVIDER_PREFIX}${key}`);
    if (!raw || typeof raw === "string") return null;
    return Buffer.from(raw);
};

export const setProviderCacheBuffer = async (key: string, value: Buffer, ttlSeconds: number): Promise<void> => {
    const client = await getRedisClient();
    await client.set(`${PROVIDER_PREFIX}${key}`, value, {
        EX: Math.max(1, Math.floor(ttlSeconds)),
    });
};

// ── Device activity helpers ───────────────────────────────────────────────────
const deviceActiveKey = (deviceId: string) => `device:active:${deviceId}`;

export async function markDeviceActiveInCache(deviceId: string): Promise<void> {
    const client = await getRedisClient();
    await client.set(deviceActiveKey(deviceId), "1");
}

export async function markDeviceInactiveInCache(deviceId: string): Promise<void> {
    const client = await getRedisClient();
    await client.del(deviceActiveKey(deviceId));
}

export async function getActiveDeviceIds(deviceIds: string[]): Promise<Set<string>> {
    if (deviceIds.length === 0) return new Set();
    const client = await getRedisClient();
    const results = await Promise.all(deviceIds.map((id) => client.exists(deviceActiveKey(id))));
    const active = new Set<string>();
    deviceIds.forEach((id, i) => {
        if (results[i] === 1) active.add(id);
    });
    return active;
}

export const cacheMap = async (): Promise<Map<string, CacheEntry>> => {
    const client = await getRedisClient();
    const result = new Map<string, CacheEntry>();

    const redisKeys: string[] = [];
    for await (const key of client.scanIterator({ MATCH: `${CACHE_PREFIX}*`, COUNT: 100 })) {
        redisKeys.push(key);
    }
    if (!redisKeys.length) return result;

    const values = await client.mGet(redisKeys);
    values.forEach((raw, idx) => {
        const parsed = parseEntry(raw);
        if (!parsed) return;
        const redisKey = redisKeys[idx];
        if (!redisKey) return;
        result.set(fromRedisKey(redisKey), parsed);
    });

    return result;
};
