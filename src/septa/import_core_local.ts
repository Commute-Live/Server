import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
    septaBusRouteStops,
    septaBusRoutes,
    septaBusStops,
    septaRailRouteStops,
    septaRailRoutes,
    septaRailStops,
    septaTrolleyRouteStops,
    septaTrolleyRoutes,
    septaTrolleyStops,
} from "../db/schema/schema.ts";

type DbLike = {
    delete: Function;
    insert: Function;
    transaction: Function;
};

type CsvRecord = Record<string, string>;

type ParseResult = {
    header: string[];
    rows: CsvRecord[];
};

type ImportStats = {
    sourceDir: string;
    counts: {
        rail: { stops: number; routes: number; routeStops: number };
        bus: { stops: number; routes: number; routeStops: number };
        trolley: { stops: number; routes: number; routeStops: number };
    };
    warnings: {
        railMissingStopRefs: number;
        busMissingStopRefs: number;
        trolleyMissingStopRefs: number;
        sampleMissingStopIds: string[];
    };
};

const REQUIRED_CORE_FILES = ["stops.txt", "routes.txt", "route_stops.txt"] as const;
const BATCH_SIZE = 1000;

const normalizeCsvValue = (value: string) => value.trim();

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

const parseIntRequired = (value: string | undefined, field: string, filePath: string): number => {
    const parsed = parseIntOrNull(value);
    if (parsed === null) {
        throw new Error(`Invalid integer in ${filePath} field ${field}: ${String(value ?? "")}`);
    }
    return parsed;
};

const parseNumericOrNull = (value?: string): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? String(n) : null;
};

async function parseCsvFile(path: string): Promise<ParseResult> {
    const rl = createInterface({
        input: createReadStream(path),
        crlfDelay: Infinity,
    });

    let header: string[] | null = null;
    const rows: CsvRecord[] = [];

    for await (const rawLine of rl) {
        if (!header) {
            const parsedHeader = parseCsvLine(rawLine);
            header = parsedHeader.map((v, idx) => (idx === 0 ? v.replace(/^\uFEFF/, "") : v).trim());
            continue;
        }
        if (!rawLine.trim()) continue;
        const cols = parseCsvLine(rawLine);
        const row: CsvRecord = {};
        for (let i = 0; i < header.length; i++) {
            const key = (header[i] ?? "").trim();
            if (!key) continue;
            row[key] = normalizeCsvValue(cols[i] ?? "");
        }
        rows.push(row);
    }

    if (!header) {
        throw new Error(`CSV file is empty or missing header: ${path}`);
    }
    return { header, rows };
}

async function assertReadable(path: string) {
    await access(path, fsConstants.R_OK);
}

async function assertRequiredFiles(sourceDir: string) {
    for (const mode of ["rail", "bus"] as const) {
        for (const fileName of REQUIRED_CORE_FILES) {
            const filePath = join(sourceDir, mode, fileName);
            try {
                await assertReadable(filePath);
            } catch {
                throw new Error(`Missing required file: ${filePath}`);
            }
        }
    }
}

async function insertChunks(tx: DbLike, table: unknown, rows: unknown[]) {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        if (chunk.length === 0) continue;
        await tx.insert(table).values(chunk);
    }
}

const isTrolleyRoute = (routeId: string, routeType: number) => {
    const normalized = routeId.trim().toUpperCase();
    if (routeType === 0) return true;
    return normalized.startsWith("T") || normalized.startsWith("G") || normalized === "D1" || normalized === "D2";
};

