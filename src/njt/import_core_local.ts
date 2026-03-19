import { constants as fsConstants, createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
    njtBusRouteStops,
    njtBusRoutes,
    njtBusStations,
    njtRailRouteStops,
    njtRailRoutes,
    njtRailStations,
} from "../db/schema/schema.ts";

type DbLike = {
    delete: Function;
    insert: Function;
    transaction: Function;
};

type NjtMode = "rail" | "bus";

type ModeCounts = {
    stations: number;
    routes: number;
    routeStops: number;
};

type ModeWarnings = {
    missingTripRefs: number;
    missingStopRefs: number;
    sampleMissingStopIds: string[];
};

type ImportStats = {
    sourceDir: string;
    datasets: number;
    counts: Record<NjtMode, ModeCounts>;
    warnings: Record<NjtMode, ModeWarnings>;
};

type StopRow = {
    stopId: string;
    stopName: string;
    stopLat: string | null;
    stopLon: string | null;
    parentStation: string | null;
};

type StationAccum = {
    stopId: string;
    stopName: string;
    stopLat: string | null;
    stopLon: string | null;
    parentStation: string | null;
    childStopIds: Set<string>;
};

type RouteAccum = {
    routeId: string;
    agencyId: string | null;
    routeShortName: string;
    routeLongName: string;
    routeDesc: string | null;
    routeType: number;
    routeUrl: string | null;
    routeColor: string | null;
    routeTextColor: string | null;
    routeSortOrder: number | null;
};

type RouteStopAccum = {
    routeId: string;
    directionId: number;
    stopId: string;
    routeStopSortOrder: number | null;
};

type TripRef = {
    mode: NjtMode;
    routeId: string;
    directionId: number;
};

type ModeState = {
    stations: Map<string, StationAccum>;
    routes: Map<string, RouteAccum>;
    routeStops: Map<string, RouteStopAccum>;
    missingTripRefs: number;
    missingStopRefs: number;
    missingStopSample: Set<string>;
};

const REQUIRED_CORE_FILES = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"] as const;
const BATCH_SIZE = 1000;

const parseIntOrNull = (value?: string): number | null => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.trunc(n) : null;
};

const parseNumericOrNull = (value?: string): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? String(n) : null;
};

const parseDirectionId = (value?: string): number => {
    const raw = (value ?? "").trim().toUpperCase();
    if (!raw) return 0;
    if (raw === "N" || raw === "OUTBOUND") return 0;
    if (raw === "S" || raw === "INBOUND") return 1;
    const parsed = parseIntOrNull(raw);
    if (parsed === 0 || parsed === 1) return parsed;
    return 0;
};

const parseCoreModeFromRouteType = (routeTypeRaw?: string): NjtMode | null => {
    const routeType = parseIntOrNull(routeTypeRaw);
    if (routeType === 2) return "rail";
    if (routeType === 3) return "bus";
    return null;
};

const parseCsvLine = (line: string): string[] => {
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
};

const initModeState = (): ModeState => ({
    stations: new Map(),
    routes: new Map(),
    routeStops: new Map(),
    missingTripRefs: 0,
    missingStopRefs: 0,
    missingStopSample: new Set(),
});

const routeStopKey = (row: { routeId: string; directionId: number; stopId: string }) =>
    `${row.routeId}|${row.directionId}|${row.stopId}`;

const addMissingStopSample = (state: ModeState, stopId: string) => {
    if (!stopId) return;
    if (state.missingStopSample.size < 20) {
        state.missingStopSample.add(stopId);
    }
};

const ensureStation = (state: ModeState, stopId: string, base?: StopRow): StationAccum => {
    const existing = state.stations.get(stopId);
    if (existing) {
        if (base) {
            if (!existing.stopName && base.stopName) existing.stopName = base.stopName;
            if (!existing.stopLat && base.stopLat) existing.stopLat = base.stopLat;
            if (!existing.stopLon && base.stopLon) existing.stopLon = base.stopLon;
            if (!existing.parentStation && base.parentStation) existing.parentStation = base.parentStation;
        }
        return existing;
    }

    const created: StationAccum = {
        stopId,
        stopName: base?.stopName ?? stopId,
        stopLat: base?.stopLat ?? null,
        stopLon: base?.stopLon ?? null,
        parentStation: base?.parentStation ?? null,
        childStopIds: new Set<string>([stopId]),
    };
    state.stations.set(stopId, created);
    return created;
};

const upsertRouteStop = (routeStops: Map<string, RouteStopAccum>, next: RouteStopAccum) => {
    const key = routeStopKey(next);
    const existing = routeStops.get(key);
    if (!existing) {
        routeStops.set(key, next);
        return;
    }
    if (next.routeStopSortOrder === null) return;
    if (existing.routeStopSortOrder === null || next.routeStopSortOrder < existing.routeStopSortOrder) {
        existing.routeStopSortOrder = next.routeStopSortOrder;
    }
};

