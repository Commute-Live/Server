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
const BUS_TRIP_PRINT_URL = "https://www3.septa.org/gtfsrt/septa-pa-us/Trip/print.php";
const RAIL_TRIP_PRINT_URL = "https://www3.septa.org/gtfsrt/septarail-pa-us/Trip/print.php";

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

type PrintTripUpdate = {
    routeId?: string;
    directionId?: string;
    arrivals: Array<{
        stopId?: string;
        stopSequence?: number;
    }>;
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
const isLikelyRailCode = (value: string) => /^[A-Z0-9]{2,5}$/.test(value);

const pickRailRouteCode = (record: Record<string, unknown>): string => {
    const candidates = [
        "route_id",
        "route",
        "linecode",
        "line_code",
        "lineabbr",
        "line_abbr",
        "route_short_name",
        "line",
    ];
    for (const key of candidates) {
        const raw = readField(record, [key]).trim().toUpperCase().replace(/\s+/g, "");
        if (!raw) continue;
        if (isLikelyRailCode(raw)) return raw;
    }
    return "";
};

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

const parseTripPrintUpdates = (body: string): PrintTripUpdate[] => {
    const updates: PrintTripUpdate[] = [];
    const lines = body.split(/\r?\n/);
    let inTripUpdate = false;
    let depth = 0;
    let routeId: string | undefined;
    let directionId: string | undefined;
    let currentStopId: string | undefined;
    let currentStopSequence: number | undefined;
    let arrivals: Array<{ stopId?: string; stopSequence?: number }> = [];

    const finalizeStop = () => {
        if (currentStopId) {
            arrivals.push({
                stopId: currentStopId,
                stopSequence: currentStopSequence,
            });
        }
        currentStopId = undefined;
        currentStopSequence = undefined;
    };

    const finalizeTrip = () => {
        finalizeStop();
        if (routeId && arrivals.length > 0) {
            updates.push({ routeId, directionId, arrivals });
        }
        routeId = undefined;
        directionId = undefined;
        arrivals = [];
    };

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (!inTripUpdate) {
            if (line.startsWith("trip_update")) {
                inTripUpdate = true;
                depth =
                    (line.match(/\{/g) ?? []).length -
                    (line.match(/\}/g) ?? []).length;
                routeId = undefined;
                directionId = undefined;
                currentStopId = undefined;
                currentStopSequence = undefined;
                arrivals = [];
            }
            continue;
        }

        const routeMatch = line.match(/^route_id:\s*"([^"]+)"/);
        if (routeMatch?.[1]) routeId = routeMatch[1];

        const directionMatch = line.match(/^direction_id:\s*(\d+)/);
        if (directionMatch?.[1]) directionId = directionMatch[1];

        if (line.startsWith("stop_time_update")) {
            finalizeStop();
        }

        const stopMatch = line.match(/^stop_id:\s*"([^"]+)"/);
        if (stopMatch?.[1]) currentStopId = stopMatch[1];

        const seqMatch = line.match(/^stop_sequence:\s*(\d+)/);
        if (seqMatch?.[1] && !Number.isNaN(Number(seqMatch[1]))) {
            currentStopSequence = Number(seqMatch[1]);
        }

        depth += (line.match(/\{/g) ?? []).length;
        depth -= (line.match(/\}/g) ?? []).length;
        if (depth <= 0) {
            finalizeTrip();
            inTripUpdate = false;
            depth = 0;
        }
    }

    if (inTripUpdate) finalizeTrip();
    return updates;
};

function extractSurfaceRoutesFromTransitViewAll(
    records: Array<Record<string, unknown>>,
): Array<{ routeId: string; mode: SeptaMode }> {
    const out = new Map<string, { routeId: string; mode: SeptaMode }>();
    for (const record of records) {
        const routesValue = record.routes;
        if (!Array.isArray(routesValue)) continue;
        for (const routeObj of routesValue) {
            if (!routeObj || typeof routeObj !== "object") continue;
            for (const [routeKey, vehiclesRaw] of Object.entries(
                routeObj as Record<string, unknown>,
            )) {
                const routeId = normalizeRouteId("bus", routeKey);
                if (!routeId) continue;
                let mode: SeptaMode = /^(T\d+|G\d+)/i.test(routeId)
                    ? "trolley"
                    : "bus";
                if (Array.isArray(vehiclesRaw) && vehiclesRaw.length > 0) {
                    const first = vehiclesRaw[0];
                    if (first && typeof first === "object") {
                        mode = classifySurfaceMode(
                            first as Record<string, unknown>,
                            routeId,
                        );
                    }
                }
                out.set(routeId, { routeId, mode });
            }
        }
    }
    return Array.from(out.values());
}

