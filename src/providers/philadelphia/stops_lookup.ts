export type SeptaRouteOption = { id: string; label: string };
export type SeptaStopOption = { stopId: string; stop: string };

const SEPTA_BASE = "https://www3.septa.org/api";
const CACHE_TTL_MS = 5 * 60_000;

const jsonCache = new Map<string, { expiresAt: number; value: unknown }>();

const normalizeKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const normalizeText = (value: string) => value.trim().toLowerCase();

const normalizeRailRoute = (value: string) =>
    value
        .trim()
        .toUpperCase()
        .replace(/\s+LINE$/i, "")
        .replace(/\s+/g, " ");

const normalizeBusRoute = (value: string) =>
    value
        .trim()
        .toUpperCase()
        .replace(/\s+/g, " ");

const parseJsonSafe = (input: string): unknown => {
    try {
        return JSON.parse(input);
    } catch {
        return [];
    }
};

const toRecords = (input: unknown): Array<Record<string, unknown>> => {
    if (Array.isArray(input)) {
        return input.filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
    }
    if (!input || typeof input !== "object") return [];
    const obj = input as Record<string, unknown>;
    const out: Array<Record<string, unknown>> = [];
    for (const value of Object.values(obj)) {
        if (Array.isArray(value)) {
            out.push(
                ...value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object"),
            );
        } else if (value && typeof value === "object") {
            out.push(value as Record<string, unknown>);
        }
    }
    if (out.length > 0) return out;
    return [obj];
};

const readField = (record: Record<string, unknown>, keys: string[]) => {
    const wanted = new Set(keys.map(normalizeKey));
    for (const [k, v] of Object.entries(record)) {
        if (!wanted.has(normalizeKey(k))) continue;
        if (typeof v === "string") return v.trim();
        if (typeof v === "number") return String(v);
    }
    return "";
};

const dedupeRoutes = (routes: SeptaRouteOption[]) => {
    const map = new Map<string, SeptaRouteOption>();
    for (const route of routes) {
        const id = route.id.trim();
        if (!id) continue;
        if (!map.has(id)) map.set(id, { id, label: route.label || id });
    }
    return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
};

const dedupeStops = (stops: SeptaStopOption[]) => {
    const map = new Map<string, SeptaStopOption>();
    for (const stop of stops) {
        const id = stop.stopId.trim();
        if (!id) continue;
        if (!map.has(id)) map.set(id, { stopId: id, stop: stop.stop || id });
    }
    return Array.from(map.values()).sort((a, b) => a.stop.localeCompare(b.stop));
};

const filterRoutes = (routes: SeptaRouteOption[], q: string, limit: number) => {
    const needle = normalizeText(q);
    const filtered =
        needle.length > 0
            ? routes.filter(
                  (r) =>
                      normalizeText(r.id).includes(needle) ||
                      normalizeText(r.label).includes(needle),
              )
            : routes;
    return filtered.slice(0, Math.max(1, limit));
};

const filterStops = (stops: SeptaStopOption[], q: string, limit: number) => {
    const needle = normalizeText(q);
    const filtered =
        needle.length > 0
            ? stops.filter(
                  (s) =>
                      normalizeText(s.stopId).includes(needle) ||
                      normalizeText(s.stop).includes(needle),
              )
            : stops;
    return filtered.slice(0, Math.max(1, limit));
};

