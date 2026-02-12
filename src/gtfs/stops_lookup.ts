import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let stopNameById: Map<string, string> | null = null;
let cachedStopOptions: Array<{ stopId: string; stop: string; direction: "N" | "S" | "" }> | null = null;

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
        resolve(import.meta.dir, "../../data/gtfs_subway/stops.txt"),
        resolve(process.cwd(), "data/gtfs_subway/stops.txt"),
        resolve(import.meta.dir, "../../gtfs_subway/stops.txt"),
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
