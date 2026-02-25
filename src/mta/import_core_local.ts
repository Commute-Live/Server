import { constants as fsConstants, createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
    mtaBusRouteStops,
    mtaBusRoutes,
    mtaBusStations,
    mtaLirrRouteStops,
    mtaLirrRoutes,
    mtaLirrStations,
    mtaMnrRouteStops,
    mtaMnrRoutes,
    mtaMnrStations,
    mtaSubwayRouteStops,
    mtaSubwayRoutes,
    mtaSubwayStations,
} from "../db/schema/schema.ts";

type DbLike = {
    delete: Function;
    insert: Function;
    transaction: Function;
};

type MtaMode = "subway" | "bus" | "lirr" | "mnr";

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
    busDatasets: number;
    counts: Record<MtaMode, ModeCounts>;
    warnings: Record<MtaMode, ModeWarnings>;
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

type ProcessResult = {
    counts: ModeCounts;
    warnings: ModeWarnings;
    stationsRows: Array<{
        stopId: string;
        stopName: string;
        stopLat: string | null;
        stopLon: string | null;
        parentStation: string | null;
        childStopIdsJson: string[];
    }>;
    routesRows: Array<{
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
    }>;
    routeStopsRows: Array<{
        routeId: string;
        directionId: number;
        stopId: string;
        routeStopSortOrder: number | null;
    }>;
};

const REQUIRED_CORE_FILES = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"] as const;
const BATCH_SIZE = 1000;

const MODE_DEFAULT_ROUTE_TYPE: Record<MtaMode, number> = {
    subway: 1,
    bus: 3,
    lirr: 2,
    mnr: 2,
};

const normalizeCsvValue = (value: string) => value.trim();

