export type NycBusStop = {
    stopId: string;
    stop: string;
    direction: "";
};

export type NycBusRoute = {
    id: string;
    label: string;
};

const MTA_BUS_BASE = "https://bustime.mta.info/api/where";
const BUS_ROUTES_CACHE_TTL_MS = 10 * 60 * 1000;
let busRoutesCache: { expiresAt: number; routes: NycBusRoute[] } | null = null;

export const normalizeMtaBusRoute = (route: string) => route.trim().toUpperCase();

type StopsForRouteResponse = {
    code?: number;
    text?: string;
    data?: {
        references?: {
            stops?: Array<{
                id?: string;
                name?: string;
            }>;
        };
        list?: Array<{
            id?: string;
            name?: string;
        }>;
        stops?: Array<{
            id?: string;
            name?: string;
        }>;
    };
};

type RoutesForAgencyResponse = {
    code?: number;
    text?: string;
    data?: {
        list?: Array<{
            id?: string;
            shortName?: string;
            longName?: string;
            description?: string;
        }>;
        references?: {
            routes?: Array<{
                id?: string;
                shortName?: string;
                longName?: string;
                description?: string;
            }>;
        };
    };
};

const uniqueStops = (stops: NycBusStop[]) => {
    const seen = new Set<string>();
    const out: NycBusStop[] = [];
    for (const stop of stops) {
        const key = `${stop.stopId}|${stop.stop}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(stop);
    }
    out.sort((a, b) => {
        const byName = a.stop.localeCompare(b.stop);
        if (byName !== 0) return byName;
        return a.stopId.localeCompare(b.stopId);
    });
    return out;
};

const mapStops = (items: Array<{ id?: string; name?: string }> | undefined): NycBusStop[] =>
    (items ?? [])
        .map((s) => ({
            stopId: (s.id ?? "").trim(),
            stop: (s.name ?? s.id ?? "").trim(),
            direction: "",
        }))
        .filter((s) => s.stopId.length > 0 && s.stop.length > 0);

const fetchStopsForRouteId = async (apiKey: string, routeId: string): Promise<NycBusStop[]> => {
    const search = new URLSearchParams({
        key: apiKey,
    });
    const url = `${MTA_BUS_BASE}/stops-for-route/${encodeURIComponent(routeId)}.json?${search.toString()}`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const json = (await res.json()) as StopsForRouteResponse;
    const fromReferences = mapStops(json?.data?.references?.stops);
    const fromList = mapStops(json?.data?.list);
    const fromStops = mapStops(json?.data?.stops);
    return uniqueStops([...fromReferences, ...fromList, ...fromStops]);
};

const normalizeRouteLabel = (route: { id?: string; shortName?: string; longName?: string; description?: string }): NycBusRoute | null => {
    const id = (route.id ?? "").trim();
    if (!id) return null;

    // Use shortName as primary line code when available, fallback to id suffix after underscore.
    const short = (route.shortName ?? "").trim();
    const fromId = id.includes("_") ? id.split("_").pop() ?? id : id;
    const lineId = (short || fromId).trim().toUpperCase();
    if (!lineId) return null;

    const longName = (route.longName ?? route.description ?? "").trim();
    const label = longName.length > 0 ? `${lineId} - ${longName}` : lineId;
    return { id: lineId, label };
};

export const listMtaBusRoutes = async (): Promise<NycBusRoute[]> => {
    const now = Date.now();
    if (busRoutesCache && busRoutesCache.expiresAt > now) {
        return busRoutesCache.routes;
    }

    const apiKey = process.env.MTA_BUS_API_KEY;
    if (!apiKey) {
        throw new Error("MTA BusTime API key is required (set MTA_BUS_API_KEY)");
    }

    const search = new URLSearchParams({ key: apiKey });
    const url = `${MTA_BUS_BASE}/routes-for-agency/MTA%20NYCT.json?${search.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`BusTime routes-for-agency error ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as RoutesForAgencyResponse;
    const rawRoutes = [
        ...(json?.data?.list ?? []),
        ...(json?.data?.references?.routes ?? []),
    ];

    const map = new Map<string, NycBusRoute>();
    for (const raw of rawRoutes) {
        const normalized = normalizeRouteLabel(raw);
        if (!normalized) continue;
        if (!map.has(normalized.id)) {
            map.set(normalized.id, normalized);
        }
    }

    const routes = Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
    busRoutesCache = { expiresAt: now + BUS_ROUTES_CACHE_TTL_MS, routes };
    return routes;
};

export const listMtaBusStopsForRoute = async (route: string): Promise<NycBusStop[]> => {
    const normalizedRoute = normalizeMtaBusRoute(route);
    if (!normalizedRoute) return [];

    const apiKey = process.env.MTA_BUS_API_KEY;
    if (!apiKey) {
        throw new Error("MTA BusTime API key is required (set MTA_BUS_API_KEY)");
    }

    // Different deployments use different route ids; try common variants.
    const candidates = [
        normalizedRoute,
        `MTA NYCT_${normalizedRoute}`,
        `MTABC_${normalizedRoute}`,
    ];

    for (const routeId of candidates) {
        const stops = await fetchStopsForRouteId(apiKey, routeId);
        if (stops.length > 0) return stops;
    }

    return [];
};
