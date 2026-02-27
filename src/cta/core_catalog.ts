import { asc, eq, ilike, or } from "drizzle-orm";
import {
    ctaBusRouteStops,
    ctaBusRoutes,
    ctaBusStations,
    ctaSubwayRouteStops,
    ctaSubwayRoutes,
    ctaSubwayStations,
} from "../db/schema/schema.ts";

export type CoreMode = "subway" | "bus";

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
    if (normalized === "subway" || normalized === "train" || normalized === "l") return "subway";
    if (normalized === "bus") return "bus";
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
                stopId: ctaSubwayStations.stopId,
                name: ctaSubwayStations.stopName,
                lat: ctaSubwayStations.stopLat,
                lon: ctaSubwayStations.stopLon,
                childStopIdsJson: ctaSubwayStations.childStopIdsJson,
            })
            .from(ctaSubwayStations)
            .where(
                needle
                    ? or(
                          ilike(ctaSubwayStations.stopId, `%${needle}%`),
                          ilike(ctaSubwayStations.stopName, `%${needle}%`),
                      )
                    : undefined,
            )
            .orderBy(asc(ctaSubwayStations.stopName))
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
            stopId: ctaBusStations.stopId,
            name: ctaBusStations.stopName,
            lat: ctaBusStations.stopLat,
            lon: ctaBusStations.stopLon,
            childStopIdsJson: ctaBusStations.childStopIdsJson,
        })
        .from(ctaBusStations)
        .where(
            needle
                ? or(
                      ilike(ctaBusStations.stopId, `%${needle}%`),
                      ilike(ctaBusStations.stopName, `%${needle}%`),
                  )
                : undefined,
        )
        .orderBy(asc(ctaBusStations.stopName))
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
                stopId: ctaSubwayStations.stopId,
                name: ctaSubwayStations.stopName,
                lat: ctaSubwayStations.stopLat,
                lon: ctaSubwayStations.stopLon,
                childStopIdsJson: ctaSubwayStations.childStopIdsJson,
            })
            .from(ctaSubwayStations)
            .where(eq(ctaSubwayStations.stopId, normalizedStopId))
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
            stopId: ctaBusStations.stopId,
            name: ctaBusStations.stopName,
            lat: ctaBusStations.stopLat,
            lon: ctaBusStations.stopLon,
            childStopIdsJson: ctaBusStations.childStopIdsJson,
        })
        .from(ctaBusStations)
        .where(eq(ctaBusStations.stopId, normalizedStopId))
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
                id: ctaSubwayRoutes.routeId,
                shortName: ctaSubwayRoutes.routeShortName,
                longName: ctaSubwayRoutes.routeLongName,
            })
            .from(ctaSubwayRouteStops)
            .innerJoin(ctaSubwayRoutes, eq(ctaSubwayRoutes.routeId, ctaSubwayRouteStops.routeId))
            .where(eq(ctaSubwayRouteStops.stopId, normalizedStopId))
            .orderBy(asc(ctaSubwayRoutes.routeId))
            .limit(500);
        return dedupeLines(rows);
    }

    const rows = await db
        .select({
            id: ctaBusRoutes.routeId,
            shortName: ctaBusRoutes.routeShortName,
            longName: ctaBusRoutes.routeLongName,
        })
        .from(ctaBusRouteStops)
        .innerJoin(ctaBusRoutes, eq(ctaBusRoutes.routeId, ctaBusRouteStops.routeId))
        .where(eq(ctaBusRouteStops.stopId, normalizedStopId))
        .orderBy(asc(ctaBusRoutes.routeId))
        .limit(1200);
    return dedupeLines(rows);
}

export async function listCoreLinesByMode(db: DbLike, mode: CoreMode): Promise<CoreLine[]> {
    if (mode === "subway") {
        const rows = await db
            .select({
                id: ctaSubwayRoutes.routeId,
                shortName: ctaSubwayRoutes.routeShortName,
                longName: ctaSubwayRoutes.routeLongName,
            })
            .from(ctaSubwayRoutes)
            .orderBy(asc(ctaSubwayRoutes.routeId))
            .limit(500);
        return dedupeLines(rows);
    }

    const rows = await db
        .select({
            id: ctaBusRoutes.routeId,
            shortName: ctaBusRoutes.routeShortName,
            longName: ctaBusRoutes.routeLongName,
        })
        .from(ctaBusRoutes)
        .orderBy(asc(ctaBusRoutes.routeId))
        .limit(1200);
    return dedupeLines(rows);
}