export async function runSeptaCoreLocalImport(db: DbLike, sourceDirInput: string): Promise<ImportStats> {
    const sourceDir = resolve(sourceDirInput);
    await assertRequiredFiles(sourceDir);

    const railStopsPath = join(sourceDir, "rail", "stops.txt");
    const railRoutesPath = join(sourceDir, "rail", "routes.txt");
    const railRouteStopsPath = join(sourceDir, "rail", "route_stops.txt");
    const busStopsPath = join(sourceDir, "bus", "stops.txt");
    const busRoutesPath = join(sourceDir, "bus", "routes.txt");
    const busRouteStopsPath = join(sourceDir, "bus", "route_stops.txt");

    const [railStopsCsv, railRoutesCsv, railRouteStopsCsv, busStopsCsv, busRoutesCsv, busRouteStopsCsv] =
        await Promise.all([
            parseCsvFile(railStopsPath),
            parseCsvFile(railRoutesPath),
            parseCsvFile(railRouteStopsPath),
            parseCsvFile(busStopsPath),
            parseCsvFile(busRoutesPath),
            parseCsvFile(busRouteStopsPath),
        ]);

    const railStopsRows = railStopsCsv.rows.map((row) => {
        const stopId = row.stop_id?.trim() ?? "";
        const stopName = row.stop_name?.trim() ?? "";
        if (!stopId || !stopName) {
            throw new Error(`Invalid rail stop row in ${railStopsPath}`);
        }
        return {
            stopId,
            stopName,
            stopDesc: row.stop_desc?.trim() || null,
            stopLat: parseNumericOrNull(row.stop_lat),
            stopLon: parseNumericOrNull(row.stop_lon),
            zoneId: row.zone_id?.trim() || null,
            stopUrl: row.stop_url?.trim() || null,
        };
    });

    const railRoutesRows = railRoutesCsv.rows.map((row) => {
        const routeId = row.route_id?.trim() ?? "";
        if (!routeId) {
            throw new Error(`Invalid rail route row in ${railRoutesPath}`);
        }
        return {
            routeId,
            agencyId: row.agency_id?.trim() || null,
            routeShortName: row.route_short_name?.trim() || "",
            routeLongName: row.route_long_name?.trim() || "",
            routeDesc: row.route_desc?.trim() || null,
            routeType: parseIntRequired(row.route_type, "route_type", railRoutesPath),
            routeUrl: row.route_url?.trim() || null,
            routeColor: row.route_color?.trim() || null,
            routeTextColor: row.route_text_color?.trim() || null,
        };
    });

    const railRouteStopsRows = railRouteStopsCsv.rows.map((row) => {
        const routeId = row.route_id?.trim() ?? "";
        const stopId = row.stop_id?.trim() ?? "";
        if (!routeId || !stopId) {
            throw new Error(`Invalid rail route_stop row in ${railRouteStopsPath}`);
        }
        return {
            routeId,
            directionId: parseIntRequired(row.direction_id, "direction_id", railRouteStopsPath),
            stopId,
            routeStopSortOrder: parseIntRequired(
                row.route_stop_sort_order,
                "route_stop_sort_order",
                railRouteStopsPath,
            ),
        };
    });

    const busStopsRows = busStopsCsv.rows.map((row) => {
        const stopId = row.stop_id?.trim() ?? "";
        const stopName = row.stop_name?.trim() ?? "";
        if (!stopId || !stopName) {
            throw new Error(`Invalid bus stop row in ${busStopsPath}`);
        }
        return {
            stopId,
            stopCode: row.stop_code?.trim() || null,
            stopName,
            stopDesc: row.stop_desc?.trim() || null,
            stopLat: parseNumericOrNull(row.stop_lat),
            stopLon: parseNumericOrNull(row.stop_lon),
            zoneId: row.zone_id?.trim() || null,
            stopUrl: row.stop_url?.trim() || null,
            locationType: parseIntOrNull(row.location_type),
            parentStation: row.parent_station?.trim() || null,
            stopTimezone: row.stop_timezone?.trim() || null,
            wheelchairBoarding: parseIntOrNull(row.wheelchair_boarding),
        };
    });

    const busRoutesRows = busRoutesCsv.rows.map((row) => {
        const routeId = row.route_id?.trim() ?? "";
        if (!routeId) {
            throw new Error(`Invalid bus route row in ${busRoutesPath}`);
        }
        return {
            routeId,
            agencyId: row.agency_id?.trim() || null,
            routeShortName: row.route_short_name?.trim() || "",
            routeLongName: row.route_long_name?.trim() || "",
            routeDesc: row.route_desc?.trim() || null,
            routeType: parseIntRequired(row.route_type, "route_type", busRoutesPath),
            routeUrl: row.route_url?.trim() || null,
            routeColor: row.route_color?.trim() || null,
            routeTextColor: row.route_text_color?.trim() || null,
            networkId: row.network_id?.trim() || null,
        };
    });

    const busRouteStopsRows = busRouteStopsCsv.rows.map((row) => {
        const routeId = row.route_id?.trim() ?? "";
        const stopId = row.stop_id?.trim() ?? "";
        if (!routeId || !stopId) {
            throw new Error(`Invalid bus route_stop row in ${busRouteStopsPath}`);
        }
        return {
            routeId,
            directionId: parseIntRequired(row.direction_id, "direction_id", busRouteStopsPath),
            stopId,
            routeStopSortOrder: parseIntRequired(
                row.route_stop_sort_order,
                "route_stop_sort_order",
                busRouteStopsPath,
            ),
        };
    });

    const busStopIdSet = new Set(busStopsRows.map((r) => r.stopId));
    const railStopIdSet = new Set(railStopsRows.map((r) => r.stopId));
    const railMissingStopRefs = railRouteStopsRows
        .filter((r) => !railStopIdSet.has(r.stopId))
        .map((r) => r.stopId);
    const busMissingStopRefs = busRouteStopsRows
        .filter((r) => !busStopIdSet.has(r.stopId))
        .map((r) => r.stopId);

    const trolleyRoutesRows = busRoutesRows.filter((r) => isTrolleyRoute(r.routeId, r.routeType));
    const trolleyRouteIds = new Set(trolleyRoutesRows.map((r) => r.routeId));
    const trolleyRouteStopsRows = busRouteStopsRows.filter((r) => trolleyRouteIds.has(r.routeId));
    const trolleyStopIds = new Set(trolleyRouteStopsRows.map((r) => r.stopId));
    const trolleyStopsRows = busStopsRows.filter((r) => trolleyStopIds.has(r.stopId));
    const trolleyMissingStopRefs = trolleyRouteStopsRows
        .filter((r) => !busStopIdSet.has(r.stopId))
        .map((r) => r.stopId);

    await db.transaction(async (tx: DbLike) => {
        await tx.delete(septaRailRouteStops);
        await tx.delete(septaRailRoutes);
        await tx.delete(septaRailStops);
        await tx.delete(septaBusRouteStops);
        await tx.delete(septaBusRoutes);
        await tx.delete(septaBusStops);
        await tx.delete(septaTrolleyRouteStops);
        await tx.delete(septaTrolleyRoutes);
        await tx.delete(septaTrolleyStops);

        await insertChunks(tx, septaRailStops, railStopsRows);
        await insertChunks(tx, septaRailRoutes, railRoutesRows);
        await insertChunks(tx, septaRailRouteStops, railRouteStopsRows);
        await insertChunks(tx, septaBusStops, busStopsRows);
        await insertChunks(tx, septaBusRoutes, busRoutesRows);
        await insertChunks(tx, septaBusRouteStops, busRouteStopsRows);
        await insertChunks(tx, septaTrolleyStops, trolleyStopsRows);
        await insertChunks(tx, septaTrolleyRoutes, trolleyRoutesRows);
        await insertChunks(tx, septaTrolleyRouteStops, trolleyRouteStopsRows);
    });

    const sampleMissingStopIds = Array.from(
        new Set([...railMissingStopRefs, ...busMissingStopRefs, ...trolleyMissingStopRefs]),
    ).slice(0, 50);

    return {
        sourceDir,
        counts: {
            rail: {
                stops: railStopsRows.length,
                routes: railRoutesRows.length,
                routeStops: railRouteStopsRows.length,
            },
            bus: {
                stops: busStopsRows.length,
                routes: busRoutesRows.length,
                routeStops: busRouteStopsRows.length,
            },
            trolley: {
                stops: trolleyStopsRows.length,
                routes: trolleyRoutesRows.length,
                routeStops: trolleyRouteStopsRows.length,
            },
        },
        warnings: {
            railMissingStopRefs: railMissingStopRefs.length,
            busMissingStopRefs: busMissingStopRefs.length,
            trolleyMissingStopRefs: trolleyMissingStopRefs.length,
            sampleMissingStopIds,
        },
    };
}
