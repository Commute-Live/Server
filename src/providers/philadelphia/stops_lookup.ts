import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type SeptaRouteOption = { id: string; label: string };
export type SeptaStopOption = { stopId: string; stop: string };

type Mode = "bus" | "rail";

type SeptaCache = {
    routes: SeptaRouteOption[];
    routeLabelById: Map<string, string>;
    routeAliasesById: Map<string, string[]>;
    routeToStops: Map<string, string[]>;
    stopToRoutes: Map<string, string[]>;
    stopNameById: Map<string, string>;
};

const cacheByMode: Partial<Record<Mode, SeptaCache>> = {};

function parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (ch === "," && !inQuotes) {
            values.push(current);
            current = "";
            continue;
        }

        current += ch;
    }

    values.push(current);
    return values;
}

function findSeptaFile(mode: Mode, fileName: "routes.txt" | "stops.txt" | "route_stops.txt"): string | null {
    const candidates = [
        resolve(import.meta.dir, `../../../data/septa/${mode}/${fileName}`),
        resolve(process.cwd(), `data/septa/${mode}/${fileName}`),
    ];
    for (const path of candidates) {
        if (existsSync(path)) return path;
    }
    return null;
}

function loadRows(path: string): string[][] {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) return [];
    return lines.map(parseCsvLine);
}

function buildCache(mode: Mode): SeptaCache {
    const routeStopsPath = findSeptaFile(mode, "route_stops.txt");
    const routesPath = findSeptaFile(mode, "routes.txt");
    const stopsPath = findSeptaFile(mode, "stops.txt");

    if (!routeStopsPath || !routesPath || !stopsPath) {
        return {
            routes: [],
            routeLabelById: new Map(),
            routeAliasesById: new Map(),
            routeToStops: new Map(),
            stopToRoutes: new Map(),
            stopNameById: new Map(),
        };
    }

    const routeStopsRows = loadRows(routeStopsPath);
    const routesRows = loadRows(routesPath);
    const stopsRows = loadRows(stopsPath);
    if (routeStopsRows.length === 0 || routesRows.length === 0 || stopsRows.length === 0) {
        return {
            routes: [],
            routeLabelById: new Map(),
            routeAliasesById: new Map(),
            routeToStops: new Map(),
            stopToRoutes: new Map(),
            stopNameById: new Map(),
        };
    }

    const routeStopsHeader = routeStopsRows[0];
    const routesHeader = routesRows[0];
    const stopsHeader = stopsRows[0];
    if (!routeStopsHeader || !routesHeader || !stopsHeader) {
        return {
            routes: [],
            routeLabelById: new Map(),
            routeAliasesById: new Map(),
            routeToStops: new Map(),
            stopToRoutes: new Map(),
            stopNameById: new Map(),
        };
    }

    const routeIdIdx = routeStopsHeader.indexOf("route_id");
    const stopIdIdx = routeStopsHeader.indexOf("stop_id");
    const routesRouteIdIdx = routesHeader.indexOf("route_id");
    const shortNameIdx = routesHeader.indexOf("route_short_name");
    const longNameIdx = routesHeader.indexOf("route_long_name");
    const stopsStopIdIdx = stopsHeader.indexOf("stop_id");
    const stopNameIdx = stopsHeader.indexOf("stop_name");

    const routeToStops = new Map<string, string[]>();
    const routeToStopSet = new Map<string, Set<string>>();
    for (let i = 1; i < routeStopsRows.length; i++) {
        const row = routeStopsRows[i];
        if (!row) continue;
        const routeId = row[routeIdIdx]?.trim() ?? "";
        const stopId = row[stopIdIdx]?.trim() ?? "";
        if (!routeId || !stopId) continue;
        if (!routeToStopSet.has(routeId)) routeToStopSet.set(routeId, new Set());
        routeToStopSet.get(routeId)!.add(stopId);
    }
    for (const [routeId, set] of routeToStopSet.entries()) {
        routeToStops.set(routeId, Array.from(set));
    }

    const stopToRouteSet = new Map<string, Set<string>>();
    for (const [routeId, stopIds] of routeToStops.entries()) {
        for (const stopId of stopIds) {
            if (!stopToRouteSet.has(stopId)) stopToRouteSet.set(stopId, new Set());
            stopToRouteSet.get(stopId)!.add(routeId);
        }
    }

    const stopNameById = new Map<string, string>();
    for (let i = 1; i < stopsRows.length; i++) {
        const row = stopsRows[i];
        if (!row) continue;
        const stopId = row[stopsStopIdIdx]?.trim() ?? "";
        const stopName = row[stopNameIdx]?.trim() ?? "";
        if (!stopId) continue;
        stopNameById.set(stopId, stopName || stopId);
    }

    const routeLabelById = new Map<string, string>();
    const routeAliasesById = new Map<string, string[]>();
    const normalizeRouteAlias = (value: string) =>
        value
            .trim()
            .toUpperCase()
            .replace(/\s+LINE$/i, "")
            .replace(/\s+/g, " ");
    for (let i = 1; i < routesRows.length; i++) {
        const row = routesRows[i];
        if (!row) continue;
        const routeId = row[routesRouteIdIdx]?.trim() ?? "";
        if (!routeId) continue;
        const shortName = row[shortNameIdx]?.trim() ?? "";
        const longName = row[longNameIdx]?.trim() ?? "";
        routeLabelById.set(routeId, shortName || longName || routeId);
        const aliases = new Set<string>();
        aliases.add(routeId);
        if (shortName) aliases.add(shortName);
        if (longName) aliases.add(longName);
        if (longName.toLowerCase().endsWith(" line")) {
            aliases.add(longName.slice(0, -5));
        }
        routeAliasesById.set(
            routeId,
            Array.from(aliases)
                .map(normalizeRouteAlias)
                .filter((v) => v.length > 0),
        );
    }

    const routes = Array.from(routeToStops.keys())
        .map((id) => ({ id, label: routeLabelById.get(id) ?? id }))
        .sort((a, b) => a.id.localeCompare(b.id));
    const stopToRoutes = new Map<string, string[]>();
    for (const [stopId, routeSet] of stopToRouteSet.entries()) {
        stopToRoutes.set(stopId, Array.from(routeSet).sort((a, b) => a.localeCompare(b)));
    }

    return { routes, routeLabelById, routeAliasesById, routeToStops, stopToRoutes, stopNameById };
}

