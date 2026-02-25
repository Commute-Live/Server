import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";
import { buildKey, providerRegistry } from "../providers/index.ts";
import {
    getCoreStationById,
    listCoreLinesForStation,
    listCoreStations,
    normalizeCoreLineId,
    parseCoreMode,
    type CoreMode,
} from "../mta/core_catalog.ts";

const parseLimit = (value: unknown, def: number, max: number) => {
    const parsed = Number(value ?? def);
    if (!Number.isFinite(parsed)) return def;
    return Math.max(1, Math.min(max, Math.floor(parsed)));
};

const parseDirection = (mode: CoreMode, value: string | undefined) => {
    const raw = (value ?? "").trim().toUpperCase();
    if (!raw) return "";
    if (mode === "subway") {
        if (raw === "N" || raw === "S") return raw;
        return "";
    }

    if (raw === "N" || raw === "0") return "0";
    if (raw === "S" || raw === "1") return "1";
    return "";
};

const providerIdForMode = (mode: CoreMode) => {
    if (mode === "subway") return "mta-subway";
    if (mode === "bus") return "mta-bus";
    if (mode === "lirr") return "mta-lirr";
    return "mta-mnr";
};

type ArrivalPayload = {
    arrivals?: unknown;
    [k: string]: unknown;
};

type ArrivalLike = {
    arrivalTime?: string | null;
    destination?: string | null;
    [k: string]: unknown;
};

const sortAndLimitArrivals = (arrivals: ArrivalLike[], limit: number): ArrivalLike[] => {
    const deduped = new Map<string, ArrivalLike>();

    for (const row of arrivals) {
        const arrivalTime = typeof row.arrivalTime === "string" ? row.arrivalTime : "";
        if (!arrivalTime) continue;
        const destination = typeof row.destination === "string" ? row.destination : "";
        const key = `${arrivalTime}|${destination}`;
        if (!deduped.has(key)) {
            deduped.set(key, row);
        }
    }

    return Array.from(deduped.values())
        .sort((a, b) => {
            const at = Date.parse(a.arrivalTime ?? "");
            const bt = Date.parse(b.arrivalTime ?? "");
            if (!Number.isFinite(at) && !Number.isFinite(bt)) return 0;
            if (!Number.isFinite(at)) return 1;
            if (!Number.isFinite(bt)) return -1;
            return at - bt;
        })
        .slice(0, limit);
};

