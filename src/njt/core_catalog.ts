import { asc, eq, ilike, or } from "drizzle-orm";
import {
    njtBusRouteStops,
    njtBusRoutes,
    njtBusStations,
    njtRailRouteStops,
    njtRailRoutes,
    njtRailStations,
} from "../db/schema/schema.ts";

export type CoreMode = "rail" | "bus";

type DbLike = {
    select: Function;
};

export type CoreStation = {
    stopId: string;
    name: string;
    lat: string | null;
    lon: string | null;
    childStopIds: string[];
};

export type CoreLine = {
    id: string;
    shortName: string;
    longName: string;
    label: string;
};

const toChildStopIds = (value: unknown, fallbackStopId: string): string[] => {
    if (Array.isArray(value)) {
        const normalized = value
            .map((v) => (typeof v === "string" ? v.trim() : ""))
            .filter((v) => v.length > 0);
        if (normalized.length > 0) return Array.from(new Set(normalized));
    }
    return [fallbackStopId];
};

export const parseCoreMode = (value: string): CoreMode | null => {
    const normalized = value.trim().toLowerCase();
    if (normalized === "rail" || normalized === "train" || normalized === "commuter-rail") return "rail";
    if (normalized === "bus") return "bus";
    return null;
};

export const normalizeCoreLineId = (_mode: CoreMode, value: string): string =>
    value.trim().toUpperCase().replace(/\s+/g, " ");

const dedupeLines = (rows: Array<{ id: string; shortName: string; longName: string }>): CoreLine[] => {
    const out = new Map<string, CoreLine>();
    for (const row of rows) {
        const id = row.id?.trim() ?? "";
        if (!id || out.has(id)) continue;
        const shortName = row.shortName?.trim() ?? "";
        const longName = row.longName?.trim() ?? "";
        out.set(id, {
            id,
            shortName,
            longName,
            label: longName || shortName || id,
        });
    }
    return Array.from(out.values()).sort((a, b) => a.id.localeCompare(b.id));
};

export async function listCoreStations(
    db: DbLike,
    mode: CoreMode,
    q: string,
    limit: number,
): Promise<CoreStation[]> {
    const needle = q.trim();
    const max = Math.max(1, limit);

    if (mode === "rail") {
        const rows = await db
            .select({
                stopId: njtRailStations.stopId,
                name: njtRailStations.stopName,
                lat: njtRailStations.stopLat,
                lon: njtRailStations.stopLon,
                childStopIdsJson: njtRailStations.childStopIdsJson,
            })
            .from(njtRailStations)
            .where(
                needle
                    ? or(
                          ilike(njtRailStations.stopId, `%${needle}%`),
                          ilike(njtRailStations.stopName, `%${needle}%`),
                      )
                    : undefined,
            )
            .orderBy(asc(njtRailStations.stopName))
            .limit(max);

        return rows.map((row: {
            stopId: string;
            name: string;
            lat: string | null;
            lon: string | null;
            childStopIdsJson: unknown;
        }) => ({
            stopId: row.stopId,
            name: row.name,
            lat: row.lat,
            lon: row.lon,
            childStopIds: toChildStopIds(row.childStopIdsJson, row.stopId),
        }));
    }

    const rows = await db
        .select({
            stopId: njtBusStations.stopId,
            name: njtBusStations.stopName,
            lat: njtBusStations.stopLat,
            lon: njtBusStations.stopLon,
            childStopIdsJson: njtBusStations.childStopIdsJson,
        })
        .from(njtBusStations)
        .where(
            needle
                ? or(
                      ilike(njtBusStations.stopId, `%${needle}%`),
                      ilike(njtBusStations.stopName, `%${needle}%`),
                  )
                : undefined,
        )
        .orderBy(asc(njtBusStations.stopName))
        .limit(max);

    return rows.map((row: {
        stopId: string;
        name: string;
        lat: string | null;
        lon: string | null;
        childStopIdsJson: unknown;
    }) => ({
        stopId: row.stopId,
        name: row.name,
        lat: row.lat,
        lon: row.lon,
        childStopIds: toChildStopIds(row.childStopIdsJson, row.stopId),
    }));
}

export async function getCoreStationById(db: DbLike, mode: CoreMode, stopId: string): Promise<CoreStation | null> {
    const normalizedStopId = stopId.trim();
    if (!normalizedStopId) return null;

    if (mode === "rail") {
        const [row] = await db
            .select({
                stopId: njtRailStations.stopId,
                name: njtRailStations.stopName,
                lat: njtRailStations.stopLat,
                lon: njtRailStations.stopLon,
                childStopIdsJson: njtRailStations.childStopIdsJson,
            })
            .from(njtRailStations)
            .where(eq(njtRailStations.stopId, normalizedStopId))
            .limit(1);
        if (!row) return null;
        return {
            stopId: row.stopId,
            name: row.name,
            lat: row.lat,
            lon: row.lon,
            childStopIds: toChildStopIds(row.childStopIdsJson, row.stopId),
        };
    }

    const [row] = await db
        .select({
            stopId: njtBusStations.stopId,
            name: njtBusStations.stopName,
            lat: njtBusStations.stopLat,
            lon: njtBusStations.stopLon,
            childStopIdsJson: njtBusStations.childStopIdsJson,
        })
        .from(njtBusStations)
        .where(eq(njtBusStations.stopId, normalizedStopId))
        .limit(1);
    if (!row) return null;
    return {
        stopId: row.stopId,
        name: row.name,
        lat: row.lat,
        lon: row.lon,
        childStopIds: toChildStopIds(row.childStopIdsJson, row.stopId),
    };
}

