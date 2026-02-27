import { asc, eq, ilike, or } from "drizzle-orm";
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

export type CoreMode = "subway" | "bus" | "rail" | "ferry";

const CORE_MODES: CoreMode[] = ["subway", "bus", "rail", "ferry"];

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
    lineId: string | null;
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
    if (
        normalized === "rail" ||
        normalized === "train" ||
        normalized === "commuter-rail" ||
        normalized === "commuter_rail"
    ) {
        return "rail";
    }
    if (normalized === "ferry" || normalized === "boat") return "ferry";
    return null;
};

export const normalizeCoreLineId = (_mode: CoreMode, value: string): string =>
    value.trim().replace(/\s+/g, " ");

const lineKey = (mode: CoreMode, value: string) => normalizeCoreLineId(mode, value).toLowerCase();

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
                stopId: mbtaSubwayStations.stopId,
                name: mbtaSubwayStations.stopName,
                lat: mbtaSubwayStations.stopLat,
                lon: mbtaSubwayStations.stopLon,
                childStopIdsJson: mbtaSubwayStations.childStopIdsJson,
            })
            .from(mbtaSubwayStations)
            .where(
                needle
                    ? or(
                          ilike(mbtaSubwayStations.stopId, `%${needle}%`),
                          ilike(mbtaSubwayStations.stopName, `%${needle}%`),
                      )
                    : undefined,
            )
            .orderBy(asc(mbtaSubwayStations.stopName))
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
                stopId: mbtaBusStations.stopId,
                name: mbtaBusStations.stopName,
                lat: mbtaBusStations.stopLat,
                lon: mbtaBusStations.stopLon,
                childStopIdsJson: mbtaBusStations.childStopIdsJson,
            })
            .from(mbtaBusStations)
            .where(
                needle
                    ? or(
                          ilike(mbtaBusStations.stopId, `%${needle}%`),
                          ilike(mbtaBusStations.stopName, `%${needle}%`),
                      )
                    : undefined,
            )
            .orderBy(asc(mbtaBusStations.stopName))
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

    if (mode === "rail") {
        const rows = await db
            .select({
                stopId: mbtaRailStations.stopId,
                name: mbtaRailStations.stopName,
                lat: mbtaRailStations.stopLat,
                lon: mbtaRailStations.stopLon,
                childStopIdsJson: mbtaRailStations.childStopIdsJson,
            })
            .from(mbtaRailStations)
            .where(
                needle
                    ? or(
                          ilike(mbtaRailStations.stopId, `%${needle}%`),
                          ilike(mbtaRailStations.stopName, `%${needle}%`),
                      )
                    : undefined,
            )
            .orderBy(asc(mbtaRailStations.stopName))
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
            stopId: mbtaFerryStations.stopId,
            name: mbtaFerryStations.stopName,
            lat: mbtaFerryStations.stopLat,
            lon: mbtaFerryStations.stopLon,
            childStopIdsJson: mbtaFerryStations.childStopIdsJson,
        })
        .from(mbtaFerryStations)
        .where(
            needle
                ? or(
                      ilike(mbtaFerryStations.stopId, `%${needle}%`),
                      ilike(mbtaFerryStations.stopName, `%${needle}%`),
                  )
                : undefined,
        )
        .orderBy(asc(mbtaFerryStations.stopName))
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
                stopId: mbtaSubwayStations.stopId,
                name: mbtaSubwayStations.stopName,
                lat: mbtaSubwayStations.stopLat,
                lon: mbtaSubwayStations.stopLon,
                childStopIdsJson: mbtaSubwayStations.childStopIdsJson,
            })
            .from(mbtaSubwayStations)
            .where(eq(mbtaSubwayStations.stopId, normalizedStopId))
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
                stopId: mbtaBusStations.stopId,
                name: mbtaBusStations.stopName,
                lat: mbtaBusStations.stopLat,
                lon: mbtaBusStations.stopLon,
                childStopIdsJson: mbtaBusStations.childStopIdsJson,
            })
            .from(mbtaBusStations)
            .where(eq(mbtaBusStations.stopId, normalizedStopId))
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

    if (mode === "rail") {
        const [row] = await db
            .select({
                stopId: mbtaRailStations.stopId,
                name: mbtaRailStations.stopName,
                lat: mbtaRailStations.stopLat,
                lon: mbtaRailStations.stopLon,
                childStopIdsJson: mbtaRailStations.childStopIdsJson,
            })
            .from(mbtaRailStations)
            .where(eq(mbtaRailStations.stopId, normalizedStopId))
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
            stopId: mbtaFerryStations.stopId,
            name: mbtaFerryStations.stopName,
            lat: mbtaFerryStations.stopLat,
            lon: mbtaFerryStations.stopLon,
            childStopIdsJson: mbtaFerryStations.childStopIdsJson,
        })
        .from(mbtaFerryStations)
        .where(eq(mbtaFerryStations.stopId, normalizedStopId))
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

const dedupeLines = (rows: Array<{ id: string; shortName: string; longName: string; lineId: string | null }>): CoreLine[] => {
    const out = new Map<string, CoreLine>();
    for (const row of rows) {
        const id = row.id?.trim() ?? "";
        if (!id || out.has(id)) continue;
        const shortName = row.shortName?.trim() ?? "";
        const longName = row.longName?.trim() ?? "";
        const label = longName || shortName || id;
        out.set(id, { id, shortName, longName, label, lineId: row.lineId ?? null });
    }
    return Array.from(out.values()).sort((a, b) => a.id.localeCompare(b.id));
};