async function fetchJsonCached(url: string): Promise<unknown> {
    const hit = jsonCache.get(url);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SEPTA API error ${res.status} ${res.statusText}`);
    const text = await res.text();
    const parsed = parseJsonSafe(text);
    jsonCache.set(url, { expiresAt: Date.now() + CACHE_TTL_MS, value: parsed });
    return parsed;
}

async function fetchTransitViewAllRecords() {
    const url = `${SEPTA_BASE}/TransitViewAll/index.php`;
    const data = await fetchJsonCached(url);
    return toRecords(data);
}

async function fetchTrainViewRecords() {
    const url = `${SEPTA_BASE}/TrainView/index.php`;
    const data = await fetchJsonCached(url);
    return toRecords(data);
}

async function fetchBusScheduleRecords(route?: string) {
    const search = new URLSearchParams();
    if (route) search.set("req1", route);
    const suffix = search.toString();
    const url = `${SEPTA_BASE}/BusSchedules/index.php${suffix ? `?${suffix}` : ""}`;
    const data = await fetchJsonCached(url);
    return toRecords(data);
}

async function fetchRailScheduleRecords(route?: string) {
    const search = new URLSearchParams();
    if (route) search.set("req1", route);
    const suffix = search.toString();
    const url = `${SEPTA_BASE}/RRSchedules/index.php${suffix ? `?${suffix}` : ""}`;
    const data = await fetchJsonCached(url);
    return toRecords(data);
}

async function fetchStopsRecords(route: string) {
    const search = new URLSearchParams({ req1: route });
    const url = `${SEPTA_BASE}/Stops/index.php?${search.toString()}`;
    const data = await fetchJsonCached(url);
    return toRecords(data);
}

function parseRouteOptions(records: Array<Record<string, unknown>>, mode: "bus" | "rail"): SeptaRouteOption[] {
    const idCandidates = ["route_id", "route", "line", "line_id", "route_short_name"];
    const labelCandidates = ["route_long_name", "label", "line_name", "route_name", "line"];
    const routes: SeptaRouteOption[] = [];
    for (const record of records) {
        const idRaw = readField(record, idCandidates);
        if (!idRaw) continue;
        const id = mode === "rail" ? normalizeRailRoute(idRaw) : normalizeBusRoute(idRaw);
        if (!id) continue;
        const labelRaw = readField(record, labelCandidates);
        routes.push({ id, label: labelRaw || id });
    }
    return dedupeRoutes(routes);
}

function parseStopOptions(records: Array<Record<string, unknown>>): SeptaStopOption[] {
    const idCandidates = ["stop_id", "stopid", "id", "stop_code"];
    const nameCandidates = ["stop_name", "name", "stop", "station", "label"];
    const stops: SeptaStopOption[] = [];
    for (const record of records) {
        const stopId = readField(record, idCandidates);
        if (!stopId) continue;
        const stop = readField(record, nameCandidates) || stopId;
        stops.push({ stopId, stop });
    }
    return dedupeStops(stops);
}

async function fetchBusRoutesUnfiltered(): Promise<SeptaRouteOption[]> {
    try {
        const fromSchedules = parseRouteOptions(await fetchBusScheduleRecords(), "bus");
        if (fromSchedules.length > 0) return fromSchedules;
    } catch {
        // fall through
    }

    try {
        const fromTransit = parseRouteOptions(await fetchTransitViewAllRecords(), "bus");
        if (fromTransit.length > 0) return fromTransit;
    } catch {
        // ignore
    }

    return [];
}

async function fetchRailRoutesUnfiltered(): Promise<SeptaRouteOption[]> {
    try {
        const fromSchedules = parseRouteOptions(await fetchRailScheduleRecords(), "rail");
        if (fromSchedules.length > 0) return fromSchedules;
    } catch {
        // fall through
    }

    try {
        const fromTrainView = parseRouteOptions(await fetchTrainViewRecords(), "rail");
        if (fromTrainView.length > 0) return fromTrainView;
    } catch {
        // ignore
    }

    return [];
}

async function fetchBusStopsForRouteUnfiltered(route: string): Promise<SeptaStopOption[]> {
    const routeId = normalizeBusRoute(route);
    if (!routeId) return [];
    try {
        const fromStops = parseStopOptions(await fetchStopsRecords(routeId));
        if (fromStops.length > 0) return fromStops;
    } catch {
        // ignore
    }
    try {
        const fromSchedules = parseStopOptions(await fetchBusScheduleRecords(routeId));
        if (fromSchedules.length > 0) return fromSchedules;
    } catch {
        // ignore
    }
    return [];
}

async function fetchRailStopsUnfiltered(): Promise<SeptaStopOption[]> {
    const out: SeptaStopOption[] = [];
    try {
        const records = await fetchTrainViewRecords();
        for (const record of records) {
            for (const field of [
                "currentstop",
                "nextstop",
                "origin",
                "destination",
                "source",
                "dest",
                "station",
            ]) {
                const value = readField(record, [field]);
                if (!value) continue;
                out.push({ stopId: value, stop: value });
            }
        }
    } catch {
        // ignore
    }
    if (out.length > 0) return dedupeStops(out);

    try {
        const fromSchedules = parseStopOptions(await fetchRailScheduleRecords());
        if (fromSchedules.length > 0) return fromSchedules;
    } catch {
        // ignore
    }
    return [];
}

async function fetchRailStopsForRouteUnfiltered(route: string): Promise<SeptaStopOption[]> {
    const routeId = normalizeRailRoute(route);
    if (!routeId) return [];
    try {
        const fromSchedules = parseStopOptions(await fetchRailScheduleRecords(routeId));
        if (fromSchedules.length > 0) return fromSchedules;
    } catch {
        // ignore
    }
    return fetchRailStopsUnfiltered();
}

async function fetchRailArrivalsLinesForStop(stopOrName: string): Promise<string[]> {
    const station = resolveSeptaRailStopName(stopOrName);
    if (!station) return [];
    const search = new URLSearchParams({ station, results: "60" });
    const url = `${SEPTA_BASE}/Arrivals/index.php?${search.toString()}`;
    try {
        const data = await fetchJsonCached(url);
        if (!data || typeof data !== "object") return [];
        const root = data as Record<string, unknown>;
        const firstKey = Object.keys(root)[0];
        if (!firstKey) return [];
        const firstArray = root[firstKey];
        if (!Array.isArray(firstArray) || firstArray.length === 0) return [];
        const first = firstArray[0];
        if (!first || typeof first !== "object") return [];
        const body = first as Record<string, unknown>;
        const lines = new Set<string>();
        for (const dir of ["Northbound", "Southbound"]) {
            const items = body[dir];
            if (!Array.isArray(items)) continue;
            for (const item of items) {
                if (!item || typeof item !== "object") continue;
                const line = readField(item as Record<string, unknown>, ["line"]);
                const normalized = normalizeRailRoute(line);
                if (normalized) lines.add(normalized);
            }
        }
        return Array.from(lines).sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

export async function listSeptaBusRoutes(q = "", limit = 300): Promise<SeptaRouteOption[]> {
    return filterRoutes(await fetchBusRoutesUnfiltered(), q, limit);
}

export async function listSeptaRailRoutes(q = "", limit = 300): Promise<SeptaRouteOption[]> {
    return filterRoutes(await fetchRailRoutesUnfiltered(), q, limit);
}

export async function listSeptaBusStopsForRoute(route: string, limit = 300): Promise<SeptaStopOption[]> {
    return filterStops(await fetchBusStopsForRouteUnfiltered(route), "", limit);
}

export async function listSeptaRailStopsForRoute(route: string, limit = 300): Promise<SeptaStopOption[]> {
    return filterStops(await fetchRailStopsForRouteUnfiltered(route), "", limit);
}

export async function listSeptaBusStops(q = "", limit = 300): Promise<SeptaStopOption[]> {
    const routes = await fetchBusRoutesUnfiltered();
    const topRoutes = routes.slice(0, 40);
    const allStops = await Promise.all(topRoutes.map((r) => fetchBusStopsForRouteUnfiltered(r.id)));
    return filterStops(dedupeStops(allStops.flat()), q, limit);
}

export async function listSeptaRailStops(q = "", limit = 300): Promise<SeptaStopOption[]> {
    return filterStops(await fetchRailStopsUnfiltered(), q, limit);
}

export async function listSeptaBusLinesForStop(stopId: string): Promise<SeptaRouteOption[]> {
    const normalizedStopId = stopId.trim();
    if (!normalizedStopId) return [];
    const routes = await fetchBusRoutesUnfiltered();
    const topRoutes = routes.slice(0, 80);
    const hits: SeptaRouteOption[] = [];
    for (const route of topRoutes) {
        const stops = await fetchBusStopsForRouteUnfiltered(route.id);
        if (stops.some((s) => s.stopId === normalizedStopId)) {
            hits.push(route);
        }
    }
    return hits.sort((a, b) => a.id.localeCompare(b.id));
}

export async function listSeptaRailLinesForStop(stopId: string): Promise<SeptaRouteOption[]> {
    const lines = await fetchRailArrivalsLinesForStop(stopId);
    return lines.map((id) => ({ id, label: id }));
}

export async function listSeptaRailLinesForStopByDirection(
    stopId: string,
    _direction: "N" | "S",
): Promise<SeptaRouteOption[]> {
    return listSeptaRailLinesForStop(stopId);
}

export function resolveSeptaRailStopName(stopOrName: string): string | null {
    const value = stopOrName.trim();
    return value.length > 0 ? value : null;
}

export function resolveSeptaRailStopId(stopOrName: string): string {
    return stopOrName.trim();
}

export function resolveSeptaBusStopId(stopOrName: string): string {
    return stopOrName.trim();
}

export async function resolveSeptaBusStopForRoute(
    routeOrLabel: string,
    stopOrName: string,
): Promise<SeptaStopOption | null> {
    const routeId = resolveSeptaBusRouteId(routeOrLabel);
    const needle = stopOrName.trim();
    if (!routeId || !needle) return null;
    const stops = await fetchBusStopsForRouteUnfiltered(routeId);
    const byId = stops.find((s) => s.stopId === needle);
    if (byId) return byId;
    const lower = needle.toLowerCase();
    return stops.find((s) => s.stop.toLowerCase() === lower) ?? null;
}

export async function resolveSeptaBusStopName(stopOrName: string): Promise<string | null> {
    const raw = stopOrName.trim();
    if (!raw) return null;
    const routes = await fetchBusRoutesUnfiltered();
    const topRoutes = routes.slice(0, 30);
    for (const route of topRoutes) {
        const match = await resolveSeptaBusStopForRoute(route.id, raw);
        if (match) return match.stop;
    }
    return null;
}

export function resolveSeptaBusRouteId(routeOrLabel: string): string {
    return normalizeBusRoute(routeOrLabel);
}

export function resolveSeptaRailRouteAliases(routeOrLabel: string): string[] {
    const normalized = normalizeRailRoute(routeOrLabel);
    return normalized ? [normalized] : [];
}

export function resolveSeptaRailRouteId(routeOrLabel: string): string {
    return normalizeRailRoute(routeOrLabel);
}

export function resolveSeptaRailRouteLabel(routeOrId: string): string {
    return resolveSeptaRailRouteId(routeOrId);
}
