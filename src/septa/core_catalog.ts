import { asc, eq, ilike, or } from "drizzle-orm";
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

export type CoreMode = "rail" | "bus" | "trolley";

type DbLike = {
    select: Function;
};

export type CoreStation = {
    stopId: string;
    name: string;
    lat: string | null;
    lon: string | null;
};

export type CoreLine = {
    id: string;
    shortName: string;
    longName: string;
    label: string;
};

export const parseCoreMode = (value: string): CoreMode | null => {
    const normalized = value.trim().toLowerCase();
    if (normalized === "rail" || normalized === "train") return "rail";
    if (normalized === "bus") return "bus";
    if (normalized === "trolley") return "trolley";
    return null;
};

export const normalizeCoreLineId = (mode: CoreMode, value: string): string => {
    const raw = value.trim().toUpperCase();
    if (!raw) return "";
    if (mode === "rail") {
        return raw.replace(/\s+LINE$/i, "").replace(/\s+/g, " ");
    }
    return raw.replace(/\s+/g, " ");
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
                stopId: septaRailStops.stopId,
                name: septaRailStops.stopName,
                lat: septaRailStops.stopLat,
                lon: septaRailStops.stopLon,
            })
            .from(septaRailStops)
            .where(
                needle
                    ? or(
                          ilike(septaRailStops.stopId, `%${needle}%`),
                          ilike(septaRailStops.stopName, `%${needle}%`),
                      )
                    : undefined,
            )
            .orderBy(asc(septaRailStops.stopName))
            .limit(max);
        return rows;
    }

    if (mode === "bus") {
        const rows = await db
            .select({
                stopId: septaBusStops.stopId,
                name: septaBusStops.stopName,
                lat: septaBusStops.stopLat,
                lon: septaBusStops.stopLon,
            })
            .from(septaBusStops)
            .where(
                needle
                    ? or(
                          ilike(septaBusStops.stopId, `%${needle}%`),
                          ilike(septaBusStops.stopName, `%${needle}%`),
                      )
                    : undefined,
            )
            .orderBy(asc(septaBusStops.stopName))
            .limit(max);
        return rows;
    }

    const rows = await db
        .select({
            stopId: septaTrolleyStops.stopId,
            name: septaTrolleyStops.stopName,
            lat: septaTrolleyStops.stopLat,
            lon: septaTrolleyStops.stopLon,
        })
        .from(septaTrolleyStops)
        .where(
            needle
                ? or(
                      ilike(septaTrolleyStops.stopId, `%${needle}%`),
                      ilike(septaTrolleyStops.stopName, `%${needle}%`),
                  )
                : undefined,
        )
        .orderBy(asc(septaTrolleyStops.stopName))
        .limit(max);
    return rows;
}

export async function getCoreStationById(
    db: DbLike,
    mode: CoreMode,
    stopId: string,
): Promise<CoreStation | null> {
    const normalizedStopId = stopId.trim();
    if (!normalizedStopId) return null;

    if (mode === "rail") {
        const [row] = await db
            .select({
                stopId: septaRailStops.stopId,
                name: septaRailStops.stopName,
                lat: septaRailStops.stopLat,
                lon: septaRailStops.stopLon,
            })
            .from(septaRailStops)
            .where(eq(septaRailStops.stopId, normalizedStopId))
            .limit(1);
        return row ?? null;
    }

    if (mode === "bus") {
        const [row] = await db
            .select({
                stopId: septaBusStops.stopId,
                name: septaBusStops.stopName,
                lat: septaBusStops.stopLat,
                lon: septaBusStops.stopLon,
            })
            .from(septaBusStops)
            .where(eq(septaBusStops.stopId, normalizedStopId))
            .limit(1);
        return row ?? null;
    }

    const [row] = await db
        .select({
            stopId: septaTrolleyStops.stopId,
            name: septaTrolleyStops.stopName,
            lat: septaTrolleyStops.stopLat,
            lon: septaTrolleyStops.stopLon,
        })
        .from(septaTrolleyStops)
        .where(eq(septaTrolleyStops.stopId, normalizedStopId))
        .limit(1);
    return row ?? null;
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
    mode: CoreMode,
    stopId: string,
): Promise<CoreLine[]> {
    const normalizedStopId = stopId.trim();
    if (!normalizedStopId) return [];

    if (mode === "rail") {
        const rows = await db
            .select({
                id: septaRailRoutes.routeId,
                shortName: septaRailRoutes.routeShortName,
                longName: septaRailRoutes.routeLongName,
            })
            .from(septaRailRouteStops)
            .innerJoin(septaRailRoutes, eq(septaRailRoutes.routeId, septaRailRouteStops.routeId))
            .where(eq(septaRailRouteStops.stopId, normalizedStopId))
            .orderBy(asc(septaRailRoutes.routeId))
            .limit(500);
        return dedupeLines(rows);
    }

    if (mode === "bus") {
        const rows = await db
            .select({
                id: septaBusRoutes.routeId,
                shortName: septaBusRoutes.routeShortName,
                longName: septaBusRoutes.routeLongName,
            })
            .from(septaBusRouteStops)
            .innerJoin(septaBusRoutes, eq(septaBusRoutes.routeId, septaBusRouteStops.routeId))
            .where(eq(septaBusRouteStops.stopId, normalizedStopId))
            .orderBy(asc(septaBusRoutes.routeId))
            .limit(1000);
        return dedupeLines(rows);
    }

    const rows = await db
        .select({
            id: septaTrolleyRoutes.routeId,
            shortName: septaTrolleyRoutes.routeShortName,
            longName: septaTrolleyRoutes.routeLongName,
        })
        .from(septaTrolleyRouteStops)
        .innerJoin(septaTrolleyRoutes, eq(septaTrolleyRoutes.routeId, septaTrolleyRouteStops.routeId))
        .where(eq(septaTrolleyRouteStops.stopId, normalizedStopId))
        .orderBy(asc(septaTrolleyRoutes.routeId))
        .limit(500);
    return dedupeLines(rows);
}