const normalizeRouteId = (value: string) => value.trim().toUpperCase();

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
    if (raw === "N") return 0;
    if (raw === "S") return 1;
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

        let entries: Array<{
            name: string;
            isDirectory: () => boolean;
        }> = [];
        try {
            entries = await readdir(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
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

async function resolveSingleDatasetDir(root: string, mode: string): Promise<string> {
    const dirs = await collectDatasetDirs(root);
    if (dirs.length === 0) {
        throw new Error(`Missing GTFS dataset for mode ${mode}: ${root}`);
    }
    if (dirs.length > 1) {
        throw new Error(`Expected one GTFS dataset for mode ${mode}, found ${dirs.length} under ${root}`);
    }
    return dirs[0] as string;
}

const getCsvValue = (cols: string[], index: Map<string, number>, name: string) => {
    const idx = index.get(name);
    if (idx === undefined) return "";
    return normalizeCsvValue(cols[idx] ?? "");
};

async function forEachCsvRow(
    path: string,
    requiredColumns: string[],
    onRow: (cols: string[], index: Map<string, number>) => Promise<void> | void,
) {
    const rl = createInterface({
        input: createReadStream(path),
        crlfDelay: Infinity,
    });

    let index: Map<string, number> | null = null;

    for await (const rawLine of rl) {
        if (!index) {
            const header = parseCsvLine(rawLine).map((v, idx) => (idx === 0 ? v.replace(/^\uFEFF/, "") : v).trim());
            const map = new Map<string, number>();
            for (let i = 0; i < header.length; i++) {
                const key = (header[i] ?? "").trim();
                if (!key) continue;
                map.set(key, i);
            }

            for (const col of requiredColumns) {
                if (!map.has(col)) {
                    throw new Error(`Missing required column ${col} in ${path}`);
                }
            }
            index = map;
            continue;
        }

        if (!rawLine.trim()) continue;
        const cols = parseCsvLine(rawLine);
        await onRow(cols, index);
    }

    if (!index) {
        throw new Error(`CSV file is empty or missing header: ${path}`);
    }
}

function mergeStation(
    stationMap: Map<string, StationAccum>,
    rawStopToStation: Map<string, string>,
    mode: MtaMode,
    stopIdRaw: string,
    stopNameRaw: string,
    stopLatRaw: string,
    stopLonRaw: string,
    parentStationRaw: string,
) {
    const rawStopId = stopIdRaw.trim();
    const stopName = stopNameRaw.trim() || rawStopId;
    if (!rawStopId) return;

    const parentStation = parentStationRaw.trim();
    const stationKey = mode === "bus" ? rawStopId : parentStation || rawStopId;
    rawStopToStation.set(rawStopId, stationKey);

    let station = stationMap.get(stationKey);
    if (!station) {
        station = {
            stopId: stationKey,
            stopName,
            stopLat: parseNumericOrNull(stopLatRaw),
            stopLon: parseNumericOrNull(stopLonRaw),
            parentStation: parentStation || null,
            childStopIds: new Set<string>(),
        };
        stationMap.set(stationKey, station);
    } else {
        if (!station.stopName && stopName) station.stopName = stopName;
        if (station.stopName === station.stopId && stopName) station.stopName = stopName;
        if (!station.stopLat) station.stopLat = parseNumericOrNull(stopLatRaw);
        if (!station.stopLon) station.stopLon = parseNumericOrNull(stopLonRaw);
    }

    if (mode !== "bus") {
        station.childStopIds.add(rawStopId);
    }
}

function mergeRoute(routeMap: Map<string, RouteAccum>, mode: MtaMode, input: RouteAccum) {
    const existing = routeMap.get(input.routeId);
    if (!existing) {
        routeMap.set(input.routeId, input);
        return;
    }

    if (!existing.agencyId && input.agencyId) existing.agencyId = input.agencyId;
    if (!existing.routeShortName && input.routeShortName) existing.routeShortName = input.routeShortName;
    if (!existing.routeLongName && input.routeLongName) existing.routeLongName = input.routeLongName;
    if (!existing.routeDesc && input.routeDesc) existing.routeDesc = input.routeDesc;
    if (existing.routeType === MODE_DEFAULT_ROUTE_TYPE[mode] && input.routeType !== MODE_DEFAULT_ROUTE_TYPE[mode]) {
        existing.routeType = input.routeType;
    }
    if (!existing.routeUrl && input.routeUrl) existing.routeUrl = input.routeUrl;
    if (!existing.routeColor && input.routeColor) existing.routeColor = input.routeColor;
    if (!existing.routeTextColor && input.routeTextColor) existing.routeTextColor = input.routeTextColor;
    if (existing.routeSortOrder === null && input.routeSortOrder !== null) existing.routeSortOrder = input.routeSortOrder;
}

function mergeRouteStop(routeStopMap: Map<string, RouteStopAccum>, next: RouteStopAccum) {
    const key = `${next.routeId}|${next.directionId}|${next.stopId}`;
    const existing = routeStopMap.get(key);
    if (!existing) {
        routeStopMap.set(key, next);
        return;
    }

    if (existing.routeStopSortOrder === null && next.routeStopSortOrder !== null) {
        existing.routeStopSortOrder = next.routeStopSortOrder;
        return;
    }
    if (
        existing.routeStopSortOrder !== null &&
        next.routeStopSortOrder !== null &&
        next.routeStopSortOrder < existing.routeStopSortOrder
    ) {
        existing.routeStopSortOrder = next.routeStopSortOrder;
    }
}

async function processMode(mode: MtaMode, datasetDirs: string[]): Promise<ProcessResult> {
    const stationMap = new Map<string, StationAccum>();
    const routeMap = new Map<string, RouteAccum>();
    const routeStopMap = new Map<string, RouteStopAccum>();

    let missingTripRefs = 0;
    const missingStopRefSet = new Set<string>();

    for (const datasetDir of datasetDirs) {
        const stopsPath = join(datasetDir, "stops.txt");
        const routesPath = join(datasetDir, "routes.txt");
        const tripsPath = join(datasetDir, "trips.txt");
        const stopTimesPath = join(datasetDir, "stop_times.txt");

        const rawStopToStation = new Map<string, string>();

        await forEachCsvRow(stopsPath, ["stop_id", "stop_name"], (cols, index) => {
            mergeStation(
                stationMap,
                rawStopToStation,
                mode,
                getCsvValue(cols, index, "stop_id"),
                getCsvValue(cols, index, "stop_name"),
                getCsvValue(cols, index, "stop_lat"),
                getCsvValue(cols, index, "stop_lon"),
                getCsvValue(cols, index, "parent_station"),
            );
        });

        await forEachCsvRow(routesPath, ["route_id"], (cols, index) => {
            const routeId = normalizeRouteId(getCsvValue(cols, index, "route_id"));
            if (!routeId) return;

            mergeRoute(routeMap, mode, {
                routeId,
                agencyId: getCsvValue(cols, index, "agency_id") || null,
                routeShortName: getCsvValue(cols, index, "route_short_name") || "",
                routeLongName: getCsvValue(cols, index, "route_long_name") || "",
                routeDesc: getCsvValue(cols, index, "route_desc") || null,
                routeType: parseIntOrNull(getCsvValue(cols, index, "route_type")) ?? MODE_DEFAULT_ROUTE_TYPE[mode],
                routeUrl: getCsvValue(cols, index, "route_url") || null,
                routeColor: getCsvValue(cols, index, "route_color") || null,
                routeTextColor: getCsvValue(cols, index, "route_text_color") || null,
                routeSortOrder: parseIntOrNull(getCsvValue(cols, index, "route_sort_order")),
            });
        });

        const tripMap = new Map<string, { routeId: string; directionId: number }>();
        await forEachCsvRow(tripsPath, ["trip_id", "route_id"], (cols, index) => {
            const tripId = getCsvValue(cols, index, "trip_id");
            const routeId = normalizeRouteId(getCsvValue(cols, index, "route_id"));
            if (!tripId || !routeId) return;
            tripMap.set(tripId, {
                routeId,
                directionId: parseDirectionId(getCsvValue(cols, index, "direction_id")),
            });
        });

        await forEachCsvRow(stopTimesPath, ["trip_id", "stop_id"], (cols, index) => {
            const tripId = getCsvValue(cols, index, "trip_id");
            const rawStopId = getCsvValue(cols, index, "stop_id");
            if (!tripId || !rawStopId) return;

            const trip = tripMap.get(tripId);
            if (!trip) {
                missingTripRefs += 1;
                return;
            }

            const stationStopId = rawStopToStation.get(rawStopId) ?? rawStopId;
            if (!stationMap.has(stationStopId)) {
                missingStopRefSet.add(rawStopId);
                return;
            }

            mergeRouteStop(routeStopMap, {
                routeId: trip.routeId,
                directionId: trip.directionId,
                stopId: stationStopId,
                routeStopSortOrder: parseIntOrNull(getCsvValue(cols, index, "stop_sequence")),
            });
        });
    }

    const stationsRows = Array.from(stationMap.values())
        .sort((a, b) => a.stopId.localeCompare(b.stopId))
        .map((row) => {
            const childStopIds = mode === "bus" ? [] : Array.from(row.childStopIds).sort((a, b) => a.localeCompare(b));
            if (mode !== "bus" && childStopIds.length === 0) {
                childStopIds.push(row.stopId);
            }

            return {
                stopId: row.stopId,
                stopName: row.stopName || row.stopId,
                stopLat: row.stopLat,
                stopLon: row.stopLon,
                parentStation: row.parentStation,
                childStopIdsJson: childStopIds,
            };
        });

    const routesRows = Array.from(routeMap.values())
        .sort((a, b) => a.routeId.localeCompare(b.routeId))
        .map((row) => ({ ...row }));

    const routeStopsRows = Array.from(routeStopMap.values())
        .sort((a, b) => {
            const byRoute = a.routeId.localeCompare(b.routeId);
            if (byRoute !== 0) return byRoute;
            const byDirection = a.directionId - b.directionId;
            if (byDirection !== 0) return byDirection;
            const aSeq = a.routeStopSortOrder ?? Number.MAX_SAFE_INTEGER;
            const bSeq = b.routeStopSortOrder ?? Number.MAX_SAFE_INTEGER;
            if (aSeq !== bSeq) return aSeq - bSeq;
            return a.stopId.localeCompare(b.stopId);
        })
        .map((row) => ({ ...row }));

    return {
        counts: {
            stations: stationsRows.length,
            routes: routesRows.length,
            routeStops: routeStopsRows.length,
        },
        warnings: {
            missingTripRefs,
            missingStopRefs: missingStopRefSet.size,
            sampleMissingStopIds: Array.from(missingStopRefSet).slice(0, 50),
        },
        stationsRows,
        routesRows,
        routeStopsRows,
    };
}

async function insertChunks(tx: DbLike, table: unknown, rows: unknown[]) {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        if (chunk.length === 0) continue;
        await tx.insert(table).values(chunk);
    }
}

export async function runMtaCoreLocalImport(db: DbLike, sourceDirInput: string): Promise<ImportStats> {
    const sourceDir = resolve(sourceDirInput);

    const subwayDir = await resolveSingleDatasetDir(join(sourceDir, "subway"), "subway");
    const lirrDir = await resolveSingleDatasetDir(join(sourceDir, "lirr"), "lirr");
    const mnrDir = await resolveSingleDatasetDir(join(sourceDir, "mnr"), "mnr");
    const busDirs = await collectDatasetDirs(join(sourceDir, "bus"));
    if (busDirs.length === 0) {
        throw new Error(`Missing GTFS dataset for mode bus: ${join(sourceDir, "bus")}`);
    }

    const subway = await processMode("subway", [subwayDir]);
    const lirr = await processMode("lirr", [lirrDir]);
    const mnr = await processMode("mnr", [mnrDir]);
    const bus = await processMode("bus", busDirs);

    await db.transaction(async (tx: DbLike) => {
        await tx.delete(mtaSubwayRouteStops);
        await tx.delete(mtaSubwayRoutes);
        await tx.delete(mtaSubwayStations);
        await tx.delete(mtaBusRouteStops);
        await tx.delete(mtaBusRoutes);
        await tx.delete(mtaBusStations);
        await tx.delete(mtaLirrRouteStops);
        await tx.delete(mtaLirrRoutes);
        await tx.delete(mtaLirrStations);
        await tx.delete(mtaMnrRouteStops);
        await tx.delete(mtaMnrRoutes);
        await tx.delete(mtaMnrStations);

        await insertChunks(tx, mtaSubwayStations, subway.stationsRows);
        await insertChunks(tx, mtaSubwayRoutes, subway.routesRows);
        await insertChunks(tx, mtaSubwayRouteStops, subway.routeStopsRows);

        await insertChunks(tx, mtaBusStations, bus.stationsRows);
        await insertChunks(tx, mtaBusRoutes, bus.routesRows);
        await insertChunks(tx, mtaBusRouteStops, bus.routeStopsRows);

        await insertChunks(tx, mtaLirrStations, lirr.stationsRows);
        await insertChunks(tx, mtaLirrRoutes, lirr.routesRows);
        await insertChunks(tx, mtaLirrRouteStops, lirr.routeStopsRows);

        await insertChunks(tx, mtaMnrStations, mnr.stationsRows);
        await insertChunks(tx, mtaMnrRoutes, mnr.routesRows);
        await insertChunks(tx, mtaMnrRouteStops, mnr.routeStopsRows);
    });

    return {
        sourceDir,
        busDatasets: busDirs.length,
        counts: {
            subway: subway.counts,
            bus: bus.counts,
            lirr: lirr.counts,
            mnr: mnr.counts,
        },
        warnings: {
            subway: subway.warnings,
            bus: bus.warnings,
            lirr: lirr.warnings,
            mnr: mnr.warnings,
        },
    };
}