export async function listCoreLinesForStation(db: DbLike, mode: CoreMode, stopId: string): Promise<CoreLine[]> {
    const normalizedStopId = stopId.trim();
    if (!normalizedStopId) return [];

    if (mode === "rail") {
        const rows = await db
            .select({
                id: njtRailRoutes.routeId,
                shortName: njtRailRoutes.routeShortName,
                longName: njtRailRoutes.routeLongName,
            })
            .from(njtRailRouteStops)
            .innerJoin(njtRailRoutes, eq(njtRailRoutes.routeId, njtRailRouteStops.routeId))
            .where(eq(njtRailRouteStops.stopId, normalizedStopId))
            .orderBy(asc(njtRailRoutes.routeId))
            .limit(500);
        return dedupeLines(rows);
    }

    const rows = await db
        .select({
            id: njtBusRoutes.routeId,
            shortName: njtBusRoutes.routeShortName,
            longName: njtBusRoutes.routeLongName,
        })
        .from(njtBusRouteStops)
        .innerJoin(njtBusRoutes, eq(njtBusRoutes.routeId, njtBusRouteStops.routeId))
        .where(eq(njtBusRouteStops.stopId, normalizedStopId))
        .orderBy(asc(njtBusRoutes.routeId))
        .limit(1500);
    return dedupeLines(rows);
}

export async function listCoreStationsForLine(db: DbLike, mode: CoreMode, lineId: string): Promise<CoreStation[]> {
    const normalizedLineId = normalizeCoreLineId(mode, lineId);
    if (!normalizedLineId) return [];

    if (mode === "rail") {
        const rows = await db
            .select({
                stopId: njtRailStations.stopId,
                name: njtRailStations.stopName,
                lat: njtRailStations.stopLat,
                lon: njtRailStations.stopLon,
                childStopIdsJson: njtRailStations.childStopIdsJson,
            })
            .from(njtRailRouteStops)
            .innerJoin(njtRailStations, eq(njtRailStations.stopId, njtRailRouteStops.stopId))
            .where(eq(njtRailRouteStops.routeId, normalizedLineId))
            .orderBy(asc(njtRailStations.stopName))
            .limit(2000);

        const stations = new Map<string, CoreStation>();
        for (const row of rows) {
            if (stations.has(row.stopId)) continue;
            stations.set(row.stopId, {
                stopId: row.stopId,
                name: row.name,
                lat: row.lat,
                lon: row.lon,
                childStopIds: toChildStopIds(row.childStopIdsJson, row.stopId),
            });
        }
        return Array.from(stations.values());
    }

    const rows = await db
        .select({
            stopId: njtBusStations.stopId,
            name: njtBusStations.stopName,
            lat: njtBusStations.stopLat,
            lon: njtBusStations.stopLon,
            childStopIdsJson: njtBusStations.childStopIdsJson,
        })
        .from(njtBusRouteStops)
        .innerJoin(njtBusStations, eq(njtBusStations.stopId, njtBusRouteStops.stopId))
        .where(eq(njtBusRouteStops.routeId, normalizedLineId))
        .orderBy(asc(njtBusStations.stopName))
        .limit(3000);

    const stations = new Map<string, CoreStation>();
    for (const row of rows) {
        if (stations.has(row.stopId)) continue;
        stations.set(row.stopId, {
            stopId: row.stopId,
            name: row.name,
            lat: row.lat,
            lon: row.lon,
            childStopIds: toChildStopIds(row.childStopIdsJson, row.stopId),
        });
    }
    return Array.from(stations.values());
}

export async function listCoreLinesByMode(db: DbLike, mode: CoreMode): Promise<CoreLine[]> {
    if (mode === "rail") {
        const rows = await db
            .select({
                id: njtRailRoutes.routeId,
                shortName: njtRailRoutes.routeShortName,
                longName: njtRailRoutes.routeLongName,
            })
            .from(njtRailRoutes)
            .orderBy(asc(njtRailRoutes.routeId))
            .limit(500);
        return dedupeLines(rows);
    }

    const rows = await db
        .select({
            id: njtBusRoutes.routeId,
            shortName: njtBusRoutes.routeShortName,
            longName: njtBusRoutes.routeLongName,
        })
        .from(njtBusRoutes)
        .orderBy(asc(njtBusRoutes.routeId))
        .limit(1500);
    return dedupeLines(rows);
}
