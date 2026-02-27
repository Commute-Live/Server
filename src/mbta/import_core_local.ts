import { constants as fsConstants, createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
    mbtaBusRouteStops,
    mbtaBusRoutes,
    mbtaBusStations,
    mbtaFerryRouteStops,
    mbtaFerryRoutes,
    mbtaFerryStations,
    mbtaRailRouteStops,
    mbtaRailRoutes,
    mbtaRailStations,
    mbtaSubwayRouteStops,
    mbtaSubwayRoutes,
    mbtaSubwayStations,
} from "../db/schema/schema.ts";

type DbLike = {
    delete: Function;
    insert: Function;
    transaction: Function;
};

type MbtaMode = "subway" | "bus" | "rail" | "ferry";

const CORE_MODES: MbtaMode[] = ["subway", "bus", "rail", "ferry"];

const MODE_DEFAULT_ROUTE_TYPE: Record<MbtaMode, number> = {
    subway: 1,
    bus: 3,
    rail: 2,
    ferry: 4,
};

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
    counts: Record<MbtaMode, ModeCounts>;
    warnings: Record<MbtaMode, ModeWarnings>;
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
    lineId: string | null;
};

type RouteStopAccum = {
    routeId: string;
    directionId: number;
    stopId: string;
    routeStopSortOrder: number | null;
};

type TripRef = {
    mode: MbtaMode;
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

const normalizeCsvValue = (value: string) => value.trim();
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

const parseCoreModeFromRouteType = (routeTypeRaw?: string): MbtaMode | null => {
    const routeType = parseIntOrNull(routeTypeRaw);
    if (routeType === 0 || routeType === 1) return "subway";
    if (routeType === 2) return "rail";
    if (routeType === 3) return "bus";
    if (routeType === 4) return "ferry";
    return null;
};

const initModeState = (): ModeState => ({
    stations: new Map(),
    routes: new Map(),
    routeStops: new Map(),
    missingTripRefs: 0,
    missingStopRefs: 0,
    missingStopSample: new Set(),
});

const addMissingStopSample = (state: ModeState, stopId: string) => {
    if (!stopId) return;
    if (state.missingStopSample.size < 20) {
        state.missingStopSample.add(stopId);
    }
};

const ensureStation = (
    state: ModeState,
    stopId: string,
    base?: StopRow,
): StationAccum => {
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

const routeStopKey = (row: { routeId: string; directionId: number; stopId: string }) =>
    `${row.routeId}|${row.directionId}|${row.stopId}`;

const upsertRouteStop = (
    routeStops: Map<string, RouteStopAccum>,
    next: RouteStopAccum,
) => {
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

        const stopRow: StopRow = {
            stopId,
            stopName,
            stopLat: parseNumericOrNull(cols[stopLatIdx] ?? ""),
            stopLon: parseNumericOrNull(cols[stopLonIdx] ?? ""),
            parentStation: normalizeCsvValue(cols[parentStationIdx] ?? "") || null,
        };
        stops.set(stopId, stopRow);
    }

    return stops;
}

async function parseRoutesFile(
    filePath: string,
    stateByMode: Record<MbtaMode, ModeState>,
    routeModeById: Map<string, MbtaMode>,
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
    let lineIdIdx = -1;

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
            lineIdIdx = header.indexOf("line_id");
            continue;
        }

        if (routeIdIdx < 0 || routeTypeIdx < 0) continue;

        const cols = parseCsvLine(line);
        const rawRouteId = normalizeCsvValue(cols[routeIdIdx] ?? "");
        if (!rawRouteId) continue;
        const mode = parseCoreModeFromRouteType(cols[routeTypeIdx] ?? "");
        if (!mode) continue;

        const routeId = normalizeRouteId(rawRouteId);
        routeModeById.set(routeId, mode);
        const state = stateByMode[mode];
        if (state.routes.has(routeId)) continue;

        const routeType = parseIntOrNull(cols[routeTypeIdx] ?? "") ?? MODE_DEFAULT_ROUTE_TYPE[mode];
        state.routes.set(routeId, {
            routeId,
            agencyId: normalizeCsvValue(cols[agencyIdIdx] ?? "") || null,
            routeShortName: normalizeCsvValue(cols[routeShortNameIdx] ?? ""),
            routeLongName: normalizeCsvValue(cols[routeLongNameIdx] ?? ""),
            routeDesc: normalizeCsvValue(cols[routeDescIdx] ?? "") || null,
            routeType,
            routeUrl: normalizeCsvValue(cols[routeUrlIdx] ?? "") || null,
            routeColor: normalizeCsvValue(cols[routeColorIdx] ?? "") || null,
            routeTextColor: normalizeCsvValue(cols[routeTextColorIdx] ?? "") || null,
            routeSortOrder: parseIntOrNull(cols[routeSortOrderIdx] ?? ""),
            lineId: normalizeCsvValue(cols[lineIdIdx] ?? "") || null,
        });
    }
}

