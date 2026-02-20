import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

type StopOption = { stopId: string; stop: string; direction: "" };

const CTA_LINE_ORDER = ["RED", "BLUE", "BRN", "G", "ORG", "P", "PINK", "Y"] as const;
const CTA_ROUTE_TO_LINE: Record<string, (typeof CTA_LINE_ORDER)[number]> = {
    RED: "RED",
    BLUE: "BLUE",
    BRN: "BRN",
    G: "G",
    ORG: "ORG",
    P: "P",
    PINK: "PINK",
    Y: "Y",
};

let cachedStops: StopOption[] | null = null;
let cachedLines: string[] | null = null;
let tripToLineCache: Map<string, string> | null = null;
let parentStationByStopIdCache: Map<string, string> | null = null;
let linesByStationCache: Map<string, string[]> | null = null;
let linesByStationPromise: Promise<Map<string, string[]>> | null = null;

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

function findCtaFile(fileName: "stops.txt" | "trips.txt"): string | null {
    const candidates = [
        resolve(import.meta.dir, `../../data/cta-subway/${fileName}`),
        resolve(process.cwd(), `data/cta-subway/${fileName}`),
    ];
    for (const path of candidates) {
        if (existsSync(path)) return path;
    }
    return null;
}

function findCtaStopTimesFile(): string | null {
    const candidates = [
        resolve(import.meta.dir, "../../data/cta-subway/stop_times_reduced.txt"),
        resolve(process.cwd(), "data/cta-subway/stop_times_reduced.txt"),
        resolve(import.meta.dir, "../../data/cta-subway/stop_times.txt"),
        resolve(process.cwd(), "data/cta-subway/stop_times.txt"),
    ];
    for (const path of candidates) {
        if (existsSync(path)) return path;
    }
    return null;
}

function normalizeCtaLine(raw: string): string | null {
    const key = raw.trim().toUpperCase();
    if (!key) return null;
    return CTA_ROUTE_TO_LINE[key] ?? null;
}

function getParentStationByStopId(): Map<string, string> {
    if (parentStationByStopIdCache) return parentStationByStopIdCache;

    const path = findCtaFile("stops.txt");
    const map = new Map<string, string>();
    if (!path) {
        parentStationByStopIdCache = map;
        return map;
    }

    const rows = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    if (rows.length === 0) {
        parentStationByStopIdCache = map;
        return map;
    }

    const headerLine = rows[0];
    if (!headerLine) {
        parentStationByStopIdCache = map;
        return map;
    }
    const header = parseCsvLine(headerLine);
    const stopIdIdx = header.indexOf("stop_id");
    const parentStationIdx = header.indexOf("parent_station");
    if (stopIdIdx < 0 || parentStationIdx < 0) {
        parentStationByStopIdCache = map;
        return map;
    }

    for (let i = 1; i < rows.length; i++) {
        const rowLine = rows[i];
        if (!rowLine) continue;
        const cols = parseCsvLine(rowLine);
        const stopId = cols[stopIdIdx]?.trim() ?? "";
        const parentStation = cols[parentStationIdx]?.trim() ?? "";
        if (!stopId) continue;
        if (/^4\d{4}$/.test(parentStation)) {
            map.set(stopId, parentStation);
        }
    }

    parentStationByStopIdCache = map;
    return map;
}

function normalizeCtaStationId(stopIdRaw: string): string | null {
    const stopId = stopIdRaw.trim();
    if (!stopId) return null;
    if (/^4\d{4}$/.test(stopId)) return stopId;
    const parent = getParentStationByStopId().get(stopId);
    if (parent && /^4\d{4}$/.test(parent)) return parent;
    return null;
}

function getTripToLineMap(): Map<string, string> {
    if (tripToLineCache) return tripToLineCache;

    const path = findCtaFile("trips.txt");
    const map = new Map<string, string>();
    if (!path) {
        tripToLineCache = map;
        return map;
    }

    const rows = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    if (rows.length === 0) {
        tripToLineCache = map;
        return map;
    }

    const headerLine = rows[0];
    if (!headerLine) {
        tripToLineCache = map;
        return map;
    }
    const header = parseCsvLine(headerLine);
    const routeIdIdx = header.indexOf("route_id");
    const tripIdIdx = header.indexOf("trip_id");
    if (routeIdIdx < 0 || tripIdIdx < 0) {
        tripToLineCache = map;
        return map;
    }

    for (let i = 1; i < rows.length; i++) {
        const rowLine = rows[i];
        if (!rowLine) continue;
        const cols = parseCsvLine(rowLine);
        const routeId = cols[routeIdIdx]?.trim() ?? "";
        const tripId = cols[tripIdIdx]?.trim() ?? "";
        if (!tripId) continue;
        const line = normalizeCtaLine(routeId);
        if (!line) continue;
        map.set(tripId, line);
    }

    tripToLineCache = map;
    return map;
}

