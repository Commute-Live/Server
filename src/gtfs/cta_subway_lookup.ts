import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

function normalizeCtaLine(raw: string): string | null {
    const key = raw.trim().toUpperCase();
    if (!key) return null;
    return CTA_ROUTE_TO_LINE[key] ?? null;
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

    const header = parseCsvLine(rows[0]);
    const stopIdIdx = header.indexOf("stop_id");
    const stopNameIdx = header.indexOf("stop_name");
    const locationTypeIdx = header.indexOf("location_type");
    if (stopIdIdx < 0 || stopNameIdx < 0) {
        cachedStops = [];
        return cachedStops;
    }

    const stops: StopOption[] = [];
    for (let i = 1; i < rows.length; i++) {
        const cols = parseCsvLine(rows[i]);
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

    const header = parseCsvLine(rows[0]);
    const routeIdIdx = header.indexOf("route_id");
    if (routeIdIdx < 0) {
        cachedLines = [...CTA_LINE_ORDER];
        return cachedLines;
    }

    const lineSet = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
        const cols = parseCsvLine(rows[i]);
        const routeId = cols[routeIdIdx]?.trim() ?? "";
        const normalized = normalizeCtaLine(routeId);
        if (normalized) lineSet.add(normalized);
    }

    const known = CTA_LINE_ORDER.filter((line) => lineSet.has(line));
    cachedLines = known.length > 0 ? known : [...CTA_LINE_ORDER];
    return cachedLines;
}
