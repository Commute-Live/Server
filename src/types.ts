export type Subscription = {
    deviceId: string;
    provider: string;
    type: string;
    config: Record<string, string>;
    displayType?: number;
    scrolling?: boolean;
};

export type LineConfig = {
    provider: string;
    line: string;
    stop?: string;
    direction?: string;
    displayType?: number;
    scrolling?: boolean;
};

export type DeviceConfig = {
    brightness?: number;
    displayType?: number;
    scrolling?: boolean;
    lines?: LineConfig[];
};

export type CacheEntry = {
    payload: unknown;
    fetchedAt: number;
    expiresAt: number;
};

export type FetchContext = {
    now: number;
    key: string;
    log: (...args: unknown[]) => void;
};

export type FetchResult = {
    payload: unknown;
    ttlSeconds: number;
};

export interface ProviderPlugin {
    providerId: string;
    supports(type: string): boolean;
    toKey(input: { type: string; config: Record<string, string> }): string;
    parseKey(key: string): { type: string; params: Record<string, string> };
    fetch(key: string, ctx: FetchContext): Promise<FetchResult>;
}

export type FanoutMap = Map<string, Set<string>>;

export interface AggregatorEngine {
    refreshKey(key: string): Promise<void>;
    refreshDevice(deviceId: string): Promise<void>;
    reloadSubscriptions(): Promise<void>;
    getFanout(): FanoutMap;
    getCache(): Map<string, CacheEntry>;
    stop(): void;
    ready: Promise<void>;
}