async function parseTripsFile(filePath: string, routeModeById: Map<string, MbtaMode>): Promise<Map<string, TripRef>> {
    const tripRefs = new Map<string, TripRef>();
    const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
    });

    let isHeader = true;
    let tripIdIdx = -1;
    let routeIdIdx = -1;
    let directionIdIdx = -1;

    for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;

        if (isHeader) {
            isHeader = false;
            const header = parseCsvLine(line);
            tripIdIdx = header.indexOf("trip_id");
            routeIdIdx = header.indexOf("route_id");
            directionIdIdx = header.indexOf("direction_id");
            continue;
        }

        if (tripIdIdx < 0 || routeIdIdx < 0) continue;

        const cols = parseCsvLine(line);
        const tripId = normalizeCsvValue(cols[tripIdIdx] ?? "");
        const routeId = normalizeRouteId(cols[routeIdIdx] ?? "");
        if (!tripId || !routeId) continue;
        const mode = routeModeById.get(routeId);
        if (!mode) continue;

        tripRefs.set(tripId, {
            mode,
            routeId,
            directionId: parseDirectionId(cols[directionIdIdx] ?? ""),
        });
    }

    return tripRefs;
}

const resolveStationId = (
    mode: MbtaMode,
    stopId: string,
    stopsById: Map<string, StopRow>,
): string | null => {
    if (!stopId) return null;
    if (mode === "bus" || mode === "ferry") return stopId;
    const stop = stopsById.get(stopId);
    const parent = stop?.parentStation ?? "";
    return parent || stopId;
};

async function parseStopTimesFile(
    filePath: string,
    stopsById: Map<string, StopRow>,
    tripRefs: Map<string, TripRef>,
    stateByMode: Record<MbtaMode, ModeState>,
) {
    const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
    });

    let isHeader = true;
    let tripIdIdx = -1;
    let stopIdIdx = -1;
    let stopSeqIdx = -1;

    for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;

        if (isHeader) {
            isHeader = false;
            const header = parseCsvLine(line);
            tripIdIdx = header.indexOf("trip_id");
            stopIdIdx = header.indexOf("stop_id");
            stopSeqIdx = header.indexOf("stop_sequence");
            continue;
        }

        if (tripIdIdx < 0 || stopIdIdx < 0) continue;

        const cols = parseCsvLine(line);
        const tripId = normalizeCsvValue(cols[tripIdIdx] ?? "");
        const rawStopId = normalizeCsvValue(cols[stopIdIdx] ?? "");
        const stopSequence = parseIntOrNull(cols[stopSeqIdx] ?? "");
        if (!tripId || !rawStopId) continue;

        const trip = tripRefs.get(tripId);
        if (!trip) {
            continue;
        }

        const mode = trip.mode;
        const state = stateByMode[mode];
        const stationId = resolveStationId(mode, rawStopId, stopsById);
        if (!stationId) {
            state.missingStopRefs++;
            addMissingStopSample(state, rawStopId);
            continue;
        }

        const stationBase = stopsById.get(stationId) ?? stopsById.get(rawStopId);
        const station = ensureStation(state, stationId, stationBase);

        if (mode === "subway" || mode === "rail") {
            station.childStopIds.add(stationId);
            station.childStopIds.add(rawStopId);
        } else {
            station.childStopIds.add(stationId);
        }

        upsertRouteStop(state.routeStops, {
            routeId: trip.routeId,
            directionId: trip.directionId,
            stopId: stationId,
            routeStopSortOrder: stopSequence,
        });
    }
}

const stationRows = (state: ModeState) =>
    Array.from(state.stations.values())
        .sort((a, b) => a.stopId.localeCompare(b.stopId))
        .map((row) => ({
            stopId: row.stopId,
            stopName: row.stopName,
            stopLat: row.stopLat,
            stopLon: row.stopLon,
            parentStation: row.parentStation,
            childStopIdsJson: Array.from(row.childStopIds).sort((a, b) => a.localeCompare(b)),
        }));

const routeRows = (state: ModeState) =>
    Array.from(state.routes.values())
        .sort((a, b) => a.routeId.localeCompare(b.routeId))
        .map((row) => ({
            routeId: row.routeId,
            agencyId: row.agencyId,
            routeShortName: row.routeShortName,
            routeLongName: row.routeLongName,
            routeDesc: row.routeDesc,
            routeType: row.routeType,
            routeUrl: row.routeUrl,
            routeColor: row.routeColor,
            routeTextColor: row.routeTextColor,
            routeSortOrder: row.routeSortOrder,
            lineId: row.lineId,
        }));

