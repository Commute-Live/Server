import type { FetchContext, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";
import { fetchSeptaSurfaceArrivals } from "./bus.ts";

export const septaTrolleyProvider: ProviderPlugin = {
    providerId: "septa-trolley",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("septa-trolley", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) =>
        fetchSeptaSurfaceArrivals(key, ctx, "septa-trolley"),
};

registerProvider(septaTrolleyProvider);
