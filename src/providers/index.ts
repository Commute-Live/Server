import type { ProviderPlugin } from "../types.ts";

export const buildKey = (providerId: string, type: string, params: Record<string, string>): string => {
    const normalized = Object.entries(params)
        .map(([k, v]) => [k.trim().toLowerCase(), encodeURIComponent(String(v).trim())] as const)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(";");
    return `${providerId}:${type}:${normalized}`;
};

export const parseKeySegments = (key: string) => {
    const [providerId, type, paramString] = key.split(":", 3);
    if (!providerId || !type || paramString === undefined) {
        throw new Error(`Invalid key format: ${key}`);
    }
    const params: Record<string, string> = {};
    if (paramString.length) {
        paramString.split(";").forEach((pair) => {
            const [k, v] = pair.split("=");
            if (k) params[k] = decodeURIComponent(v ?? "");
        });
    }
    return { providerId, type, params };
};

export const providerRegistry = new Map<string, ProviderPlugin>();

export const registerProvider = (plugin: ProviderPlugin) => {
    providerRegistry.set(plugin.providerId, plugin);
};
