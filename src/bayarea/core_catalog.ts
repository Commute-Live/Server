import { and, asc, eq, ilike, or } from "drizzle-orm";
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

export type CoreMode = "bus" | "tram" | "cableway";

type DbLike = {
    select: Function;
};

export type CoreStation = {
    operatorId: string;
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

export const normalizeOperatorId = (value: string): string => value.trim().toUpperCase();

const toChildStopIds = (value: unknown, fallbackStopId: string): string[] => {
    if (Array.isArray(value)) {
        const normalized = value
            .map((v) => (typeof v === "string" ? v.trim() : ""))
            .filter((v) => v.length > 0);
        if (normalized.length > 0) return Array.from(new Set(normalized));
    }
    return [fallbackStopId];
};

const withSearch = (base: any, idColumn: any, nameColumn: any, needle: string) => {
    if (!needle) return base;
    return and(
        base,
        or(
            ilike(idColumn, `%${needle}%`),
            ilike(nameColumn, `%${needle}%`),
        ),
    );
};

export const parseCoreMode = (value: string): CoreMode | null => {
    const normalized = value.trim().toLowerCase();
    if (normalized === "bus") return "bus";
    if (normalized === "tram" || normalized === "metro" || normalized === "light-rail" || normalized === "lightrail") {
        return "tram";
    }
    if (normalized === "cableway" || normalized === "cablecar" || normalized === "cable") {
        return "cableway";
    }
    return null;
};

export const normalizeCoreLineId = (_mode: CoreMode, value: string): string =>
    value.trim().toUpperCase().replace(/\s+/g, " ");

export async function listCoreStations(
    db: DbLike,
    operatorId: string,
    mode: CoreMode,
    q: string,
    limit: number,
): Promise<CoreStation[]> {
    const normalizedOperatorId = normalizeOperatorId(operatorId);
    if (!normalizedOperatorId) return [];

    const needle = q.trim();
    const max = Math.max(1, limit);

    if (mode === "bus") {
        const rows = await db
            .select({
                operatorId: bayareaBusStations.operatorId,
                stopId: bayareaBusStations.stopId,
                name: bayareaBusStations.stopName,
                lat: bayareaBusStations.stopLat,
                lon: bayareaBusStations.stopLon,
                childStopIdsJson: bayareaBusStations.childStopIdsJson,
            })
            .from(bayareaBusStations)
            .where(withSearch(eq(bayareaBusStations.operatorId, normalizedOperatorId), bayareaBusStations.stopId, bayareaBusStations.stopName, needle))
            .orderBy(asc(bayareaBusStations.stopName), asc(bayareaBusStations.stopId))
            .limit(max);

        return rows.map((row: {
            operatorId: string;
            stopId: string;
            name: string;
            lat: string | null;
            lon: string | null;
            childStopIdsJson: unknown;
        }) => ({
            operatorId: row.operatorId,
            stopId: row.stopId,
            name: row.name,
            lat: row.lat,
            lon: row.lon,
            childStopIds: toChildStopIds(row.childStopIdsJson, row.stopId),
        }));
    }

    if (mode === "tram") {
        const rows = await db
            .select({
                operatorId: bayareaTramStations.operatorId,
                stopId: bayareaTramStations.stopId,
                name: bayareaTramStations.stopName,
                lat: bayareaTramStations.stopLat,
                lon: bayareaTramStations.stopLon,
                childStopIdsJson: bayareaTramStations.childStopIdsJson,
            })
            .from(bayareaTramStations)
            .where(withSearch(eq(bayareaTramStations.operatorId, normalizedOperatorId), bayareaTramStations.stopId, bayareaTramStations.stopName, needle))
            .orderBy(asc(bayareaTramStations.stopName), asc(bayareaTramStations.stopId))
            .limit(max);

        return rows.map((row: {
            operatorId: string;
            stopId: string;
            name: string;
            lat: string | null;
            lon: string | null;
            childStopIdsJson: unknown;
        }) => ({
            operatorId: row.operatorId,
            stopId: row.stopId,
            name: row.name,
            lat: row.lat,
            lon: row.lon,
            childStopIds: toChildStopIds(row.childStopIdsJson, row.stopId),
        }));
    }

    const rows = await db
        .select({
            operatorId: bayareaCablewayStations.operatorId,
            stopId: bayareaCablewayStations.stopId,
            name: bayareaCablewayStations.stopName,
            lat: bayareaCablewayStations.stopLat,
            lon: bayareaCablewayStations.stopLon,
            childStopIdsJson: bayareaCablewayStations.childStopIdsJson,
        })
        .from(bayareaCablewayStations)
        .where(withSearch(eq(bayareaCablewayStations.operatorId, normalizedOperatorId), bayareaCablewayStations.stopId, bayareaCablewayStations.stopName, needle))
        .orderBy(asc(bayareaCablewayStations.stopName), asc(bayareaCablewayStations.stopId))
        .limit(max);

    return rows.map((row: {
        operatorId: string;
        stopId: string;
        name: string;
        lat: string | null;
        lon: string | null;
        childStopIdsJson: unknown;
    }) => ({
        operatorId: row.operatorId,
        stopId: row.stopId,
        name: row.name,
        lat: row.lat,
        lon: row.lon,
        childStopIds: toChildStopIds(row.childStopIdsJson, row.stopId),
    }));
}

export async function getCoreStationById(
    db: DbLike,
    operatorId: string,
    mode: CoreMode,
    stopId: string,
): Promise<CoreStation | null> {
    const normalizedOperatorId = normalizeOperatorId(operatorId);
    const normalizedStopId = stopId.trim();
    if (!normalizedOperatorId || !normalizedStopId) return null;

    if (mode === "bus") {
        const [row] = await db
            .select({
                operatorId: bayareaBusStations.operatorId,
                stopId: bayareaBusStations.stopId,
                name: bayareaBusStations.stopName,
                lat: bayareaBusStations.stopLat,
                lon: bayareaBusStations.stopLon,
                childStopIdsJson: bayareaBusStations.childStopIdsJson,
            })
            .from(bayareaBusStations)
            .where(
                and(
                    eq(bayareaBusStations.operatorId, normalizedOperatorId),
                    eq(bayareaBusStations.stopId, normalizedStopId),
                ),
            )
            .limit(1);

        if (!row) return null;
        return {
            operatorId: row.operatorId,
            stopId: row.stopId,
            name: row.name,
            lat: row.lat,
            lon: row.lon,
            childStopIds: toChildStopIds(row.childStopIdsJson, row.stopId),
        };
    }

    if (mode === "tram") {
        const [row] = await db
            .select({
                operatorId: bayareaTramStations.operatorId,
                stopId: bayareaTramStations.stopId,
                name: bayareaTramStations.stopName,
                lat: bayareaTramStations.stopLat,
                lon: bayareaTramStations.stopLon,
                childStopIdsJson: bayareaTramStations.childStopIdsJson,
            })
            .from(bayareaTramStations)
            .where(
                and(
                    eq(bayareaTramStations.operatorId, normalizedOperatorId),
                    eq(bayareaTramStations.stopId, normalizedStopId),
                ),
            )
            .limit(1);

        if (!row) return null;
        return {
            operatorId: row.operatorId,
            stopId: row.stopId,
            name: row.name,
            lat: row.lat,
            lon: row.lon,
            childStopIds: toChildStopIds(row.childStopIdsJson, row.stopId),
        };
    }

    const [row] = await db
        .select({
            operatorId: bayareaCablewayStations.operatorId,
            stopId: bayareaCablewayStations.stopId,
            name: bayareaCablewayStations.stopName,
            lat: bayareaCablewayStations.stopLat,
            lon: bayareaCablewayStations.stopLon,
            childStopIdsJson: bayareaCablewayStations.childStopIdsJson,
        })
        .from(bayareaCablewayStations)
        .where(
            and(
                eq(bayareaCablewayStations.operatorId, normalizedOperatorId),
                eq(bayareaCablewayStations.stopId, normalizedStopId),
            ),
        )
        .limit(1);

    if (!row) return null;
    return {
        operatorId: row.operatorId,
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

export async function listCoreLinesForStation(
    db: DbLike,
    operatorId: string,
    mode: CoreMode,
    stopId: string,
): Promise<CoreLine[]> {
    const normalizedOperatorId = normalizeOperatorId(operatorId);
    const normalizedStopId = stopId.trim();
    if (!normalizedOperatorId || !normalizedStopId) return [];

    if (mode === "bus") {
        const rows = await db
            .select({
                id: bayareaBusRoutes.routeId,
                shortName: bayareaBusRoutes.routeShortName,
                longName: bayareaBusRoutes.routeLongName,
            })
            .from(bayareaBusRouteStops)
            .innerJoin(
                bayareaBusRoutes,
                and(
                    eq(bayareaBusRoutes.operatorId, bayareaBusRouteStops.operatorId),
                    eq(bayareaBusRoutes.routeId, bayareaBusRouteStops.routeId),
                ),
            )
            .where(
                and(
                    eq(bayareaBusRouteStops.operatorId, normalizedOperatorId),
                    eq(bayareaBusRouteStops.stopId, normalizedStopId),
                ),
            )
            .orderBy(asc(bayareaBusRoutes.routeId))
            .limit(1500);
        return dedupeLines(rows);
    }

    if (mode === "tram") {
        const rows = await db
            .select({
                id: bayareaTramRoutes.routeId,
                shortName: bayareaTramRoutes.routeShortName,
                longName: bayareaTramRoutes.routeLongName,
            })
            .from(bayareaTramRouteStops)
            .innerJoin(
                bayareaTramRoutes,
                and(
                    eq(bayareaTramRoutes.operatorId, bayareaTramRouteStops.operatorId),
                    eq(bayareaTramRoutes.routeId, bayareaTramRouteStops.routeId),
                ),
            )
            .where(
                and(
                    eq(bayareaTramRouteStops.operatorId, normalizedOperatorId),
                    eq(bayareaTramRouteStops.stopId, normalizedStopId),
                ),
            )
            .orderBy(asc(bayareaTramRoutes.routeId))
            .limit(800);
        return dedupeLines(rows);
    }

    const rows = await db
        .select({
            id: bayareaCablewayRoutes.routeId,
            shortName: bayareaCablewayRoutes.routeShortName,
            longName: bayareaCablewayRoutes.routeLongName,
        })
        .from(bayareaCablewayRouteStops)
        .innerJoin(
            bayareaCablewayRoutes,
            and(
                eq(bayareaCablewayRoutes.operatorId, bayareaCablewayRouteStops.operatorId),
                eq(bayareaCablewayRoutes.routeId, bayareaCablewayRouteStops.routeId),
            ),
        )
        .where(
            and(
                eq(bayareaCablewayRouteStops.operatorId, normalizedOperatorId),
                eq(bayareaCablewayRouteStops.stopId, normalizedStopId),
            ),
        )
        .orderBy(asc(bayareaCablewayRoutes.routeId))
        .limit(200);

    return dedupeLines(rows);
}

export async function listCoreLinesByMode(
    db: DbLike,
    operatorId: string,
    mode: CoreMode,
): Promise<CoreLine[]> {
    const normalizedOperatorId = normalizeOperatorId(operatorId);
    if (!normalizedOperatorId) return [];

    if (mode === "bus") {
        const rows = await db
            .select({
                id: bayareaBusRoutes.routeId,
                shortName: bayareaBusRoutes.routeShortName,
                longName: bayareaBusRoutes.routeLongName,
            })
            .from(bayareaBusRoutes)
            .where(eq(bayareaBusRoutes.operatorId, normalizedOperatorId))
            .orderBy(asc(bayareaBusRoutes.routeId))
            .limit(1500);
        return dedupeLines(rows);
    }

    if (mode === "tram") {
        const rows = await db
            .select({
                id: bayareaTramRoutes.routeId,
                shortName: bayareaTramRoutes.routeShortName,
                longName: bayareaTramRoutes.routeLongName,
            })
            .from(bayareaTramRoutes)
            .where(eq(bayareaTramRoutes.operatorId, normalizedOperatorId))
            .orderBy(asc(bayareaTramRoutes.routeId))
            .limit(800);
        return dedupeLines(rows);
    }

    const rows = await db
        .select({
            id: bayareaCablewayRoutes.routeId,
            shortName: bayareaCablewayRoutes.routeShortName,
            longName: bayareaCablewayRoutes.routeLongName,
        })
        .from(bayareaCablewayRoutes)
        .where(eq(bayareaCablewayRoutes.operatorId, normalizedOperatorId))
        .orderBy(asc(bayareaCablewayRoutes.routeId))
        .limit(200);

    return dedupeLines(rows);
}