export function registerMtaRoutes(app: Hono, deps: dependency) {
    app.get("/mta/stations", async (c) => {
        const mode = parseCoreMode(c.req.query("mode") ?? "");
        if (!mode) return c.json({ error: "mode is required (subway|bus|lirr|mnr)" }, 400);

        const q = (c.req.query("q") ?? "").trim();
        const limit = parseLimit(c.req.query("limit"), 20, 200);
        const stations = await listCoreStations(deps.db, mode, q, limit);

        return c.json({
            mode,
            count: stations.length,
            stations: stations.map((s) => ({
                stopId: s.stopId,
                name: s.name,
                lat: s.lat,
                lon: s.lon,
            })),
        });
    });

    app.get("/mta/stations/:mode/:stopId/lines", async (c) => {
        const mode = parseCoreMode(c.req.param("mode") ?? "");
        if (!mode) return c.json({ error: "Invalid mode" }, 400);

        const stopId = (c.req.param("stopId") ?? "").trim();
        if (!stopId) return c.json({ error: "stopId is required" }, 400);

        const station = await getCoreStationById(deps.db, mode, stopId);
        if (!station) return c.json({ error: "Station not found" }, 404);

        const lines = await listCoreLinesForStation(deps.db, mode, station.stopId);
        return c.json({
            mode,
            stopId: station.stopId,
            station: station.name,
            lines,
        });
    });

    app.get("/mta/stations/:mode/:stopId/arrivals", async (c) => {
        const mode = parseCoreMode(c.req.param("mode") ?? "");
        if (!mode) return c.json({ error: "Invalid mode" }, 400);

        const stopId = (c.req.param("stopId") ?? "").trim();
        if (!stopId) return c.json({ error: "stopId is required" }, 400);

        const station = await getCoreStationById(deps.db, mode, stopId);
        if (!station) return c.json({ error: "Station not found" }, 404);

        const rawLineIds = (c.req.query("line_ids") ?? "")
            .split(",")
            .map((v) => normalizeCoreLineId(mode, v))
            .filter((v) => v.length > 0);
        const requestedLineIds = Array.from(new Set(rawLineIds));
        if (requestedLineIds.length === 0) {
            return c.json({ error: "line_ids is required (comma-separated route ids)" }, 400);
        }

        const stationLines = await listCoreLinesForStation(deps.db, mode, station.stopId);
        const stationLineIdSet = new Set(stationLines.map((line) => normalizeCoreLineId(mode, line.id)));
        const invalidLineIds = requestedLineIds.filter((lineId) => !stationLineIdSet.has(normalizeCoreLineId(mode, lineId)));
        if (invalidLineIds.length > 0) {
            return c.json(
                {
                    error: "Some line_ids do not serve this station",
                    invalidLineIds,
                },
                400,
            );
        }

        const lineMeta = new Map(stationLines.map((line) => [normalizeCoreLineId(mode, line.id), line]));
        const direction = parseDirection(mode, c.req.query("direction"));
        const limitPerLine = parseLimit(c.req.query("limit_per_line"), 3, 12);
        const providerId = providerIdForMode(mode);
        const provider = providerRegistry.get(providerId);
        if (!provider) return c.json({ error: "provider not available" }, 500);

        let providerStops = mode === "bus" ? [station.stopId] : station.childStopIds;
        providerStops = Array.from(new Set(providerStops.map((v) => v.trim()).filter((v) => v.length > 0)));
        if (providerStops.length === 0) providerStops = [station.stopId];

        if (mode === "subway" && (direction === "N" || direction === "S")) {
            const scoped = providerStops.filter((stop) => stop.toUpperCase().endsWith(direction));
            if (scoped.length > 0) {
                providerStops = scoped;
            }
        }

        const now = Date.now();

        const groups = await Promise.all(
            requestedLineIds.map(async (lineId) => {
                const normalizedLineId = normalizeCoreLineId(mode, lineId);
                const arrivalsAcrossStops: ArrivalLike[] = [];
                const errors: string[] = [];

                await Promise.all(
                    providerStops.map(async (providerStop) => {
                        const params: Record<string, string> = {
                            line: normalizedLineId,
                            stop: providerStop,
                            realtime_only: "1",
                        };
                        if (direction) params.direction = direction;

                        const key = buildKey(providerId, "arrivals", params);
                        try {
                            const result = await provider.fetch(key, {
                                now,
                                key,
                                log: () => undefined,
                            });
                            const payload =
                                result.payload && typeof result.payload === "object"
                                    ? (result.payload as ArrivalPayload)
                                    : {};
                            const arrivals = Array.isArray(payload.arrivals) ? (payload.arrivals as ArrivalLike[]) : [];
                            arrivalsAcrossStops.push(...arrivals);
                        } catch (err) {
                            errors.push(err instanceof Error ? err.message : "Failed to fetch arrivals");
                        }
                    }),
                );

                const line = lineMeta.get(normalizedLineId);
                return {
                    lineId: normalizedLineId,
                    lineLabel: line?.label ?? normalizedLineId,
                    arrivals: sortAndLimitArrivals(arrivalsAcrossStops, limitPerLine),
                    error: arrivalsAcrossStops.length === 0 && errors.length > 0 ? errors[0] : null,
                };
            }),
        );

        return c.json({
            mode,
            stopId: station.stopId,
            station: station.name,
            direction: direction || null,
            lineCount: groups.length,
            groups,
        });
    });
}
