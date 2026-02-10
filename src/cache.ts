import type { CacheEntry } from "./types.ts";

const cache = new Map<string, CacheEntry>();

export const getCacheEntry = (key: string) => cache.get(key);

export const setCacheEntry = (key: string, payload: unknown, ttlSeconds: number, now: number) => {
    cache.set(key, {
        payload,
        fetchedAt: now,
        expiresAt: now + ttlSeconds * 1000,
    });
};

export const markExpired = (key: string, now: number) => {
    const entry = cache.get(key);
    if (entry) {
        entry.expiresAt = now;
    } else {
        cache.set(key, { payload: null, fetchedAt: now, expiresAt: now });
    }
};

export const cacheMap = () => cache;