async function assertReadable(path: string) {
    await access(path, fsConstants.R_OK);
}

async function hasRequiredCoreFiles(dir: string): Promise<boolean> {
    for (const fileName of REQUIRED_CORE_FILES) {
        try {
            await assertReadable(join(dir, fileName));
        } catch {
            return false;
        }
    }
    return true;
}

async function collectDatasetDirs(root: string): Promise<string[]> {
    const resolved = resolve(root);
    if (await hasRequiredCoreFiles(resolved)) {
        return [resolved];
    }

    const out: string[] = [];
    const queue: string[] = [resolved];

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) continue;

        let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
        try {
            entries = await readdir(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith(".")) continue;
            const child = join(current, entry.name);
            if (await hasRequiredCoreFiles(child)) {
                out.push(child);
            } else {
                queue.push(child);
            }
        }
    }

    return out.sort();
}

async function readCsvRows(
    path: string,
    onRow: (row: Record<string, string>, rowIndex: number) => void | Promise<void>,
) {
    const rl = createInterface({
        input: createReadStream(path, "utf8"),
        crlfDelay: Infinity,
    });

    let headers: string[] | null = null;
    let rowIndex = 0;
    for await (const line of rl) {
        if (!headers) {
            headers = parseCsvLine(line).map((value) => value.trim());
            continue;
        }
        if (!line.trim()) continue;
        const cells = parseCsvLine(line);
        const row: Record<string, string> = {};
        headers.forEach((header, idx) => {
            row[header] = cells[idx] ?? "";
        });
        await onRow(row, rowIndex++);
    }
}

const insertInBatches = async (insertFn: Function, rows: object[]) => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        if (!batch.length) continue;
        await insertFn(batch);
    }
};

