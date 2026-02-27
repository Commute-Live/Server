import { constants as fsConstants, createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
    bayareaBusRouteStops,
    bayareaBusRoutes,
    bayareaBusStations,
    bayareaCablewayRouteStops,
    bayareaCablewayRoutes,
    bayareaCablewayStations,
    bayareaTramRouteStops,
    bayareaTramRoutes,
    bayareaTramStations,
} from "../db/schema/schema.ts";

type DbLike = {
    delete: Function;
    insert: Function;
    transaction: Function;
};

type CoreMode = "bus" | "tram" | "cableway";

const CORE_MODES: CoreMode[] = ["bus", "tram", "cableway"];

const REQUIRED_CORE_FILES = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"] as const;
const BATCH_SIZE = 1000;

type ModeCounts = {
    stations: number;
    routes: number;
    routeStops: number;
};

type ModeWarnings = {
    missingStopRefs: number;
    sampleMissingStopIds: string[];
};

type ImportStats = {
    sourceDir: string;
    datasets: number;
    counts: Record<CoreMode, ModeCounts>;
    warnings: {
        missingTripRefs: number;
        sampleMissingTripIds: string[];
        ambiguousRouteRefs: number;
        byMode: Record<CoreMode, ModeWarnings>;
    };
};

type StopRow = {
    stopId: string;
    stopName: string;
    stopLat: string | null;
    stopLon: string | null;
    parentStation: string | null;
};

type StationAccum = {
    operatorId: string;
    stopId: string;
    stopName: string;
    stopLat: string | null;
    stopLon: string | null;
    parentStation: string | null;
    childStopIds: Set<string>;
};

type RouteAccum = {
    operatorId: string;
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
    operatorId: string;
    routeId: string;
    directionId: number;
    stopId: string;
    routeStopSortOrder: number | null;
};

type RouteRef = {
    mode: CoreMode;
    operatorId: string;
    routeId: string;
};

type TripRef = {
    mode: CoreMode;
    operatorId: string;
    routeId: string;
    directionId: number;
};

type ModeState = {
    stations: Map<string, StationAccum>;
    routes: Map<string, RouteAccum>;
    routeStops: Map<string, RouteStopAccum>;
    missingStopRefs: number;
    missingStopSample: Set<string>;
};

const normalizeCsvValue = (value: string) => value.trim();
const normalizeOperatorId = (value: string) => value.trim().toUpperCase();
const normalizeRouteId = (value: string) => value.trim();

const parseIntOrNull = (value?: string): number | null => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.trunc(n) : null;
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

const parseNumericOrNull = (value?: string): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? String(n) : null;
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

const parseCoreModeFromRouteType = (routeTypeRaw?: string): CoreMode | null => {
    const routeType = parseIntOrNull(routeTypeRaw);
    if (routeType === 3) return "bus";
    if (routeType === 0 || routeType === 1) return "tram";
    if (routeType === 5) return "cableway";
    return null;
};

const resolveOperatorId = (agencyIdRaw?: string, routeIdRaw?: string): string | null => {
    const agencyId = normalizeOperatorId(agencyIdRaw ?? "");
    if (agencyId) return agencyId;

    const routeId = routeIdRaw?.trim() ?? "";
    const prefix = routeId.split(":", 1)[0]?.trim() ?? "";
    if (/^[A-Za-z0-9]+$/.test(prefix)) {
        return prefix.toUpperCase();
    }

    return null;
};

const initModeState = (): ModeState => ({
    stations: new Map(),
    routes: new Map(),
    routeStops: new Map(),
    missingStopRefs: 0,
    missingStopSample: new Set(),
});

const stationKey = (operatorId: string, stopId: string) => `${operatorId}|${stopId}`;
const routeKey = (operatorId: string, routeId: string) => `${operatorId}|${routeId}`;
const routeStopKey = (row: { operatorId: string; routeId: string; directionId: number; stopId: string }) =>
    `${row.operatorId}|${row.routeId}|${row.directionId}|${row.stopId}`;

