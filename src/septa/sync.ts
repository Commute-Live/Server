import { desc, eq } from "drizzle-orm";
import {
    septaIngestRuns,
    septaRouteStops,
    septaRoutes,
    septaStops,
    type SeptaMode,
} from "../db/schema/schema.ts";
import { logger } from "../logger.ts";
import { normalizeDirection, normalizeRouteId } from "./catalog.ts";

const SEPTA_BASE = "https://www3.septa.org/api";

type DbLike = {
    select: Function;
    insert: Function;
    update: Function;
    transaction: Function;
};

type RouteRow = {
    mode: SeptaMode;
    id: string;
    shortName: string;
    longName: string;
    displayName: string;
};

type StopRow = {
    mode: SeptaMode;
    id: string;
    name: string;
    lat: string | null;
    lon: string | null;
};

type RouteStopRow = {
    mode: SeptaMode;
    routeId: string;
    stopId: string;
    direction: string;
    stopSequence: number | null;
};

const parseJsonSafe = (input: string): unknown => {
    try {
        return JSON.parse(input);
    } catch {
        return [];
    }
};

const toRecords = (input: unknown): Array<Record<string, unknown>> => {
    if (Array.isArray(input)) {
        return input.filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
    }
    if (!input || typeof input !== "object") return [];
    const obj = input as Record<string, unknown>;
    const out: Array<Record<string, unknown>> = [];
    for (const value of Object.values(obj)) {
        if (Array.isArray(value)) {
            out.push(
                ...value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object"),
            );
        } else if (value && typeof value === "object") {
            out.push(value as Record<string, unknown>);
        }
    }
    return out.length > 0 ? out : [obj];
};

const normalizeKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const readField = (record: Record<string, unknown>, keys: string[]) => {
    const wanted = new Set(keys.map(normalizeKey));
    for (const [k, v] of Object.entries(record)) {
        if (!wanted.has(normalizeKey(k))) continue;
        if (typeof v === "string") return v.trim();
        if (typeof v === "number") return String(v);
    }
    return "";
};

const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ");

const classifySurfaceMode = (record: Record<string, unknown>, routeId: string): SeptaMode => {
    const routeType = readField(record, ["route_type", "routetype"]).trim();
    if (routeType === "0") return "trolley";
    const routeDesc = readField(record, ["route_desc", "description", "mode"]).toLowerCase();
    if (routeDesc.includes("trolley")) return "trolley";
    if (/^(T\d+|G\d+)/i.test(routeId)) return "trolley";
    return "bus";
};

