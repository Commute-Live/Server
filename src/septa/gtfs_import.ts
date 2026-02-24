import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
    septaIngestRuns,
    septaRouteStops,
    septaRoutes,
    septaScheduledStopTimes,
    septaServiceDates,
    septaStops,
    type SeptaMode,
} from "../db/schema/schema.ts";

const DEFAULT_GTFS_URL = "https://www3.septa.org/developer/gtfs_public.zip";
const TZ = "America/New_York";

type DbLike = {
    insert: Function;
    update: Function;
    delete: Function;
    transaction: Function;
};

type CsvRecord = Record<string, string>;

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
    normalizedName: string;
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

type ScheduledStopTimeRow = {
    mode: SeptaMode;
    routeId: string;
    stopId: string;
    direction: string;
    tripId: string;
    serviceId: string;
    headsign: string;
    arrivalSeconds: number;
    departureSeconds: number | null;
    stopSequence: number | null;
    active: boolean;
};

const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ");
const normalizeRouteId = (value: string) => value.trim().toUpperCase().replace(/\s+/g, " ");

function parseCsvLine(line: string): string[] {
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
}

async function readCsv(filePath: string): Promise<CsvRecord[]> {
    const content = await readFile(filePath, "utf8");
    const lines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length < 2) return [];
    const header = parseCsvLine(lines[0] ?? "");
    const rows: CsvRecord[] = [];
    for (let i = 1; i < lines.length; i++) {
        const rowLine = lines[i];
        if (!rowLine) continue;
        const cols = parseCsvLine(rowLine);
        const rec: CsvRecord = {};
        for (let j = 0; j < header.length; j++) {
            const key = (header[j] ?? "").trim();
            if (!key) continue;
            rec[key] = (cols[j] ?? "").trim();
        }
        rows.push(rec);
    }
    return rows;
}

const parseNumberOrNull = (value: string | undefined) => {
    if (!value) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return String(n);
};

const parseIntOrNull = (value: string | undefined) => {
    if (!value) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n);
};

const parseTimeToSeconds = (value: string | undefined): number | null => {
    if (!value) return null;
    const match = value.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    const s = Number(match[3]);
    if (![h, m, s].every((x) => Number.isFinite(x))) return null;
    return h * 3600 + m * 60 + s;
};

const normalizeDirection = (mode: SeptaMode, value: string | undefined): string => {
    const v = (value ?? "").trim().toUpperCase();
    if (!v) return "";
    if (mode === "rail") {
        if (v === "1" || v === "S") return "S";
        if (v === "0" || v === "N") return "N";
        return "";
    }
    if (v === "N") return "0";
    if (v === "S") return "1";
    if (v === "0" || v === "1") return v;
    return "";
};

const dateKey = (d: Date) => {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    return formatter.format(d).replaceAll("-", "");
};

const weekdayKey = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        weekday: "long",
    }).format(d).toLowerCase();

const addDaysUtc = (date: Date, days: number) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));

async function unzipToTemp(url: string) {
    const tmpRoot = await mkdtemp(join(tmpdir(), "septa-gtfs-"));
    const zipPath = join(tmpRoot, "gtfs_public.zip");
    const outDir = join(tmpRoot, "unzipped");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GTFS download failed ${res.status} ${res.statusText}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(zipPath, buffer);
    const proc = Bun.spawn(["unzip", "-oq", zipPath, "-d", outDir], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`unzip failed: ${err || `exit ${code}`}`);
    }
    return { tmpRoot, outDir };
}

async function resolveSeptaGtfsRoot(outDir: string): Promise<string> {
    const hasExpectedDirs = (root: string) =>
        existsSync(join(root, "google_bus")) && existsSync(join(root, "google_rail"));

    if (hasExpectedDirs(outDir)) return outDir;

    const directCandidate = join(outDir, "gtfs_public");
    if (hasExpectedDirs(directCandidate)) return directCandidate;

    const entries = await readdir(outDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(outDir, entry.name);
        if (hasExpectedDirs(candidate)) return candidate;
    }

    throw new Error("Unable to locate google_bus/google_rail in unzipped GTFS feed");
}