const ensureStation = (
    state: ModeState,
    operatorId: string,
    stopId: string,
    base?: StopRow,
): StationAccum => {
    const key = stationKey(operatorId, stopId);
    const existing = state.stations.get(key);
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
        operatorId,
        stopId,
        stopName: base?.stopName ?? stopId,
        stopLat: base?.stopLat ?? null,
        stopLon: base?.stopLon ?? null,
        parentStation: base?.parentStation ?? null,
        childStopIds: new Set<string>(),
    };
    state.stations.set(key, created);
    return created;
};

const addMissingStopSample = (state: ModeState, stopId: string) => {
    if (!stopId) return;
    if (state.missingStopSample.size < 50) {
        state.missingStopSample.add(stopId);
    }
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

    return Array.from(new Set(out)).sort((a, b) => a.localeCompare(b));
}

async function insertChunks(tx: DbLike, table: unknown, rows: unknown[]) {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        if (chunk.length === 0) continue;
        await tx.insert(table).values(chunk);
    }
}

async function parseStopsFile(filePath: string): Promise<Map<string, StopRow>> {
    const stops = new Map<string, StopRow>();
    const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
    });

    let isHeader = true;
    let stopIdIdx = -1;
    let stopNameIdx = -1;
    let stopLatIdx = -1;
    let stopLonIdx = -1;
    let parentStationIdx = -1;

    for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;

        if (isHeader) {
            isHeader = false;
            const header = parseCsvLine(line);
            stopIdIdx = header.indexOf("stop_id");
            stopNameIdx = header.indexOf("stop_name");
            stopLatIdx = header.indexOf("stop_lat");
            stopLonIdx = header.indexOf("stop_lon");
            parentStationIdx = header.indexOf("parent_station");
            continue;
        }

        if (stopIdIdx < 0 || stopNameIdx < 0) continue;

        const cols = parseCsvLine(line);
        const stopId = normalizeCsvValue(cols[stopIdIdx] ?? "");
        const stopName = normalizeCsvValue(cols[stopNameIdx] ?? "");
        if (!stopId || !stopName) continue;

        stops.set(stopId, {
            stopId,
            stopName,
            stopLat: parseNumericOrNull(cols[stopLatIdx] ?? ""),
            stopLon: parseNumericOrNull(cols[stopLonIdx] ?? ""),
            parentStation: normalizeCsvValue(cols[parentStationIdx] ?? "") || null,
        });
    }

    return stops;
}

