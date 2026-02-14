import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

let stopNameById: Map<string, string> | null = null;
let cachedStopOptions: Array<{ stopId: string; stop: string; direction: "N" | "S" | "" }> | null = null;
let routeLabelByRouteId: Map<string, string> | null = null;
const linesByStopCache = new Map<string, string[]>();

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

function findStopsPath(): string | null {
    const candidates = [
        resolve(import.meta.dir, "../../data/mta/stops.txt"),
        resolve(process.cwd(), "data/mta/stops.txt"),
        resolve(import.meta.dir, "../../data/gtfs_subway/stops.txt"),
        resolve(process.cwd(), "data/gtfs_subway/stops.txt"),
        resolve(import.meta.dir, "../../gtfs_subway/stops.txt"),
    ];

    for (const path of candidates) {
        if (existsSync(path)) return path;
    }

    return null;
}

function findGtfsFilePath(fileName: string): string | null {
    const candidates = [
        resolve(import.meta.dir, `../../data/mta/${fileName}`),
        resolve(process.cwd(), `data/mta/${fileName}`),
        resolve(import.meta.dir, `../../data/gtfs_subway/${fileName}`),
        resolve(process.cwd(), `data/gtfs_subway/${fileName}`),
        resolve(import.meta.dir, `../../gtfs_subway/${fileName}`),
    ];

    for (const path of candidates) {
        if (existsSync(path)) return path;
    }

    return null;
}

function loadStopMap(): Map<string, string> {
    if (stopNameById) return stopNameById;

    const map = new Map<string, string>();
    const path = findStopsPath();
    if (!path) {
        stopNameById = map;
        return map;
    }

    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) {
        stopNameById = map;
        return map;
    }

    const header = parseCsvLine(lines[0]);
    const stopIdIdx = header.indexOf("stop_id");
    const stopNameIdx = header.indexOf("stop_name");
    if (stopIdIdx < 0 || stopNameIdx < 0) {
        stopNameById = map;
        return map;
    }

    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const stopId = cols[stopIdIdx]?.trim();
        const stopName = cols[stopNameIdx]?.trim();
        if (!stopId || !stopName) continue;
        map.set(stopId, stopName);
    }

    stopNameById = map;
    return map;
}

export function resolveStopName(stopId: string): string | undefined {
    const id = stopId.trim();
    if (!id) return undefined;
    return loadStopMap().get(id);
}

export function listStops(): Array<{ stopId: string; stop: string; direction: "N" | "S" | "" }> {
    if (cachedStopOptions) return cachedStopOptions;

    const options: Array<{ stopId: string; stop: string; direction: "N" | "S" | "" }> = [];
    for (const [stopId, stop] of loadStopMap().entries()) {
        let direction: "N" | "S" | "" = "";
        if (stopId.endsWith("N")) direction = "N";
        else if (stopId.endsWith("S")) direction = "S";
        options.push({ stopId, stop, direction });
    }

    options.sort((a, b) => {
        const byStop = a.stop.localeCompare(b.stop);
        if (byStop !== 0) return byStop;
        return a.stopId.localeCompare(b.stopId);
    });

    cachedStopOptions = options;
    return options;
}

function sortLines(lines: string[]): string[] {
    return [...lines].sort((a, b) => {
        const an = Number(a);
        const bn = Number(b);
        const aIsNum = Number.isFinite(an) && a.trim() !== "";
        const bIsNum = Number.isFinite(bn) && b.trim() !== "";
        if (aIsNum && bIsNum) return an - bn;
        if (aIsNum) return -1;
        if (bIsNum) return 1;
        return a.localeCompare(b);
    });
}

function loadRouteLabels(): Map<string, string> {
    if (routeLabelByRouteId) return routeLabelByRouteId;

    const map = new Map<string, string>();
    const path = findGtfsFilePath("routes.txt");
    if (!path) {
        routeLabelByRouteId = map;
        return map;
    }

    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) {
        routeLabelByRouteId = map;
        return map;
    }

    const header = parseCsvLine(lines[0]);
    const routeIdIdx = header.indexOf("route_id");
    const routeShortNameIdx = header.indexOf("route_short_name");
    if (routeIdIdx < 0) {
        routeLabelByRouteId = map;
        return map;
    }

    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const routeId = cols[routeIdIdx]?.trim();
        if (!routeId) continue;
        const routeShortName = routeShortNameIdx >= 0 ? cols[routeShortNameIdx]?.trim() : "";
        map.set(routeId, routeShortName && routeShortName.length > 0 ? routeShortName : routeId);
    }

    routeLabelByRouteId = map;
    return map;
}

async function collectTripIdsForStop(stopId: string): Promise<Set<string>> {
    const stopTimesPath = findGtfsFilePath("stop_times.txt");
    const tripIds = new Set<string>();
    if (!stopTimesPath) return tripIds;

    const rl = createInterface({
        input: createReadStream(stopTimesPath),
        crlfDelay: Infinity,
    });

    let isHeader = true;
    let tripIdIdx = -1;
    let stopIdIdx = -1;

    for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;

        if (isHeader) {
            isHeader = false;
            const header = parseCsvLine(line);
            tripIdIdx = header.indexOf("trip_id");
            stopIdIdx = header.indexOf("stop_id");
            continue;
        }

        if (tripIdIdx < 0 || stopIdIdx < 0) break;

        const cols = parseCsvLine(line);
        const stop = cols[stopIdIdx]?.trim();
        if (stop !== stopId) continue;
        const tripId = cols[tripIdIdx]?.trim();
        if (tripId) tripIds.add(tripId);
    }

    return tripIds;
}

async function collectLinesForTripIds(tripIds: Set<string>): Promise<string[]> {
    const tripsPath = findGtfsFilePath("trips.txt");
    if (!tripsPath || !tripIds.size) return [];

    const routeLabels = loadRouteLabels();
    const lines = new Set<string>();

    const rl = createInterface({
        input: createReadStream(tripsPath),
        crlfDelay: Infinity,
    });

    let isHeader = true;
    let routeIdIdx = -1;
    let tripIdIdx = -1;

    for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;

        if (isHeader) {
            isHeader = false;
            const header = parseCsvLine(line);
            routeIdIdx = header.indexOf("route_id");
            tripIdIdx = header.indexOf("trip_id");
            continue;
        }

        if (routeIdIdx < 0 || tripIdIdx < 0) break;

        const cols = parseCsvLine(line);
        const tripId = cols[tripIdIdx]?.trim();
        if (!tripId || !tripIds.has(tripId)) continue;

        const routeId = cols[routeIdIdx]?.trim();
        if (!routeId) continue;
        lines.add(routeLabels.get(routeId) ?? routeId);
    }

    return sortLines(Array.from(lines));
}

export async function listLinesForStop(stopId: string): Promise<string[]> {
    const normalizedStopId = stopId.trim().toUpperCase();
    if (!normalizedStopId) return [];

    const cached = linesByStopCache.get(normalizedStopId);
    if (cached) return cached;

    const tripIds = await collectTripIdsForStop(normalizedStopId);
    const lines = await collectLinesForTripIds(tripIds);
    linesByStopCache.set(normalizedStopId, lines);
    return lines;
}