export async function runNjtCoreLocalImport(db: DbLike, sourceDir: string): Promise<ImportStats> {
    const resolvedSourceDir = resolve(sourceDir);
    const datasetDirs = await collectDatasetDirs(resolvedSourceDir);
    if (!datasetDirs.length) {
        throw new Error(`No GTFS datasets found in ${resolvedSourceDir}`);
    }

    const states: Record<NjtMode, ModeState> = {
        rail: initModeState(),
        bus: initModeState(),
    };

    for (const datasetDir of datasetDirs) {
        const stopsById = new Map<string, StopRow>();
        const routeById = new Map<string, { mode: NjtMode; routeId: string }>();
        const tripById = new Map<string, TripRef>();
        const datasetModes = new Set<NjtMode>();

        await readCsvRows(join(datasetDir, "stops.txt"), (row) => {
            const stopId = (row.stop_id ?? "").trim();
            if (!stopId) return;
            stopsById.set(stopId, {
                stopId,
                stopName: (row.stop_name ?? "").trim() || stopId,
                stopLat: parseNumericOrNull(row.stop_lat),
                stopLon: parseNumericOrNull(row.stop_lon),
                parentStation: (row.parent_station ?? "").trim() || null,
            });
        });

        await readCsvRows(join(datasetDir, "routes.txt"), (row) => {
            const routeId = (row.route_id ?? "").trim();
            if (!routeId) return;
            const mode = parseCoreModeFromRouteType(row.route_type);
            if (!mode) return;
            datasetModes.add(mode);

            const routeType = parseIntOrNull(row.route_type) ?? (mode === "rail" ? 2 : 3);
            const state = states[mode];
            routeById.set(routeId, { mode, routeId });
            state.routes.set(routeId, {
                routeId,
                agencyId: (row.agency_id ?? "").trim() || null,
                routeShortName: (row.route_short_name ?? "").trim(),
                routeLongName: (row.route_long_name ?? "").trim(),
                routeDesc: (row.route_desc ?? "").trim() || null,
                routeType,
                routeUrl: (row.route_url ?? "").trim() || null,
                routeColor: (row.route_color ?? "").trim() || null,
                routeTextColor: (row.route_text_color ?? "").trim() || null,
                routeSortOrder: parseIntOrNull(row.route_sort_order),
            });
        });

        await readCsvRows(join(datasetDir, "trips.txt"), (row) => {
            const tripId = (row.trip_id ?? "").trim();
            const routeId = (row.route_id ?? "").trim();
            if (!tripId || !routeId) return;
            const routeRef = routeById.get(routeId);
            if (!routeRef) return;
            tripById.set(tripId, {
                mode: routeRef.mode,
                routeId,
                directionId: parseDirectionId(row.direction_id),
            });
        });

        await readCsvRows(join(datasetDir, "stop_times.txt"), (row) => {
            const tripId = (row.trip_id ?? "").trim();
            const stopId = (row.stop_id ?? "").trim();
            if (!tripId || !stopId) return;

            const tripRef = tripById.get(tripId);
            if (!tripRef) {
                for (const mode of datasetModes) {
                    states[mode].missingTripRefs += 1;
                }
                return;
            }

            const state = states[tripRef.mode];
            const stopRow = stopsById.get(stopId);
            if (!stopRow) {
                state.missingStopRefs += 1;
                addMissingStopSample(state, stopId);
                return;
            }

            const stationKey = stopRow.parentStation || stopRow.stopId;
            const station = ensureStation(state, stationKey, {
                ...stopRow,
                stopId: stationKey,
                stopName: stopRow.parentStation ? stopRow.parentStation : stopRow.stopName,
            });
            station.childStopIds.add(stopRow.stopId);
            if (!station.stopLat && stopRow.stopLat) station.stopLat = stopRow.stopLat;
            if (!station.stopLon && stopRow.stopLon) station.stopLon = stopRow.stopLon;
            if (!station.parentStation && stopRow.parentStation) station.parentStation = stopRow.parentStation;

            upsertRouteStop(state.routeStops, {
                routeId: tripRef.routeId,
                directionId: tripRef.directionId,
                stopId: stationKey,
                routeStopSortOrder: parseIntOrNull(row.stop_sequence),
            });
        });

        for (const stopRow of stopsById.values()) {
            for (const mode of datasetModes) {
                if (!states[mode].stations.has(stopRow.stopId)) {
                    ensureStation(states[mode], stopRow.stopId, stopRow);
                }
            }
        }
    }

    await db.transaction(async (tx: DbLike) => {
        await tx.delete(njtRailRouteStops);
        await tx.delete(njtRailRoutes);
        await tx.delete(njtRailStations);
        await tx.delete(njtBusRouteStops);
        await tx.delete(njtBusRoutes);
        await tx.delete(njtBusStations);

        const railStations = Array.from(states.rail.stations.values()).map((station) => ({
            stopId: station.stopId,
            stopName: station.stopName,
            stopLat: station.stopLat,
            stopLon: station.stopLon,
            parentStation: station.parentStation,
            childStopIdsJson: Array.from(station.childStopIds).sort(),
        }));
        const railRoutes = Array.from(states.rail.routes.values()).map((route) => ({ ...route }));
        const railRouteStops = Array.from(states.rail.routeStops.values()).map((routeStop) => ({ ...routeStop }));

        const busStations = Array.from(states.bus.stations.values()).map((station) => ({
            stopId: station.stopId,
            stopName: station.stopName,
            stopLat: station.stopLat,
            stopLon: station.stopLon,
            parentStation: station.parentStation,
            childStopIdsJson: Array.from(station.childStopIds).sort(),
        }));
        const busRoutes = Array.from(states.bus.routes.values()).map((route) => ({ ...route }));
        const busRouteStops = Array.from(states.bus.routeStops.values()).map((routeStop) => ({ ...routeStop }));

        await insertInBatches((rows: object[]) => tx.insert(njtRailStations).values(rows), railStations);
        await insertInBatches((rows: object[]) => tx.insert(njtRailRoutes).values(rows), railRoutes);
        await insertInBatches((rows: object[]) => tx.insert(njtRailRouteStops).values(rows), railRouteStops);

        await insertInBatches((rows: object[]) => tx.insert(njtBusStations).values(rows), busStations);
        await insertInBatches((rows: object[]) => tx.insert(njtBusRoutes).values(rows), busRoutes);
        await insertInBatches((rows: object[]) => tx.insert(njtBusRouteStops).values(rows), busRouteStops);
    });

    return {
        sourceDir: resolvedSourceDir,
        datasets: datasetDirs.length,
        counts: {
            rail: {
                stations: states.rail.stations.size,
                routes: states.rail.routes.size,
                routeStops: states.rail.routeStops.size,
            },
            bus: {
                stations: states.bus.stations.size,
                routes: states.bus.routes.size,
                routeStops: states.bus.routeStops.size,
            },
        },
        warnings: {
            rail: {
                missingTripRefs: states.rail.missingTripRefs,
                missingStopRefs: states.rail.missingStopRefs,
                sampleMissingStopIds: Array.from(states.rail.missingStopSample),
            },
            bus: {
                missingTripRefs: states.bus.missingTripRefs,
                missingStopRefs: states.bus.missingStopRefs,
                sampleMissingStopIds: Array.from(states.bus.missingStopSample),
            },
        },
    };
}