async function parseRoutesFile(
    filePath: string,
    stateByMode: Record<CoreMode, ModeState>,
    routeRefsByRouteId: Map<string, RouteRef[]>,
) {
    const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
    });

    let isHeader = true;
    let routeIdIdx = -1;
    let agencyIdIdx = -1;
    let routeShortNameIdx = -1;
    let routeLongNameIdx = -1;
    let routeDescIdx = -1;
    let routeTypeIdx = -1;
    let routeUrlIdx = -1;
    let routeColorIdx = -1;
    let routeTextColorIdx = -1;
    let routeSortOrderIdx = -1;

    for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;

        if (isHeader) {
            isHeader = false;
            const header = parseCsvLine(line);
            routeIdIdx = header.indexOf("route_id");
            agencyIdIdx = header.indexOf("agency_id");
            routeShortNameIdx = header.indexOf("route_short_name");
            routeLongNameIdx = header.indexOf("route_long_name");
            routeDescIdx = header.indexOf("route_desc");
            routeTypeIdx = header.indexOf("route_type");
            routeUrlIdx = header.indexOf("route_url");
            routeColorIdx = header.indexOf("route_color");
            routeTextColorIdx = header.indexOf("route_text_color");
            routeSortOrderIdx = header.indexOf("route_sort_order");
            continue;
        }

        if (routeIdIdx < 0 || routeTypeIdx < 0) continue;

        const cols = parseCsvLine(line);
        const routeId = normalizeRouteId(cols[routeIdIdx] ?? "");
        if (!routeId) continue;

        const mode = parseCoreModeFromRouteType(cols[routeTypeIdx] ?? "");
        if (!mode) continue;

        const operatorId = resolveOperatorId(cols[agencyIdIdx] ?? "", routeId);
        if (!operatorId) continue;

        const state = stateByMode[mode];
        const key = routeKey(operatorId, routeId);

        const routeType = parseIntOrNull(cols[routeTypeIdx] ?? "") ?? (mode === "bus" ? 3 : mode === "tram" ? 0 : 5);
        const routeSortOrder = parseIntOrNull(cols[routeSortOrderIdx] ?? "");

        const existing = state.routes.get(key);
        if (existing) {
            if (!existing.agencyId) existing.agencyId = normalizeCsvValue(cols[agencyIdIdx] ?? "") || null;
            if (!existing.routeShortName) existing.routeShortName = normalizeCsvValue(cols[routeShortNameIdx] ?? "");
            if (!existing.routeLongName) existing.routeLongName = normalizeCsvValue(cols[routeLongNameIdx] ?? "");
            if (!existing.routeDesc) existing.routeDesc = normalizeCsvValue(cols[routeDescIdx] ?? "") || null;
            if (!existing.routeUrl) existing.routeUrl = normalizeCsvValue(cols[routeUrlIdx] ?? "") || null;
            if (!existing.routeColor) existing.routeColor = normalizeCsvValue(cols[routeColorIdx] ?? "") || null;
            if (!existing.routeTextColor) existing.routeTextColor = normalizeCsvValue(cols[routeTextColorIdx] ?? "") || null;
            if (existing.routeSortOrder === null && routeSortOrder !== null) existing.routeSortOrder = routeSortOrder;
        } else {
            state.routes.set(key, {
                operatorId,
                routeId,
                agencyId: normalizeCsvValue(cols[agencyIdIdx] ?? "") || null,
                routeShortName: normalizeCsvValue(cols[routeShortNameIdx] ?? ""),
                routeLongName: normalizeCsvValue(cols[routeLongNameIdx] ?? ""),
                routeDesc: normalizeCsvValue(cols[routeDescIdx] ?? "") || null,
                routeType,
                routeUrl: normalizeCsvValue(cols[routeUrlIdx] ?? "") || null,
                routeColor: normalizeCsvValue(cols[routeColorIdx] ?? "") || null,
                routeTextColor: normalizeCsvValue(cols[routeTextColorIdx] ?? "") || null,
                routeSortOrder,
            });
        }

        const refs = routeRefsByRouteId.get(routeId) ?? [];
        if (!refs.some((ref) => ref.mode === mode && ref.operatorId === operatorId && ref.routeId === routeId)) {
            refs.push({ mode, operatorId, routeId });
            routeRefsByRouteId.set(routeId, refs);
        }
    }
}

async function parseTripsFile(
    filePath: string,
    routeRefsByRouteId: Map<string, RouteRef[]>,
    tripRefsByTripId: Map<string, TripRef>,
): Promise<{ ambiguousRouteRefs: number }> {
    const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
    });

    let isHeader = true;
    let routeIdIdx = -1;
    let tripIdIdx = -1;
    let directionIdIdx = -1;
    let ambiguousRouteRefs = 0;

    for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;

        if (isHeader) {
            isHeader = false;
            const header = parseCsvLine(line);
            routeIdIdx = header.indexOf("route_id");
            tripIdIdx = header.indexOf("trip_id");
            directionIdIdx = header.indexOf("direction_id");
            continue;
        }

        if (routeIdIdx < 0 || tripIdIdx < 0) continue;

        const cols = parseCsvLine(line);
        const routeId = normalizeRouteId(cols[routeIdIdx] ?? "");
        const tripId = normalizeCsvValue(cols[tripIdIdx] ?? "");
        if (!routeId || !tripId) continue;

        const routeRefs = routeRefsByRouteId.get(routeId);
        if (!routeRefs || routeRefs.length === 0) continue;
        if (routeRefs.length > 1) ambiguousRouteRefs++;

        const ref = routeRefs[0]!;
        tripRefsByTripId.set(tripId, {
            mode: ref.mode,
            operatorId: ref.operatorId,
            routeId: ref.routeId,
            directionId: parseDirectionId(cols[directionIdIdx] ?? ""),
        });
    }

    return { ambiguousRouteRefs };
}

