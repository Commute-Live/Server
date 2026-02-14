export type NycBusStop = {
    stopId: string;
    stop: string;
    direction: "";
};

const MTA_BUS_BASE = "https://bustime.mta.info/api/where";

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