const routeStopRows = (state: ModeState) =>
    Array.from(state.routeStops.values())
        .sort((a, b) => {
            const byRoute = a.routeId.localeCompare(b.routeId);
            if (byRoute !== 0) return byRoute;
            const byDirection = a.directionId - b.directionId;
            if (byDirection !== 0) return byDirection;
            return a.stopId.localeCompare(b.stopId);
        })
        .map((row) => ({
            routeId: row.routeId,
            directionId: row.directionId,
            stopId: row.stopId,
            routeStopSortOrder: row.routeStopSortOrder,
        }));

const modeCounts = (state: ModeState): ModeCounts => ({
    stations: state.stations.size,
    routes: state.routes.size,
    routeStops: state.routeStops.size,
});

const modeWarnings = (state: ModeState): ModeWarnings => ({
    missingTripRefs: state.missingTripRefs,
    missingStopRefs: state.missingStopRefs,
    sampleMissingStopIds: Array.from(state.missingStopSample).sort((a, b) => a.localeCompare(b)).slice(0, 20),
});

const stationsTableByMode: Record<MbtaMode, unknown> = {
    subway: mbtaSubwayStations,
    bus: mbtaBusStations,
    rail: mbtaRailStations,
    ferry: mbtaFerryStations,
};

const routesTableByMode: Record<MbtaMode, unknown> = {
    subway: mbtaSubwayRoutes,
    bus: mbtaBusRoutes,
    rail: mbtaRailRoutes,
    ferry: mbtaFerryRoutes,
};

const routeStopsTableByMode: Record<MbtaMode, unknown> = {
    subway: mbtaSubwayRouteStops,
    bus: mbtaBusRouteStops,
    rail: mbtaRailRouteStops,
    ferry: mbtaFerryRouteStops,
};

export async function runMbtaCoreLocalImport(db: DbLike, sourceDirInput: string): Promise<ImportStats> {
    const sourceDir = resolve(sourceDirInput);
    const datasetDirs = await collectDatasetDirs(sourceDir);
    if (datasetDirs.length === 0) {
        throw new Error(`No MBTA dataset directories found under ${sourceDir}`);
    }

    const stateByMode: Record<MbtaMode, ModeState> = {
        subway: initModeState(),
        bus: initModeState(),
        rail: initModeState(),
        ferry: initModeState(),
    };

    for (const datasetDir of datasetDirs) {
        const stopsPath = join(datasetDir, "stops.txt");
        const routesPath = join(datasetDir, "routes.txt");
        const tripsPath = join(datasetDir, "trips.txt");
        const stopTimesPath = join(datasetDir, "stop_times.txt");

        const stopsById = await parseStopsFile(stopsPath);
        const routeModeById = new Map<string, MbtaMode>();
        await parseRoutesFile(routesPath, stateByMode, routeModeById);
        const tripRefs = await parseTripsFile(tripsPath, routeModeById);
        await parseStopTimesFile(stopTimesPath, stopsById, tripRefs, stateByMode);
    }

    const stationsRowsByMode: Record<MbtaMode, unknown[]> = {
        subway: stationRows(stateByMode.subway),
        bus: stationRows(stateByMode.bus),
        rail: stationRows(stateByMode.rail),
        ferry: stationRows(stateByMode.ferry),
    };

    const routesRowsByMode: Record<MbtaMode, unknown[]> = {
        subway: routeRows(stateByMode.subway),
        bus: routeRows(stateByMode.bus),
        rail: routeRows(stateByMode.rail),
        ferry: routeRows(stateByMode.ferry),
    };

    const routeStopsRowsByMode: Record<MbtaMode, unknown[]> = {
        subway: routeStopRows(stateByMode.subway),
        bus: routeStopRows(stateByMode.bus),
        rail: routeStopRows(stateByMode.rail),
        ferry: routeStopRows(stateByMode.ferry),
    };

    await db.transaction(async (tx: DbLike) => {
        for (const mode of CORE_MODES) {
            await tx.delete(routeStopsTableByMode[mode]);
            await tx.delete(routesTableByMode[mode]);
            await tx.delete(stationsTableByMode[mode]);
        }

        for (const mode of CORE_MODES) {
            await insertChunks(tx, stationsTableByMode[mode], stationsRowsByMode[mode]);
            await insertChunks(tx, routesTableByMode[mode], routesRowsByMode[mode]);
            await insertChunks(tx, routeStopsTableByMode[mode], routeStopsRowsByMode[mode]);
        }
    });

    return {
        sourceDir,
        datasets: datasetDirs.length,
        counts: {
            subway: modeCounts(stateByMode.subway),
            bus: modeCounts(stateByMode.bus),
            rail: modeCounts(stateByMode.rail),
            ferry: modeCounts(stateByMode.ferry),
        },
        warnings: {
            subway: modeWarnings(stateByMode.subway),
            bus: modeWarnings(stateByMode.bus),
            rail: modeWarnings(stateByMode.rail),
            ferry: modeWarnings(stateByMode.ferry),
        },
    };
}