async function parseStopTimesFile(
    filePath: string,
    stopsById: Map<string, StopRow>,
    stateByMode: Record<CoreMode, ModeState>,
    tripRefsByTripId: Map<string, TripRef>,
): Promise<{ missingTripRefs: number; sampleMissingTripIds: string[] }> {
    const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
    });

    let isHeader = true;
    let tripIdIdx = -1;
    let stopIdIdx = -1;
    let stopSequenceIdx = -1;

    let missingTripRefs = 0;
    const missingTripSample = new Set<string>();

    for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;

        if (isHeader) {
            isHeader = false;
            const header = parseCsvLine(line);
            tripIdIdx = header.indexOf("trip_id");
            stopIdIdx = header.indexOf("stop_id");
            stopSequenceIdx = header.indexOf("stop_sequence");
            continue;
        }

        if (tripIdIdx < 0 || stopIdIdx < 0) continue;

        const cols = parseCsvLine(line);
        const tripId = normalizeCsvValue(cols[tripIdIdx] ?? "");
        const stopId = normalizeCsvValue(cols[stopIdIdx] ?? "");
        if (!tripId || !stopId) continue;

        const tripRef = tripRefsByTripId.get(tripId);
        if (!tripRef) {
            missingTripRefs++;
            if (missingTripSample.size < 50) missingTripSample.add(tripId);
            continue;
        }

        const state = stateByMode[tripRef.mode];
        const stop = stopsById.get(stopId);
        if (!stop) {
            state.missingStopRefs++;
            addMissingStopSample(state, stopId);
            continue;
        }

        const parentStop = stop.parentStation ? stopsById.get(stop.parentStation) : undefined;
        const stationStopId = parentStop ? parentStop.stopId : stop.stopId;
        const stationBase = parentStop ?? stop;

        const station = ensureStation(state, tripRef.operatorId, stationStopId, stationBase);
        station.childStopIds.add(stop.stopId);

        upsertRouteStop(state.routeStops, {
            operatorId: tripRef.operatorId,
            routeId: tripRef.routeId,
            directionId: tripRef.directionId,
            stopId: stationStopId,
            routeStopSortOrder: parseIntOrNull(cols[stopSequenceIdx] ?? ""),
        });
    }

    return {
        missingTripRefs,
        sampleMissingTripIds: Array.from(missingTripSample.values()),
    };
}