export async function listCoreLinesForStation(db: DbLike, mode: CoreMode, stopId: string): Promise<CoreLine[]> {
    const normalizedStopId = stopId.trim();
    if (!normalizedStopId) return [];

    if (mode === "subway") {
        const rows = await db
            .select({
                id: mbtaSubwayRoutes.routeId,
                shortName: mbtaSubwayRoutes.routeShortName,
                longName: mbtaSubwayRoutes.routeLongName,
                lineId: mbtaSubwayRoutes.lineId,
            })
            .from(mbtaSubwayRouteStops)
            .innerJoin(mbtaSubwayRoutes, eq(mbtaSubwayRoutes.routeId, mbtaSubwayRouteStops.routeId))
            .where(eq(mbtaSubwayRouteStops.stopId, normalizedStopId))
            .orderBy(asc(mbtaSubwayRoutes.routeId))
            .limit(500);
        return dedupeLines(rows);
    }

    if (mode === "bus") {
        const rows = await db
            .select({
                id: mbtaBusRoutes.routeId,
                shortName: mbtaBusRoutes.routeShortName,
                longName: mbtaBusRoutes.routeLongName,
                lineId: mbtaBusRoutes.lineId,
            })
            .from(mbtaBusRouteStops)
            .innerJoin(mbtaBusRoutes, eq(mbtaBusRoutes.routeId, mbtaBusRouteStops.routeId))
            .where(eq(mbtaBusRouteStops.stopId, normalizedStopId))
            .orderBy(asc(mbtaBusRoutes.routeId))
            .limit(1500);
        return dedupeLines(rows);
    }

    if (mode === "rail") {
        const rows = await db
            .select({
                id: mbtaRailRoutes.routeId,
                shortName: mbtaRailRoutes.routeShortName,
                longName: mbtaRailRoutes.routeLongName,
                lineId: mbtaRailRoutes.lineId,
            })
            .from(mbtaRailRouteStops)
            .innerJoin(mbtaRailRoutes, eq(mbtaRailRoutes.routeId, mbtaRailRouteStops.routeId))
            .where(eq(mbtaRailRouteStops.stopId, normalizedStopId))
            .orderBy(asc(mbtaRailRoutes.routeId))
            .limit(500);
        return dedupeLines(rows);
    }

    const rows = await db
        .select({
            id: mbtaFerryRoutes.routeId,
            shortName: mbtaFerryRoutes.routeShortName,
            longName: mbtaFerryRoutes.routeLongName,
            lineId: mbtaFerryRoutes.lineId,
        })
        .from(mbtaFerryRouteStops)
        .innerJoin(mbtaFerryRoutes, eq(mbtaFerryRoutes.routeId, mbtaFerryRouteStops.routeId))
        .where(eq(mbtaFerryRouteStops.stopId, normalizedStopId))
        .orderBy(asc(mbtaFerryRoutes.routeId))
        .limit(250);
    return dedupeLines(rows);
}

export async function listCoreLinesByMode(db: DbLike, mode: CoreMode): Promise<CoreLine[]> {
    if (mode === "subway") {
        const rows = await db
            .select({
                id: mbtaSubwayRoutes.routeId,
                shortName: mbtaSubwayRoutes.routeShortName,
                longName: mbtaSubwayRoutes.routeLongName,
                lineId: mbtaSubwayRoutes.lineId,
            })
            .from(mbtaSubwayRoutes)
            .orderBy(asc(mbtaSubwayRoutes.routeId))
            .limit(500);
        return dedupeLines(rows);
    }

    if (mode === "bus") {
        const rows = await db
            .select({
                id: mbtaBusRoutes.routeId,
                shortName: mbtaBusRoutes.routeShortName,
                longName: mbtaBusRoutes.routeLongName,
                lineId: mbtaBusRoutes.lineId,
            })
            .from(mbtaBusRoutes)
            .orderBy(asc(mbtaBusRoutes.routeId))
            .limit(1500);
        return dedupeLines(rows);
    }

    if (mode === "rail") {
        const rows = await db
            .select({
                id: mbtaRailRoutes.routeId,
                shortName: mbtaRailRoutes.routeShortName,
                longName: mbtaRailRoutes.routeLongName,
                lineId: mbtaRailRoutes.lineId,
            })
            .from(mbtaRailRoutes)
            .orderBy(asc(mbtaRailRoutes.routeId))
            .limit(500);
        return dedupeLines(rows);
    }

    const rows = await db
        .select({
            id: mbtaFerryRoutes.routeId,
            shortName: mbtaFerryRoutes.routeShortName,
            longName: mbtaFerryRoutes.routeLongName,
            lineId: mbtaFerryRoutes.lineId,
        })
        .from(mbtaFerryRoutes)
        .orderBy(asc(mbtaFerryRoutes.routeId))
        .limit(250);
    return dedupeLines(rows);
}

export async function resolveCoreLineForStation(
    db: DbLike,
    lineInput: string,
    stopId: string,
): Promise<{ mode: CoreMode; stopId: string; line: CoreLine } | null> {
    const normalizedStopId = stopId.trim();
    const needle = lineInput.trim();
    if (!normalizedStopId || !needle) return null;

    for (const mode of CORE_MODES) {
        const station = await getCoreStationById(db, mode, normalizedStopId);
        if (!station) continue;

        const lines = await listCoreLinesForStation(db, mode, station.stopId);
        const found = lines.find((line) => lineKey(mode, line.id) === lineKey(mode, needle));
        if (found) {
            return {
                mode,
                stopId: station.stopId,
                line: found,
            };
        }
    }

    return null;
}
