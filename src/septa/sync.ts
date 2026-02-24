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
const INVALID_RAIL_LINE_TOKENS = new Set(["LOCAL", "EXPRESS", "EXP"]);
const CANONICAL_RAIL_LINES = [
    { code: "AIR", displayName: "Airport" },
    { code: "WAR", displayName: "Warminster" },
    { code: "WIL", displayName: "Wilmington/Newark" },
    { code: "MED", displayName: "Media/Wawa" },
    { code: "WTR", displayName: "West Trenton" },
    { code: "LAN", displayName: "Lansdale/Doylestown" },
    { code: "PAO", displayName: "Paoli/Thorndale" },
    { code: "CYN", displayName: "Cynwyd" },
    { code: "NOR", displayName: "Manayunk/Norristown" },
    { code: "CHE", displayName: "Chestnut Hill East" },
    { code: "TRE", displayName: "Trenton" },
    { code: "CHW", displayName: "Chestnut Hill West" },
    { code: "FOX", displayName: "Fox Chase" },
] as const;
const CANONICAL_RAIL_BY_LINE = new Map(
    CANONICAL_RAIL_LINES.map((r) => [
        r.displayName.replace(/\s+line$/i, "").trim().toUpperCase(),
        r,
    ]),
);

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
const normalizeRailLineKey = (value: string) =>
    normalizeName(value)
        .replace(/\s+line$/i, "")
        .toUpperCase();

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

const normalizeRailLineName = (value: string): string => {
    const normalized = normalizeName(value);
    return normalized;
};

const isInvalidRailLineName = (value: string): boolean => {
    const key = normalizeRailLineKey(value);
    if (!key) return true;
    return INVALID_RAIL_LINE_TOKENS.has(key);
};

function extractSurfaceRoutesFromTransitViewAll(
    records: Array<Record<string, unknown>>,
): Array<{ routeId: string; mode: SeptaMode }> {
    const out = new Map<string, { routeId: string; mode: SeptaMode }>();
    const ingestRouteObject = (routeObj: Record<string, unknown>) => {
        for (const [routeKey, vehiclesRaw] of Object.entries(routeObj)) {
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
    };

    for (const record of records) {
        const routesValue = record.routes;
        if (Array.isArray(routesValue)) {
            for (const routeObj of routesValue) {
                if (!routeObj || typeof routeObj !== "object") continue;
                ingestRouteObject(routeObj as Record<string, unknown>);
            }
            continue;
        }
        ingestRouteObject(record);
    }
    return Array.from(out.values());
}

export async function runSeptaSync(db: DbLike): Promise<{
    runId: string;
    stats: Record<string, unknown>;
    status: "success" | "partial";
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

        // Keep all canonical rail routes active at all times (stable UI list).
        for (const canonical of CANONICAL_RAIL_LINES) {
            routeMap.set(`rail:${canonical.code}`, {
                mode: "rail",
                id: canonical.code,
                shortName: canonical.code,
                longName: canonical.displayName,
                displayName: canonical.displayName,
            });
        }
        // TrainView is optional here; only used to report unknown line names.
        const trainRows = await fetchRecords(`${SEPTA_BASE}/TrainView/index.php`).catch(
            () => [] as Array<Record<string, unknown>>,
        );
        for (const record of trainRows) {
            const longName = normalizeRailLineName(readField(record, ["line"]));
            if (isInvalidRailLineName(longName)) continue;
            const canonical = CANONICAL_RAIL_BY_LINE.get(normalizeRailLineKey(longName));
            if (canonical) continue;
            errors.push(`No canonical rail code for line: ${longName}`);
            logger.warn({ line: longName }, "SEPTA sync line not in canonical rail map");
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

        const stats = {
            routes: routeMap.size,
            stops: stopMap.size,
            routeStops: routeStopMap.size,
            errors: errors.length,
        };

        await db.transaction(async (tx: DbLike) => {
            // Hard refresh: replace all SEPTA catalog rows from latest APIs each run.
            await tx.delete(septaRouteStops);
            await tx.delete(septaStops);
            await tx.delete(septaRoutes);

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
                    });
            }
        });

        const finalStatus: "success" | "partial" = errors.length > 0 ? "partial" : "success";
        await db
            .update(septaIngestRuns)
            .set({
                status: finalStatus,
                statsJson: stats,
                errorJson: errors.length > 0 ? { messages: errors } : null,
                finishedAt: new Date().toISOString(),
            })
            .where(eq(septaIngestRuns.id, runId));

        return { runId, stats, status: finalStatus };
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