async function insertChunks(tx: DbLike, table: unknown, rows: unknown[], size = 1000) {
    for (let i = 0; i < rows.length; i += size) {
        const chunk = rows.slice(i, i + size);
        if (chunk.length === 0) continue;
        await tx.insert(table).values(chunk);
    }
}

function pickBusMode(routeTypeRaw: string | undefined, routeIdRaw: string): SeptaMode {
    const routeType = (routeTypeRaw ?? "").trim();
    const routeId = normalizeRouteId(routeIdRaw);
    if (routeType === "0") return "trolley";
    if (/^(T\d+|G\d+)/i.test(routeId)) return "trolley";
    return "bus";
}

export async function runSeptaGtfsImport(db: DbLike, sourceUrl?: string): Promise<{
    runId: string;
    status: "success" | "partial";
    stats: Record<string, unknown>;
}> {
    const url = sourceUrl?.trim() || process.env.SEPTA_STATIC_GTFS_URL || DEFAULT_GTFS_URL;
    const [run] = await db
        .insert(septaIngestRuns)
        .values({ status: "running", statsJson: {}, errorJson: null })
        .returning({ id: septaIngestRuns.id });
    const runId = String(run?.id ?? "");

    const errors: string[] = [];
    let tmpRoot = "";
    try {
        const unzipped = await unzipToTemp(url);
        tmpRoot = unzipped.tmpRoot;
        const feedRoot = await resolveSeptaGtfsRoot(unzipped.outDir);
        const busDir = join(feedRoot, "google_bus");
        const railDir = join(feedRoot, "google_rail");

        const [
            railRoutesRaw,
            railStopsRaw,
            railTripsRaw,
            railStopTimesRaw,
            railRouteStopsRaw,
            railCalendarRaw,
            railCalendarDatesRaw,
            busRoutesRaw,
            busStopsRaw,
            busTripsRaw,
            busStopTimesRaw,
            busRouteStopsRaw,
            busCalendarRaw,
            busCalendarDatesRaw,
        ] = await Promise.all([
            readCsv(join(railDir, "routes.txt")),
            readCsv(join(railDir, "stops.txt")),
            readCsv(join(railDir, "trips.txt")),
            readCsv(join(railDir, "stop_times.txt")),
            readCsv(join(railDir, "route_stops.txt")).catch(() => []),
            readCsv(join(railDir, "calendar.txt")).catch(() => []),
            readCsv(join(railDir, "calendar_dates.txt")).catch(() => []),
            readCsv(join(busDir, "routes.txt")),
            readCsv(join(busDir, "stops.txt")),
            readCsv(join(busDir, "trips.txt")),
            readCsv(join(busDir, "stop_times.txt")),
            readCsv(join(busDir, "route_stops.txt")).catch(() => []),
            readCsv(join(busDir, "calendar.txt")).catch(() => []),
            readCsv(join(busDir, "calendar_dates.txt")).catch(() => []),
        ]);

        const routeRows: RouteRow[] = [];
        const routeModeById = new Map<string, SeptaMode>();

        for (const row of railRoutesRaw) {
            const routeId = normalizeRouteId(row.route_id ?? "");
            if (!routeId) continue;
            routeModeById.set(routeId, "rail");
            const shortName = row.route_short_name?.trim() || routeId;
            const longName = row.route_long_name?.trim() || shortName;
            routeRows.push({
                mode: "rail",
                id: routeId,
                shortName,
                longName,
                displayName: longName || shortName || routeId,
            });
        }

        for (const row of busRoutesRaw) {
            const routeId = normalizeRouteId(row.route_id ?? "");
            if (!routeId) continue;
            const mode = pickBusMode(row.route_type, routeId);
            routeModeById.set(routeId, mode);
            const shortName = row.route_short_name?.trim() || routeId;
            const longName = row.route_long_name?.trim() || shortName;
            routeRows.push({
                mode,
                id: routeId,
                shortName,
                longName,
                displayName: longName || shortName || routeId,
            });
        }

        const stopByKey = new Map<string, StopRow>();
        const globalBusStops = new Map<string, Omit<StopRow, "mode">>();
        for (const row of railStopsRaw) {
            const stopId = row.stop_id?.trim();
            const stopName = normalizeName(row.stop_name ?? "");
            if (!stopId || !stopName) continue;
            const key = `rail:${stopId}`;
            stopByKey.set(key, {
                mode: "rail",
                id: stopId,
                name: stopName,
                normalizedName: stopName.toLowerCase(),
                lat: parseNumberOrNull(row.stop_lat),
                lon: parseNumberOrNull(row.stop_lon),
            });
        }
        for (const row of busStopsRaw) {
            const stopId = row.stop_id?.trim();
            const stopName = normalizeName(row.stop_name ?? "");
            if (!stopId || !stopName) continue;
            globalBusStops.set(stopId, {
                id: stopId,
                name: stopName,
                normalizedName: stopName.toLowerCase(),
                lat: parseNumberOrNull(row.stop_lat),
                lon: parseNumberOrNull(row.stop_lon),
            });
        }

        const tripById = new Map<string, {
            mode: SeptaMode;
            routeId: string;
            serviceId: string;
            direction: string;
            headsign: string;
        }>();
        for (const row of railTripsRaw) {
            const tripId = row.trip_id?.trim();
            const routeId = normalizeRouteId(row.route_id ?? "");
            const serviceId = row.service_id?.trim() ?? "";
            if (!tripId || !routeId || !serviceId) continue;
            tripById.set(tripId, {
                mode: "rail",
                routeId,
                serviceId,
                direction: normalizeDirection("rail", row.direction_id),
                headsign: normalizeName(row.trip_headsign ?? ""),
            });
        }
        for (const row of busTripsRaw) {
            const tripId = row.trip_id?.trim();
            const routeId = normalizeRouteId(row.route_id ?? "");
            const serviceId = row.service_id?.trim() ?? "";
            if (!tripId || !routeId || !serviceId) continue;
            const mode = routeModeById.get(routeId) ?? "bus";
            tripById.set(tripId, {
                mode,
                routeId,
                serviceId,
                direction: normalizeDirection(mode, row.direction_id),
                headsign: normalizeName(row.trip_headsign ?? ""),
            });
        }

        const routeStopByKey = new Map<string, RouteStopRow>();
        const touchRouteStop = (row: RouteStopRow) => {
            const key = `${row.mode}:${row.routeId}:${row.stopId}:${row.direction}`;
            const prev = routeStopByKey.get(key);
            if (!prev) {
                routeStopByKey.set(key, row);
                return;
            }
            if (prev.stopSequence === null && row.stopSequence !== null) {
                routeStopByKey.set(key, row);
                return;
            }
            if (
                prev.stopSequence !== null &&
                row.stopSequence !== null &&
                row.stopSequence < prev.stopSequence
            ) {
                routeStopByKey.set(key, row);
            }
        };

        for (const row of railRouteStopsRaw) {
            const routeId = normalizeRouteId(row.route_id ?? "");
            const stopId = row.stop_id?.trim();
            if (!routeId || !stopId) continue;
            touchRouteStop({
                mode: "rail",
                routeId,
                stopId,
                direction: normalizeDirection("rail", row.direction ?? row.direction_id),
                stopSequence: parseIntOrNull(row.stop_sequence),
            });
        }
        for (const row of busRouteStopsRaw) {
            const routeId = normalizeRouteId(row.route_id ?? "");
            const stopId = row.stop_id?.trim();
            if (!routeId || !stopId) continue;
            const mode = routeModeById.get(routeId) ?? "bus";
            touchRouteStop({
                mode,
                routeId,
                stopId,
                direction: normalizeDirection(mode, row.direction ?? row.direction_id),
                stopSequence: parseIntOrNull(row.stop_sequence),
            });
        }

        const scheduledRows: ScheduledStopTimeRow[] = [];
        const usedStopsByMode = new Map<SeptaMode, Set<string>>([
            ["rail", new Set<string>()],
            ["bus", new Set<string>()],
            ["trolley", new Set<string>()],
        ]);
        const ingestStopTimes = (rows: CsvRecord[]) => {
            for (const row of rows) {
                const tripId = row.trip_id?.trim() ?? "";
                const stopId = row.stop_id?.trim() ?? "";
                if (!tripId || !stopId) continue;
                const trip = tripById.get(tripId);
                if (!trip) continue;
                const arrivalSeconds = parseTimeToSeconds(row.arrival_time);
                if (arrivalSeconds === null) continue;
                const departureSeconds = parseTimeToSeconds(row.departure_time);
                const stopSequence = parseIntOrNull(row.stop_sequence);
                scheduledRows.push({
                    mode: trip.mode,
                    routeId: trip.routeId,
                    stopId,
                    direction: trip.direction,
                    tripId,
                    serviceId: trip.serviceId,
                    headsign: trip.headsign,
                    arrivalSeconds,
                    departureSeconds,
                    stopSequence,
                    active: true,
                });
                usedStopsByMode.get(trip.mode)?.add(stopId);
                touchRouteStop({
                    mode: trip.mode,
                    routeId: trip.routeId,
                    stopId,
                    direction: trip.direction,
                    stopSequence,
                });
            }
        };
        ingestStopTimes(railStopTimesRaw);
        ingestStopTimes(busStopTimesRaw);

        for (const row of routeStopByKey.values()) {
            usedStopsByMode.get(row.mode)?.add(row.stopId);
        }

        const stopRows: StopRow[] = [];
        for (const [key, stop] of stopByKey.entries()) {
            const [mode, stopId] = key.split(":", 2);
            if (!stopId) continue;
            if (!usedStopsByMode.get(mode as SeptaMode)?.has(stopId)) continue;
            stopRows.push(stop);
        }
        const includeBusStops = (mode: SeptaMode) => {
            for (const stopId of usedStopsByMode.get(mode) ?? []) {
                const src = globalBusStops.get(stopId);
                if (!src) continue;
                stopRows.push({
                    mode,
                    ...src,
                });
            }
        };
        includeBusStops("bus");
        includeBusStops("trolley");

        const serviceDates = new Map<string, { mode: SeptaMode; serviceId: string; serviceDate: string; active: boolean }>();
        const addServiceDate = (mode: SeptaMode, serviceId: string, serviceDate: string, active = true) => {
            const key = `${mode}:${serviceId}:${serviceDate}`;
            if (!serviceId || !serviceDate) return;
            if (!active) {
                serviceDates.delete(key);
                return;
            }
            serviceDates.set(key, { mode, serviceId, serviceDate, active: true });
        };

        const loadCalendar = (rows: CsvRecord[], modeResolver: (serviceId: string) => SeptaMode) => {
            const now = new Date();
            const startDate = addDaysUtc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), -1);
            const endDate = addDaysUtc(startDate, 60);
            for (const row of rows) {
                const serviceId = row.service_id?.trim() ?? "";
                if (!serviceId) continue;
                const mode = modeResolver(serviceId);
                const from = row.start_date?.trim() ?? "";
                const to = row.end_date?.trim() ?? "";
                let d = startDate;
                while (d <= endDate) {
                    const key = dateKey(d);
                    if (from && key < from) {
                        d = addDaysUtc(d, 1);
                        continue;
                    }
                    if (to && key > to) {
                        d = addDaysUtc(d, 1);
                        continue;
                    }
                    const weekday = weekdayKey(d);
                    const allowed = row[weekday] === "1";
                    if (allowed) addServiceDate(mode, serviceId, key, true);
                    d = addDaysUtc(d, 1);
                }
            }
        };

        const inferModeByServiceId = (serviceId: string): SeptaMode => {
            for (const trip of tripById.values()) {
                if (trip.serviceId === serviceId) return trip.mode;
            }
            return "bus";
        };
        loadCalendar(railCalendarRaw, () => "rail");
        loadCalendar(busCalendarRaw, inferModeByServiceId);

        const applyCalendarDates = (rows: CsvRecord[], modeResolver: (serviceId: string) => SeptaMode) => {
            for (const row of rows) {
                const serviceId = row.service_id?.trim() ?? "";
                const serviceDate = row.date?.trim() ?? "";
                const exception = row.exception_type?.trim() ?? "";
                if (!serviceId || !serviceDate) continue;
                const mode = modeResolver(serviceId);
                if (exception === "2") addServiceDate(mode, serviceId, serviceDate, false);
                else if (exception === "1") addServiceDate(mode, serviceId, serviceDate, true);
            }
        };
        applyCalendarDates(railCalendarDatesRaw, () => "rail");
        applyCalendarDates(busCalendarDatesRaw, inferModeByServiceId);

        const routeRowsDedup = Array.from(
            new Map(routeRows.map((r) => [`${r.mode}:${r.id}`, r])).values(),
        );
        const stopRowsDedup = Array.from(
            new Map(stopRows.map((s) => [`${s.mode}:${s.id}`, s])).values(),
        );
        const routeStopRows = Array.from(routeStopByKey.values());
        const serviceDateRows = Array.from(serviceDates.values());

        await db.transaction(async (tx: DbLike) => {
            await tx.delete(septaScheduledStopTimes);
            await tx.delete(septaServiceDates);
            await tx.delete(septaRouteStops);
            await tx.delete(septaStops);
            await tx.delete(septaRoutes);

            await insertChunks(
                tx,
                septaRoutes,
                routeRowsDedup.map((r) => ({
                    mode: r.mode,
                    id: r.id,
                    shortName: r.shortName,
                    longName: r.longName,
                    displayName: r.displayName,
                    active: true,
                })),
            );
            await insertChunks(
                tx,
                septaStops,
                stopRowsDedup.map((s) => ({
                    mode: s.mode,
                    id: s.id,
                    name: s.name,
                    normalizedName: s.normalizedName,
                    lat: s.lat,
                    lon: s.lon,
                    active: true,
                })),
            );
            await insertChunks(
                tx,
                septaRouteStops,
                routeStopRows.map((r) => ({
                    mode: r.mode,
                    routeId: r.routeId,
                    stopId: r.stopId,
                    direction: r.direction,
                    stopSequence: r.stopSequence,
                    active: true,
                })),
            );
            await insertChunks(tx, septaServiceDates, serviceDateRows);
            await insertChunks(tx, septaScheduledStopTimes, scheduledRows);
        });

        const stats = {
            sourceUrl: url,
            routes: routeRowsDedup.length,
            stops: stopRowsDedup.length,
            routeStops: routeStopRows.length,
            scheduledStopTimes: scheduledRows.length,
            serviceDates: serviceDateRows.length,
            errors: errors.length,
        };
        const status: "success" | "partial" = errors.length > 0 ? "partial" : "success";

        await db
            .update(septaIngestRuns)
            .set({
                status,
                statsJson: stats,
                errorJson: errors.length ? { messages: errors } : null,
                finishedAt: new Date().toISOString(),
            })
            .where(eq(septaIngestRuns.id, runId));

        return { runId, status, stats };
    } catch (err) {
        const message = err instanceof Error ? err.message : "SEPTA GTFS import failed";
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
    } finally {
        if (tmpRoot) {
            await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}