export async function runBayAreaCoreLocalImport(db: DbLike, sourceDirInput: string): Promise<ImportStats> {
    const sourceDir = resolve(sourceDirInput);
    const datasetDirs = await collectDatasetDirs(sourceDir);

    if (datasetDirs.length === 0) {
        throw new Error(`No GTFS datasets found under ${sourceDir}. Expected ${REQUIRED_CORE_FILES.join(", ")}`);
    }

    const stateByMode: Record<CoreMode, ModeState> = {
        bus: initModeState(),
        tram: initModeState(),
        cableway: initModeState(),
    };

    let missingTripRefs = 0;
    let ambiguousRouteRefs = 0;
    const missingTripSample = new Set<string>();

    for (const datasetDir of datasetDirs) {
        const stopsPath = join(datasetDir, "stops.txt");
        const routesPath = join(datasetDir, "routes.txt");
        const tripsPath = join(datasetDir, "trips.txt");
        const stopTimesPath = join(datasetDir, "stop_times.txt");

        const [stopsById] = await Promise.all([parseStopsFile(stopsPath)]);
        const routeRefsByRouteId = new Map<string, RouteRef[]>();
        const tripRefsByTripId = new Map<string, TripRef>();

        await parseRoutesFile(routesPath, stateByMode, routeRefsByRouteId);

        const tripStats = await parseTripsFile(tripsPath, routeRefsByRouteId, tripRefsByTripId);
        ambiguousRouteRefs += tripStats.ambiguousRouteRefs;

        const stopTimeStats = await parseStopTimesFile(stopTimesPath, stopsById, stateByMode, tripRefsByTripId);
        missingTripRefs += stopTimeStats.missingTripRefs;
        stopTimeStats.sampleMissingTripIds.forEach((tripId) => {
            if (missingTripSample.size < 50) missingTripSample.add(tripId);
        });
    }

    const stationRowsByMode = {
        bus: Array.from(stateByMode.bus.stations.values()).map((row) => ({
            operatorId: row.operatorId,
            stopId: row.stopId,
            stopName: row.stopName,
            stopLat: row.stopLat,
            stopLon: row.stopLon,
            parentStation: row.parentStation,
            childStopIdsJson: Array.from(row.childStopIds.values()).sort((a, b) => a.localeCompare(b)),
        })),
        tram: Array.from(stateByMode.tram.stations.values()).map((row) => ({
            operatorId: row.operatorId,
            stopId: row.stopId,
            stopName: row.stopName,
            stopLat: row.stopLat,
            stopLon: row.stopLon,
            parentStation: row.parentStation,
            childStopIdsJson: Array.from(row.childStopIds.values()).sort((a, b) => a.localeCompare(b)),
        })),
        cableway: Array.from(stateByMode.cableway.stations.values()).map((row) => ({
            operatorId: row.operatorId,
            stopId: row.stopId,
            stopName: row.stopName,
            stopLat: row.stopLat,
            stopLon: row.stopLon,
            parentStation: row.parentStation,
            childStopIdsJson: Array.from(row.childStopIds.values()).sort((a, b) => a.localeCompare(b)),
        })),
    };

    const routeRowsByMode = {
        bus: Array.from(stateByMode.bus.routes.values()),
        tram: Array.from(stateByMode.tram.routes.values()),
        cableway: Array.from(stateByMode.cableway.routes.values()),
    };

    const routeStopRowsByMode = {
        bus: Array.from(stateByMode.bus.routeStops.values()),
        tram: Array.from(stateByMode.tram.routeStops.values()),
        cableway: Array.from(stateByMode.cableway.routeStops.values()),
    };

    await db.transaction(async (tx: DbLike) => {
        await tx.delete(bayareaBusRouteStops);
        await tx.delete(bayareaBusRoutes);
        await tx.delete(bayareaBusStations);

        await tx.delete(bayareaTramRouteStops);
        await tx.delete(bayareaTramRoutes);
        await tx.delete(bayareaTramStations);

        await tx.delete(bayareaCablewayRouteStops);
        await tx.delete(bayareaCablewayRoutes);
        await tx.delete(bayareaCablewayStations);

        await insertChunks(tx, bayareaBusStations, stationRowsByMode.bus);
        await insertChunks(tx, bayareaBusRoutes, routeRowsByMode.bus);
        await insertChunks(tx, bayareaBusRouteStops, routeStopRowsByMode.bus);

        await insertChunks(tx, bayareaTramStations, stationRowsByMode.tram);
        await insertChunks(tx, bayareaTramRoutes, routeRowsByMode.tram);
        await insertChunks(tx, bayareaTramRouteStops, routeStopRowsByMode.tram);

        await insertChunks(tx, bayareaCablewayStations, stationRowsByMode.cableway);
        await insertChunks(tx, bayareaCablewayRoutes, routeRowsByMode.cableway);
        await insertChunks(tx, bayareaCablewayRouteStops, routeStopRowsByMode.cableway);
    });

    const counts = CORE_MODES.reduce(
        (acc, mode) => {
            acc[mode] = {
                stations: stationRowsByMode[mode].length,
                routes: routeRowsByMode[mode].length,
                routeStops: routeStopRowsByMode[mode].length,
            };
            return acc;
        },
        {} as Record<CoreMode, ModeCounts>,
    );

    const warningsByMode = CORE_MODES.reduce(
        (acc, mode) => {
            acc[mode] = {
                missingStopRefs: stateByMode[mode].missingStopRefs,
                sampleMissingStopIds: Array.from(stateByMode[mode].missingStopSample.values()),
            };
            return acc;
        },
        {} as Record<CoreMode, ModeWarnings>,
    );

    return {
        sourceDir,
        datasets: datasetDirs.length,
        counts,
        warnings: {
            missingTripRefs,
            sampleMissingTripIds: Array.from(missingTripSample.values()),
            ambiguousRouteRefs,
            byMode: warningsByMode,
        },
    };
}