async function fetchPrintTripUpdates(url: string): Promise<PrintTripUpdate[]> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`SEPTA GTFS-RT print ${url} -> ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    return parseTripPrintUpdates(text);
}

async function fetchStopNameByStopId(stopId: string): Promise<string | null> {
    const url = `${SEPTA_BASE}/Stops/index.php?stop_id=${encodeURIComponent(stopId)}`;
    const rows = await fetchRecords(url);
    for (const row of rows) {
        const name =
            readField(row, [
                "stop_name",
                "stopname",
                "name",
                "station",
                "stop",
            ]) || "";
        if (name.trim()) return normalizeName(name);
    }
    return null;
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
        const surfaceRoutes = extractSurfaceRoutesFromTransitViewAll(surfaceRows);
        for (const route of surfaceRoutes) {
            routeMap.set(`${route.mode}:${route.routeId}`, {
                mode: route.mode,
                id: route.routeId,
                shortName: route.routeId,
                longName: route.routeId,
                displayName: route.routeId,
            });
        }

        const railRows = await fetchRecords(`${SEPTA_BASE}/RRSchedules/index.php`).catch(
            () => [] as Array<Record<string, unknown>>,
        );
        for (const record of railRows) {
            const routeId = pickRailRouteCode(record);
            if (!routeId) continue;
            const shortName =
                readField(record, ["route_short_name", "lineabbr", "line_abbr"]) ||
                routeId;
            const longName =
                readField(record, [
                    "line",
                    "service",
                    "route_long_name",
                    "route_name",
                    "description",
                ]) || routeId;
            routeMap.set(`rail:${routeId}`, {
                mode: "rail",
                id: routeId,
                shortName,
                longName,
                displayName: longName || shortName || routeId,
            });
        }

        const trainRows = await fetchRecords(`${SEPTA_BASE}/TrainView/index.php`);
        for (const record of trainRows) {
            const routeId = pickRailRouteCode(record);
            if (!routeId) continue;
            const existing = routeMap.get(`rail:${routeId}`);
            const longName =
                readField(record, ["line", "service", "destination"]) ||
                existing?.longName ||
                routeId;
            const shortName = existing?.shortName || routeId;
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
                        readField(record, [
                            "stop_name",
                            "stopname",
                            "name",
                            "station",
                            "stop",
                        ]) ||
                        stopIdRaw;
                    const stopId = stopIdRaw.trim();
                    const stopName = normalizeName(stopNameRaw);
                    if (!stopId || !stopName) continue;
                    const latRaw = readField(record, ["stop_lat", "lat", "latitude"]);
                    const lonRaw = readField(record, [
                        "stop_lon",
                        "lon",
                        "lng",
                        "longitude",
                    ]);
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

        if (routeStopMap.size === 0) {
            const seenStopKeys = new Set<string>();
            const addFromPrint = (
                mode: SeptaMode,
                updates: PrintTripUpdate[],
            ) => {
                for (const update of updates) {
                    const rawRouteId = (update.routeId ?? "").trim();
                    if (!rawRouteId) continue;
                    const routeId = normalizeRouteId(
                        mode === "rail" ? "rail" : "bus",
                        rawRouteId,
                    );
                    if (!routeId) continue;
                    const routedMode =
                        mode === "rail"
                            ? "rail"
                            : classifySurfaceMode({}, routeId);
                    const routeKey = `${routedMode}:${routeId}`;
                    if (!routeMap.has(routeKey)) {
                        routeMap.set(routeKey, {
                            mode: routedMode,
                            id: routeId,
                            shortName: routeId,
                            longName: "",
                            displayName: routeId,
                        });
                    }
                    const direction = normalizeDirection(
                        routedMode,
                        update.directionId ?? "",
                    );
                    for (const arrival of update.arrivals) {
                        const stopId = (arrival.stopId ?? "").trim();
                        if (!stopId) continue;
                        routeStopMap.set(
                            `${routedMode}:${routeId}:${stopId}:${direction}`,
                            {
                                mode: routedMode,
                                routeId,
                                stopId,
                                direction,
                                stopSequence: arrival.stopSequence ?? null,
                            },
                        );
                        seenStopKeys.add(`${routedMode}:${stopId}`);
                    }
                }
            };

            const [surfacePrint, railPrint] = await Promise.all([
                fetchPrintTripUpdates(BUS_TRIP_PRINT_URL).catch(
                    () => [] as PrintTripUpdate[],
                ),
                fetchPrintTripUpdates(RAIL_TRIP_PRINT_URL).catch(
                    () => [] as PrintTripUpdate[],
                ),
            ]);
            addFromPrint("bus", surfacePrint);
            addFromPrint("rail", railPrint);

            for (const key of seenStopKeys) {
                const [modeRaw, stopId] = key.split(":", 2);
                const mode = (modeRaw as SeptaMode) ?? "bus";
                if (!stopId) continue;
                const stopName =
                    (await fetchStopNameByStopId(stopId).catch(() => null)) ??
                    stopId;
                stopMap.set(`${mode}:${stopId}`, {
                    mode,
                    id: stopId,
                    name: stopName,
                    lat: null,
                    lon: null,
                });
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