async function fetchRecords(url: string): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`SEPTA API ${url} -> ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    return toRecords(parseJsonSafe(text));
}

export async function runSeptaSync(db: DbLike): Promise<{
    runId: string;
    stats: Record<string, unknown>;
}> {
    const [run] = await db
        .insert(septaIngestRuns)
        .values({
            status: "running",
            statsJson: {},
            errorJson: null,
        })
        .returning({ id: septaIngestRuns.id });
    const runId = String(run?.id ?? "");

    const routeMap = new Map<string, RouteRow>();
    const stopMap = new Map<string, StopRow>();
    const routeStopMap = new Map<string, RouteStopRow>();
    const errors: string[] = [];

    try {
        const surfaceRows = await fetchRecords(`${SEPTA_BASE}/TransitViewAll/index.php`);
        for (const record of surfaceRows) {
            const routeRaw =
                readField(record, ["route_id", "route", "line", "route_short_name"]) ||
                readField(record, ["line", "label", "route"]);
            const routeId = normalizeRouteId("bus", routeRaw);
            if (!routeId) continue;
            const mode = classifySurfaceMode(record, routeId);
            const shortName = readField(record, ["route_short_name", "line"]) || routeId;
            const longName = readField(record, ["route_long_name", "route_name", "description"]);
            routeMap.set(`${mode}:${routeId}`, {
                mode,
                id: routeId,
                shortName,
                longName,
                displayName: longName || shortName || routeId,
            });
        }

        const railRows = await fetchRecords(`${SEPTA_BASE}/TrainView/index.php`);
        for (const record of railRows) {
            const routeRaw =
                readField(record, ["route_id", "route", "line", "route_short_name"]) ||
                readField(record, ["line"]);
            const routeId = normalizeRouteId("rail", routeRaw);
            if (!routeId) continue;
            const shortName = readField(record, ["route_short_name", "line"]) || routeId;
            const longName = readField(record, ["route_long_name", "route_name", "description"]);
            routeMap.set(`rail:${routeId}`, {
                mode: "rail",
                id: routeId,
                shortName,
                longName,
                displayName: longName || shortName || routeId,
            });
        }

        for (const route of routeMap.values()) {
            try {
                const stopRows = await fetchRecords(
                    `${SEPTA_BASE}/Stops/index.php?req1=${encodeURIComponent(route.id)}`,
                );
                for (const record of stopRows) {
                    const stopIdRaw =
                        readField(record, ["stop_id", "stopid", "stop_code", "id"]) ||
                        readField(record, ["station", "stop_name", "name"]);
                    const stopNameRaw =
                        readField(record, ["stop_name", "name", "station", "stop"]) ||
                        stopIdRaw;
                    const stopId = stopIdRaw.trim();
                    const stopName = normalizeName(stopNameRaw);
                    if (!stopId || !stopName) continue;
                    const latRaw = readField(record, ["stop_lat", "lat", "latitude"]);
                    const lonRaw = readField(record, ["stop_lon", "lon", "longitude"]);
                    const lat = latRaw && !Number.isNaN(Number(latRaw)) ? latRaw : null;
                    const lon = lonRaw && !Number.isNaN(Number(lonRaw)) ? lonRaw : null;

                    stopMap.set(`${route.mode}:${stopId}`, {
                        mode: route.mode,
                        id: stopId,
                        name: stopName,
                        lat,
                        lon,
                    });

                    const direction = normalizeDirection(
                        route.mode,
                        readField(record, ["direction", "direction_id"]),
                    );
                    const stopSequenceRaw = readField(record, [
                        "stop_sequence",
                        "sequence",
                    ]);
                    const stopSequence =
                        stopSequenceRaw && !Number.isNaN(Number(stopSequenceRaw))
                            ? Number(stopSequenceRaw)
                            : null;
                    routeStopMap.set(
                        `${route.mode}:${route.id}:${stopId}:${direction}`,
                        {
                            mode: route.mode,
                            routeId: route.id,
                            stopId,
                            direction,
                            stopSequence,
                        },
                    );
                }
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : `Stops fetch failed for ${route.id}`;
                errors.push(message);
                logger.warn({ route: route.id, mode: route.mode, err }, "SEPTA sync route stops failed");
            }
        }

        const stats = {
            routes: routeMap.size,
            stops: stopMap.size,
            routeStops: routeStopMap.size,
            errors: errors.length,
        };

        await db.transaction(async (tx: DbLike) => {
            await tx.update(septaRoutes).set({ active: false });
            await tx.update(septaStops).set({ active: false });
            await tx.update(septaRouteStops).set({ active: false });

            for (const row of routeMap.values()) {
                await tx
                    .insert(septaRoutes)
                    .values({
                        mode: row.mode,
                        id: row.id,
                        shortName: row.shortName,
                        longName: row.longName,
                        displayName: row.displayName,
                        active: true,
                    })
                    .onConflictDoUpdate({
                        target: [septaRoutes.mode, septaRoutes.id],
                        set: {
                            shortName: row.shortName,
                            longName: row.longName,
                            displayName: row.displayName,
                            active: true,
                            updatedAt: new Date().toISOString(),
                        },
                    });
            }

            for (const row of stopMap.values()) {
                await tx
                    .insert(septaStops)
                    .values({
                        mode: row.mode,
                        id: row.id,
                        name: row.name,
                        normalizedName: row.name.toLowerCase(),
                        lat: row.lat,
                        lon: row.lon,
                        active: true,
                    })
                    .onConflictDoUpdate({
                        target: [septaStops.mode, septaStops.id],
                        set: {
                            name: row.name,
                            normalizedName: row.name.toLowerCase(),
                            lat: row.lat,
                            lon: row.lon,
                            active: true,
                            updatedAt: new Date().toISOString(),
                        },
                    });
            }

            for (const row of routeStopMap.values()) {
                await tx
                    .insert(septaRouteStops)
                    .values({
                        mode: row.mode,
                        routeId: row.routeId,
                        stopId: row.stopId,
                        direction: row.direction,
                        stopSequence: row.stopSequence,
                        active: true,
                    })
                    .onConflictDoUpdate({
                        target: [
                            septaRouteStops.mode,
                            septaRouteStops.routeId,
                            septaRouteStops.stopId,
                            septaRouteStops.direction,
                        ],
                        set: {
                            stopSequence: row.stopSequence,
                            active: true,
                            updatedAt: new Date().toISOString(),
                        },
                    });
            }
        });

        await db
            .update(septaIngestRuns)
            .set({
                status: errors.length > 0 ? "partial" : "success",
                statsJson: stats,
                errorJson: errors.length > 0 ? { messages: errors } : null,
                finishedAt: new Date().toISOString(),
            })
            .where(eq(septaIngestRuns.id, runId));

        return { runId, stats };
    } catch (err) {
        const message = err instanceof Error ? err.message : "SEPTA sync failed";
        await db
            .update(septaIngestRuns)
            .set({
                status: "failed",
                statsJson: {},
                errorJson: { message },
                finishedAt: new Date().toISOString(),
            })
            .where(eq(septaIngestRuns.id, runId));
        throw err;
    }
}

export async function latestSeptaSyncStatus(db: DbLike) {
    const [row] = await db
        .select({
            id: septaIngestRuns.id,
            status: septaIngestRuns.status,
            startedAt: septaIngestRuns.startedAt,
            finishedAt: septaIngestRuns.finishedAt,
            statsJson: septaIngestRuns.statsJson,
            errorJson: septaIngestRuns.errorJson,
        })
        .from(septaIngestRuns)
        .orderBy(desc(septaIngestRuns.startedAt))
        .limit(1);
    return row ?? null;
}
