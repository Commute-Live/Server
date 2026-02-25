import { asc, eq, ilike, or } from "drizzle-orm";
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

export type CoreMode = "subway" | "bus" | "lirr" | "mnr";

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
    if (normalized === "subway") return "subway";
    if (normalized === "bus") return "bus";
    if (normalized === "lirr") return "lirr";
    if (normalized === "mnr" || normalized === "metro-north" || normalized === "metronorth") return "mnr";
    return null;
};

export const normalizeCoreLineId = (_mode: CoreMode, value: string): string =>
    value.trim().toUpperCase().replace(/\s+/g, " ");

export async function listCoreStations(
    db: DbLike,
    mode: CoreMode,
    q: string,
    limit: number,
): Promise<CoreStation[]> {
    const needle = q.trim();
    const max = Math.max(1, limit);

    if (mode === "subway") {
        const rows = await db
            .select({
                stopId: mtaSubwayStations.stopId,
                name: mtaSubwayStations.stopName,
                lat: mtaSubwayStations.stopLat,
                lon: mtaSubwayStations.stopLon,
                childStopIdsJson: mtaSubwayStations.childStopIdsJson,
            })
            .from(mtaSubwayStations)
            .where(
                needle
                    ? or(
                          ilike(mtaSubwayStations.stopId, `%${needle}%`),
                          ilike(mtaSubwayStations.stopName, `%${needle}%`),
                      )
                    : undefined,
            )
            .orderBy(asc(mtaSubwayStations.stopName))
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

    if (mode === "bus") {
        const rows = await db
            .select({
                stopId: mtaBusStations.stopId,
                name: mtaBusStations.stopName,
                lat: mtaBusStations.stopLat,
                lon: mtaBusStations.stopLon,
            })
            .from(mtaBusStations)
            .where(
                needle
                    ? or(
                          ilike(mtaBusStations.stopId, `%${needle}%`),
                          ilike(mtaBusStations.stopName, `%${needle}%`),
                      )
                    : undefined,
            )
            .orderBy(asc(mtaBusStations.stopName))
            .limit(max);

        return rows.map((row: { stopId: string; name: string; lat: string | null; lon: string | null }) => ({
            stopId: row.stopId,
            name: row.name,
            lat: row.lat,
            lon: row.lon,
            childStopIds: [row.stopId],
        }));
    }

    if (mode === "lirr") {
        const rows = await db
            .select({
                stopId: mtaLirrStations.stopId,
                name: mtaLirrStations.stopName,
                lat: mtaLirrStations.stopLat,
                lon: mtaLirrStations.stopLon,
                childStopIdsJson: mtaLirrStations.childStopIdsJson,
            })
            .from(mtaLirrStations)
            .where(
                needle
                    ? or(
                          ilike(mtaLirrStations.stopId, `%${needle}%`),
                          ilike(mtaLirrStations.stopName, `%${needle}%`),
                      )
                    : undefined,
            )
            .orderBy(asc(mtaLirrStations.stopName))
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
            stopId: mtaMnrStations.stopId,
            name: mtaMnrStations.stopName,
            lat: mtaMnrStations.stopLat,
            lon: mtaMnrStations.stopLon,
            childStopIdsJson: mtaMnrStations.childStopIdsJson,
        })
        .from(mtaMnrStations)
        .where(
            needle
                ? or(
                      ilike(mtaMnrStations.stopId, `%${needle}%`),
                      ilike(mtaMnrStations.stopName, `%${needle}%`),
                  )
                : undefined,
        )
        .orderBy(asc(mtaMnrStations.stopName))
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

    if (mode === "subway") {
        const [row] = await db
            .select({
                stopId: mtaSubwayStations.stopId,
                name: mtaSubwayStations.stopName,
                lat: mtaSubwayStations.stopLat,
                lon: mtaSubwayStations.stopLon,
                childStopIdsJson: mtaSubwayStations.childStopIdsJson,
            })
            .from(mtaSubwayStations)
            .where(eq(mtaSubwayStations.stopId, normalizedStopId))
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

    if (mode === "bus") {
        const [row] = await db
            .select({
                stopId: mtaBusStations.stopId,
                name: mtaBusStations.stopName,
                lat: mtaBusStations.stopLat,
                lon: mtaBusStations.stopLon,
            })
            .from(mtaBusStations)
            .where(eq(mtaBusStations.stopId, normalizedStopId))
            .limit(1);
        if (!row) return null;
        return {
            stopId: row.stopId,
            name: row.name,
            lat: row.lat,
            lon: row.lon,
            childStopIds: [row.stopId],
        };
    }

    if (mode === "lirr") {
        const [row] = await db
            .select({
                stopId: mtaLirrStations.stopId,
                name: mtaLirrStations.stopName,
                lat: mtaLirrStations.stopLat,
                lon: mtaLirrStations.stopLon,
                childStopIdsJson: mtaLirrStations.childStopIdsJson,
            })
            .from(mtaLirrStations)
            .where(eq(mtaLirrStations.stopId, normalizedStopId))
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
            stopId: mtaMnrStations.stopId,
            name: mtaMnrStations.stopName,
            lat: mtaMnrStations.stopLat,
            lon: mtaMnrStations.stopLon,
            childStopIdsJson: mtaMnrStations.childStopIdsJson,
        })
        .from(mtaMnrStations)
        .where(eq(mtaMnrStations.stopId, normalizedStopId))
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

const dedupeLines = (rows: Array<{ id: string; shortName: string; longName: string }>): CoreLine[] => {
    const out = new Map<string, CoreLine>();
    for (const row of rows) {
        const id = row.id?.trim() ?? "";
        if (!id || out.has(id)) continue;
        const shortName = row.shortName?.trim() ?? "";
        const longName = row.longName?.trim() ?? "";
        const label = longName || shortName || id;
        out.set(id, { id, shortName, longName, label });
    }
    return Array.from(out.values()).sort((a, b) => a.id.localeCompare(b.id));
};

export async function listCoreLinesForStation(db: DbLike, mode: CoreMode, stopId: string): Promise<CoreLine[]> {
    const normalizedStopId = stopId.trim();
    if (!normalizedStopId) return [];

    if (mode === "subway") {
        const rows = await db
            .select({
                id: mtaSubwayRoutes.routeId,
                shortName: mtaSubwayRoutes.routeShortName,
                longName: mtaSubwayRoutes.routeLongName,
            })
            .from(mtaSubwayRouteStops)
            .innerJoin(mtaSubwayRoutes, eq(mtaSubwayRoutes.routeId, mtaSubwayRouteStops.routeId))
            .where(eq(mtaSubwayRouteStops.stopId, normalizedStopId))
            .orderBy(asc(mtaSubwayRoutes.routeId))
            .limit(500);
        return dedupeLines(rows);
    }

    if (mode === "bus") {
        const rows = await db
            .select({
                id: mtaBusRoutes.routeId,
                shortName: mtaBusRoutes.routeShortName,
                longName: mtaBusRoutes.routeLongName,
            })
            .from(mtaBusRouteStops)
            .innerJoin(mtaBusRoutes, eq(mtaBusRoutes.routeId, mtaBusRouteStops.routeId))
            .where(eq(mtaBusRouteStops.stopId, normalizedStopId))
            .orderBy(asc(mtaBusRoutes.routeId))
            .limit(1200);
        return dedupeLines(rows);
    }

    if (mode === "lirr") {
        const rows = await db
            .select({
                id: mtaLirrRoutes.routeId,
                shortName: mtaLirrRoutes.routeShortName,
                longName: mtaLirrRoutes.routeLongName,
            })
            .from(mtaLirrRouteStops)
            .innerJoin(mtaLirrRoutes, eq(mtaLirrRoutes.routeId, mtaLirrRouteStops.routeId))
            .where(eq(mtaLirrRouteStops.stopId, normalizedStopId))
            .orderBy(asc(mtaLirrRoutes.routeId))
            .limit(500);
        return dedupeLines(rows);
    }

    const rows = await db
        .select({
            id: mtaMnrRoutes.routeId,
            shortName: mtaMnrRoutes.routeShortName,
            longName: mtaMnrRoutes.routeLongName,
        })
        .from(mtaMnrRouteStops)
        .innerJoin(mtaMnrRoutes, eq(mtaMnrRoutes.routeId, mtaMnrRouteStops.routeId))
        .where(eq(mtaMnrRouteStops.stopId, normalizedStopId))
        .orderBy(asc(mtaMnrRoutes.routeId))
        .limit(500);
    return dedupeLines(rows);
}
