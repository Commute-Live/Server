import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const REQUIRED_GTFS_FILES = ["routes.txt", "stops.txt", "trips.txt", "stop_times.txt"] as const;

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

function parseCsvText(content: string): CsvRecord[] {
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

const normalizeZipPath = (value: string) =>
    value
        .replaceAll("\\", "/")
        .replace(/^\.\/+/, "")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");

const zipJoin = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);
const stripZipExt = (value: string) => value.replace(/\.zip$/i, "");

async function unzipListEntries(zipPath: string): Promise<string[]> {
    const proc = Bun.spawn(["unzip", "-Z1", zipPath], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`Failed to list zip entries: ${err || `exit ${code}`}`);
    }
    return stdout
        .split(/\r?\n/)
        .map((s) => normalizeZipPath(s))
        .filter((s) => s.length > 0);
}

async function unzipReadTextEntry(zipPath: string, entryPath: string): Promise<string> {
    const proc = Bun.spawn(["unzip", "-p", zipPath, entryPath], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`Failed to read zip entry ${entryPath}: ${err || `exit ${code}`}`);
    }
    return stdout;
}

async function unzipReadBinaryEntry(zipPath: string, entryPath: string): Promise<Uint8Array> {
    const proc = Bun.spawn(["unzip", "-p", zipPath, entryPath], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const code = await proc.exited;
    const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`Failed to read zip entry ${entryPath}: ${err || `exit ${code}`}`);
    }
    return bytes;
}

async function listZipTextEntries(zipPath: string): Promise<Set<string>> {
    const entryNames = await unzipListEntries(zipPath);
    const out = new Set<string>();
    for (const rawPath of entryNames) {
        const path = normalizeZipPath(rawPath);
        if (!path || path.endsWith("/")) continue;
        if (path.toLowerCase().endsWith(".txt")) {
            out.add(path);
            continue;
        }
        // Some feeds package bus/rail as nested zip files.
        if (path.toLowerCase().endsWith(".zip")) {
            const nestedBytes = await unzipReadBinaryEntry(zipPath, rawPath);
            const nestedTmpRoot = await mkdtemp(join(tmpdir(), "septa-gtfs-nested-"));
            try {
                const nestedZipPath = join(nestedTmpRoot, "nested.zip");
                await writeFile(nestedZipPath, nestedBytes);
                const nestedEntries = await listZipTextEntries(nestedZipPath);
                const nestedPrefix = stripZipExt(path.split("/").pop() ?? "nested");
                for (const nestedPath of nestedEntries.values()) {
                    const merged = normalizeZipPath(`${nestedPrefix}/${nestedPath}`);
                    out.add(merged);
                }
            } finally {
                await rm(nestedTmpRoot, { recursive: true, force: true }).catch(() => undefined);
            }
        }
    }
    return out;
}

function readCsvFromZip(
    zipPath: string,
    dir: string,
    fileName: string,
    entrySet: Set<string>,
    required = true,
): Promise<CsvRecord[]> {
    const path = zipJoin(dir, fileName);
    if (!entrySet.has(path)) {
        if (required) {
            throw new Error(`Missing required GTFS file in zip: ${path}`);
        }
        return Promise.resolve([]);
    }
    return unzipReadTextEntry(zipPath, path).then(parseCsvText);
}

function detectSeptaDatasets(entries: Set<string>): { busDir: string; railDir: string } {
    const dirs = new Set<string>();
    for (const path of entries.values()) {
        const idx = path.lastIndexOf("/");
        dirs.add(idx >= 0 ? path.slice(0, idx) : "");
    }

    const candidates = Array.from(dirs).filter((dir) =>
        REQUIRED_GTFS_FILES.every((f) => entries.has(zipJoin(dir, f))),
    );
    if (candidates.length === 0) {
        throw new Error("No GTFS dataset in zip contains routes/stops/trips/stop_times");
    }

    const busByName = candidates.find((d) => /google[_-]?bus/i.test(d) || /\/bus\//i.test(`/${d}/`));
    const railByName = candidates.find((d) => /google[_-]?rail/i.test(d) || /\/rail\//i.test(`/${d}/`));
    if (busByName && railByName && busByName !== railByName) {
        return { busDir: busByName, railDir: railByName };
    }

    const scored = candidates.map((dir) => {
        let busScore = 0;
        let railScore = 0;
        const lower = dir.toLowerCase();
        if (lower.includes("bus")) busScore += 3;
        if (lower.includes("rail")) railScore += 3;
        if (entries.has(zipJoin(dir, "fare_products.txt")) || entries.has(zipJoin(dir, "fare_media.txt"))) {
            busScore += 4;
        }
        if (entries.has(zipJoin(dir, "rider_categories.txt")) || entries.has(zipJoin(dir, "fare_transfer_rules.txt"))) {
            busScore += 2;
        }
        if (entries.has(zipJoin(dir, "directions.txt"))) railScore += 1;
        return { dir, busScore, railScore };
    });

    const busDir = [...scored].sort((a, b) => b.busScore - a.busScore)[0]?.dir;
    const railDir = [...scored]
        .filter((s) => s.dir !== busDir)
        .sort((a, b) => b.railScore - a.railScore)[0]?.dir;
    if (!busDir || !railDir) {
        throw new Error("Could not detect distinct bus and rail datasets from zip contents");
    }
    return { busDir, railDir };
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
        const res = await fetch(url);
        if (!res.ok) throw new Error(`GTFS download failed ${res.status} ${res.statusText}`);
        const zipBytes = Buffer.from(await res.arrayBuffer());
        tmpRoot = await mkdtemp(join(tmpdir(), "septa-gtfs-zip-"));
        const zipPath = join(tmpRoot, "feed.zip");
        await writeFile(zipPath, zipBytes);
        const zipEntries = await parseZipTextEntries(zipPath);
        const { busDir, railDir } = detectSeptaDatasets(zipEntries);

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
            readCsvFromZip(zipEntries, railDir, "routes.txt"),
            readCsvFromZip(zipEntries, railDir, "stops.txt"),
            readCsvFromZip(zipEntries, railDir, "trips.txt"),
            readCsvFromZip(zipEntries, railDir, "stop_times.txt"),
            readCsvFromZip(zipEntries, railDir, "route_stops.txt", false),
            readCsvFromZip(zipEntries, railDir, "calendar.txt", false),
            readCsvFromZip(zipEntries, railDir, "calendar_dates.txt", false),
            readCsvFromZip(zipEntries, busDir, "routes.txt"),
            readCsvFromZip(zipEntries, busDir, "stops.txt"),
            readCsvFromZip(zipEntries, busDir, "trips.txt"),
            readCsvFromZip(zipEntries, busDir, "stop_times.txt"),
            readCsvFromZip(zipEntries, busDir, "route_stops.txt", false),
            readCsvFromZip(zipEntries, busDir, "calendar.txt", false),
            readCsvFromZip(zipEntries, busDir, "calendar_dates.txt", false),
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
            zipEntries: zipEntries.size,
            busDatasetDir: busDir,
            railDatasetDir: railDir,
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