async function getLinesByStationMap(): Promise<Map<string, string[]>> {
    if (linesByStationCache) return linesByStationCache;
    if (linesByStationPromise) return linesByStationPromise;

    linesByStationPromise = (async () => {
        const stopTimesPath = findCtaStopTimesFile();
        const result = new Map<string, Set<string>>();
        if (!stopTimesPath) {
            const empty = new Map<string, string[]>();
            linesByStationCache = empty;
            linesByStationPromise = null;
            return empty;
        }

        const tripToLine = getTripToLineMap();
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
            const tripId = cols[tripIdIdx]?.trim() ?? "";
            const stopId = cols[stopIdIdx]?.trim() ?? "";
            if (!tripId || !stopId) continue;

            const mappedLine = tripToLine.get(tripId);
            if (!mappedLine) continue;
            const stationId = normalizeCtaStationId(stopId);
            if (!stationId) continue;

            const set = result.get(stationId) ?? new Set<string>();
            set.add(mappedLine);
            result.set(stationId, set);
        }

        const finalized = new Map<string, string[]>();
        for (const [stationId, lines] of result.entries()) {
            const sorted = [...lines].sort((a, b) => {
                const ai = CTA_LINE_ORDER.indexOf(a as (typeof CTA_LINE_ORDER)[number]);
                const bi = CTA_LINE_ORDER.indexOf(b as (typeof CTA_LINE_ORDER)[number]);
                if (ai >= 0 && bi >= 0) return ai - bi;
                if (ai >= 0) return -1;
                if (bi >= 0) return 1;
                return a.localeCompare(b);
            });
            finalized.set(stationId, sorted);
        }

        linesByStationCache = finalized;
        linesByStationPromise = null;
        return finalized;
    })().catch((error) => {
        linesByStationPromise = null;
        throw error;
    });

    return linesByStationPromise;
}

export function listCtaSubwayStops(): StopOption[] {
    if (cachedStops) return cachedStops;

    const path = findCtaFile("stops.txt");
    if (!path) {
        cachedStops = [];
        return cachedStops;
    }

    const rows = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    if (rows.length === 0) {
        cachedStops = [];
        return cachedStops;
    }

    const headerLine = rows[0];
    if (!headerLine) {
        cachedStops = [];
        return cachedStops;
    }
    const header = parseCsvLine(headerLine);
    const stopIdIdx = header.indexOf("stop_id");
    const stopNameIdx = header.indexOf("stop_name");
    const locationTypeIdx = header.indexOf("location_type");
    if (stopIdIdx < 0 || stopNameIdx < 0) {
        cachedStops = [];
        return cachedStops;
    }

    const stops: StopOption[] = [];
    for (let i = 1; i < rows.length; i++) {
        const rowLine = rows[i];
        if (!rowLine) continue;
        const cols = parseCsvLine(rowLine);
        const stopId = cols[stopIdIdx]?.trim() ?? "";
        const stop = cols[stopNameIdx]?.trim() ?? "";
        const locationType = locationTypeIdx >= 0 ? cols[locationTypeIdx]?.trim() ?? "" : "";
        if (!stopId || !stop) continue;
        if (!/^4\d{4}$/.test(stopId)) continue;
        if (locationType && locationType !== "1") continue;
        stops.push({ stopId, stop, direction: "" });
    }

    stops.sort((a, b) => {
        const byName = a.stop.localeCompare(b.stop);
        if (byName !== 0) return byName;
        return a.stopId.localeCompare(b.stopId);
    });

    cachedStops = stops;
    return cachedStops;
}

export function listCtaSubwayLines(): string[] {
    if (cachedLines) return cachedLines;

    const path = findCtaFile("trips.txt");
    if (!path) {
        cachedLines = [...CTA_LINE_ORDER];
        return cachedLines;
    }

    const rows = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    if (rows.length === 0) {
        cachedLines = [...CTA_LINE_ORDER];
        return cachedLines;
    }

    const headerLine = rows[0];
    if (!headerLine) {
        cachedLines = [...CTA_LINE_ORDER];
        return cachedLines;
    }
    const header = parseCsvLine(headerLine);
    const routeIdIdx = header.indexOf("route_id");
    if (routeIdIdx < 0) {
        cachedLines = [...CTA_LINE_ORDER];
        return cachedLines;
    }

    const lineSet = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
        const rowLine = rows[i];
        if (!rowLine) continue;
        const cols = parseCsvLine(rowLine);
        const routeId = cols[routeIdIdx]?.trim() ?? "";
        const normalized = normalizeCtaLine(routeId);
        if (normalized) lineSet.add(normalized);
    }

    const known = CTA_LINE_ORDER.filter((line) => lineSet.has(line));
    cachedLines = known.length > 0 ? known : [...CTA_LINE_ORDER];
    return cachedLines;
}

export async function listCtaSubwayLinesForStop(stopId: string): Promise<string[]> {
    const stationId = normalizeCtaStationId(stopId);
    if (!stationId) return [];
    const linesByStation = await getLinesByStationMap();
    return linesByStation.get(stationId) ?? [];
}
