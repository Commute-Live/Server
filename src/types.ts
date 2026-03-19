export type Subscription = {
    deviceId: string;
    provider: string;
    type: string;
    config: Record<string, string>;
    displayType?: number;
    scrolling?: boolean;
    arrivalsToDisplay?: number;
    lineConfig?: LineConfig;
};

export type DisplayWeekday =
    | "sun"
    | "mon"
    | "tue"
    | "wed"
    | "thu"
    | "fri"
    | "sat";

export type LineConfig = {
    provider: string;
    line: string;
    stop?: string;
    direction?: string;
    displayType?: number;
    scrolling?: boolean;
    label?: string;
    secondaryLabel?: string;
    topText?: string;
    bottomText?: string;
    textColor?: string;
    nextStops?: number;
    displayFormat?: string;
    primaryContent?: string;
    secondaryContent?: string;
};

export type DeviceConfig = {
    brightness?: number;
    displayType?: number;
    scrolling?: boolean;
    arrivalsToDisplay?: number;
    lines?: LineConfig[];
};

export type DeviceDisplay = {
    displayId: string;
    deviceId: string;
    name: string;
    paused: boolean;
    priority: number;
    sortOrder: number;
    scheduleStart: string | null;
    scheduleEnd: string | null;
    scheduleDays: DisplayWeekday[];
    config: DeviceConfig;
    createdAt: string;
    updatedAt: string;
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
    markDeviceActive(deviceId: string): Promise<void>;
    markDeviceInactive(deviceId: string): Promise<void>;
    getFanout(): FanoutMap;
    getCache(): Promise<Map<string, CacheEntry>>;
    stop(): void;
    ready: Promise<void>;
}