function getCache(mode: Mode): SeptaCache {
    if (!cacheByMode[mode]) {
        cacheByMode[mode] = buildCache(mode);
    }
    return cacheByMode[mode]!;
}

function queryRoutes(mode: Mode, q: string, limit: number): SeptaRouteOption[] {
    const needle = q.trim().toLowerCase();
    let routes = getCache(mode).routes;
    if (needle.length > 0) {
        routes = routes.filter((route) => route.id.toLowerCase().includes(needle) || route.label.toLowerCase().includes(needle));
    }
    return routes.slice(0, limit);
}

function queryStopsForRoute(mode: Mode, route: string, limit: number): SeptaStopOption[] {
    const routeId = route.trim();
    if (!routeId) return [];
    const cache = getCache(mode);
    const stopIds = cache.routeToStops.get(routeId) ?? [];
    return stopIds.slice(0, limit).map((stopId) => ({ stopId, stop: cache.stopNameById.get(stopId) ?? stopId }));
}

function queryStops(mode: Mode, q: string, limit: number): SeptaStopOption[] {
    const needle = q.trim().toLowerCase();
    let stops = Array.from(getCache(mode).stopNameById.entries()).map(([stopId, stop]) => ({ stopId, stop }));
    if (needle.length > 0) {
        stops = stops.filter((s) => s.stop.toLowerCase().includes(needle) || s.stopId.toLowerCase().includes(needle));
    }
    stops.sort((a, b) => a.stop.localeCompare(b.stop));
    return stops.slice(0, limit);
}

function queryLinesForStop(mode: Mode, stopId: string): SeptaRouteOption[] {
    const normalizedStopId = stopId.trim();
    if (!normalizedStopId) return [];
    const cache = getCache(mode);
    const routeIds = cache.stopToRoutes.get(normalizedStopId) ?? [];
    return routeIds.map((id) => ({ id, label: cache.routeLabelById.get(id) ?? id }));
}

export function listSeptaBusRoutes(q = "", limit = 300): SeptaRouteOption[] {
    return queryRoutes("bus", q, limit);
}

export function listSeptaRailRoutes(q = "", limit = 300): SeptaRouteOption[] {
    return queryRoutes("rail", q, limit);
}

export function listSeptaBusStopsForRoute(route: string, limit = 300): SeptaStopOption[] {
    return queryStopsForRoute("bus", route, limit);
}

export function listSeptaRailStopsForRoute(route: string, limit = 300): SeptaStopOption[] {
    return queryStopsForRoute("rail", route, limit);
}

export function listSeptaBusStops(q = "", limit = 300): SeptaStopOption[] {
    return queryStops("bus", q, limit);
}

export function listSeptaRailStops(q = "", limit = 300): SeptaStopOption[] {
    return queryStops("rail", q, limit);
}

export function listSeptaBusLinesForStop(stopId: string): SeptaRouteOption[] {
    return queryLinesForStop("bus", stopId);
}

export function listSeptaRailLinesForStop(stopId: string): SeptaRouteOption[] {
    return queryLinesForStop("rail", stopId);
}

export function resolveSeptaRailStopName(stopOrName: string): string | null {
    const raw = stopOrName.trim();
    if (!raw) return null;
    const cache = getCache("rail");
    if (cache.stopNameById.has(raw)) {
        return cache.stopNameById.get(raw) ?? null;
    }
    return raw;
}

export function resolveSeptaRailRouteAliases(routeOrLabel: string): string[] {
    const raw = routeOrLabel.trim();
    if (!raw) return [];
    const cache = getCache("rail");
    const normalized = raw
        .toUpperCase()
        .replace(/\s+LINE$/i, "")
        .replace(/\s+/g, " ");

    if (cache.routeAliasesById.has(normalized)) {
        return cache.routeAliasesById.get(normalized) ?? [normalized];
    }

    for (const aliases of cache.routeAliasesById.values()) {
        if (aliases.includes(normalized)) {
            return aliases;
        }
    }

    return [normalized];
}

export function resolveSeptaRailRouteId(routeOrLabel: string): string {
    const raw = routeOrLabel.trim();
    if (!raw) return "";
    const cache = getCache("rail");
    const normalized = raw
        .toUpperCase()
        .replace(/\s+LINE$/i, "")
        .replace(/\s+/g, " ");

    if (cache.routeAliasesById.has(normalized)) {
        return normalized;
    }

    for (const [routeId, aliases] of cache.routeAliasesById.entries()) {
        if (aliases.includes(normalized)) {
            return routeId;
        }
    }

    return normalized;
}

export function resolveSeptaRailRouteLabel(routeOrId: string): string {
    const routeId = resolveSeptaRailRouteId(routeOrId);
    if (!routeId) return "";
    const cache = getCache("rail");
    return cache.routeLabelById.get(routeId) ?? routeId;
}
