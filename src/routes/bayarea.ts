import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";
import { buildKey, providerRegistry } from "../providers/index.ts";
import {
    getCoreStationById,
    listCoreLinesByMode,
    listCoreLinesForStation,
    listCoreStations,
    normalizeCoreLineId,
    normalizeOperatorId,
    parseCoreMode,
    type CoreMode,
} from "../bayarea/core_catalog.ts";

const parseLimit = (value: unknown, def: number, max: number) => {
    const parsed = Number(value ?? def);
    if (!Number.isFinite(parsed)) return def;
    return Math.max(1, Math.min(max, Math.floor(parsed)));
};

const normalizeDirectionToken = (raw: string): string => {
    const value = raw.trim().toUpperCase();
    if (!value) return "";
    if (value === "0") return "OUTBOUND";
    if (value === "1") return "INBOUND";
    if (value === "OB") return "OUTBOUND";
    if (value === "IB") return "INBOUND";
    if (value === "N" || value === "NB" || value === "NORTH" || value === "NORTHBOUND") return "N";
    if (value === "S" || value === "SB" || value === "SOUTH" || value === "SOUTHBOUND") return "S";
    if (value === "E" || value === "EB" || value === "EAST" || value === "EASTBOUND") return "E";
    if (value === "W" || value === "WB" || value === "WEST" || value === "WESTBOUND") return "W";
    if (value === "INBOUND" || value === "OUTBOUND") return value;
    return "";
};

const parseDirection = (value: string | undefined) => normalizeDirectionToken(value ?? "");

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

const providerIdForMode = (_mode: CoreMode) => "bayarea-511";

export function registerBayAreaRoutes(app: Hono, deps: dependency) {
    app.get("/bayarea/stations", async (c) => {
        const operatorIdRaw = c.req.query("operator_id") ?? "";
        const operatorId = normalizeOperatorId(operatorIdRaw);
        if (!operatorId) return c.json({ error: "operator_id is required" }, 400);

        const mode = parseCoreMode(c.req.query("mode") ?? "");
        if (!mode) return c.json({ error: "mode is required (bus|tram|cableway)" }, 400);

        const q = (c.req.query("q") ?? "").trim();
        const limit = parseLimit(c.req.query("limit"), 20, 500);
        const stations = await listCoreStations(deps.db, operatorId, mode, q, limit);

        return c.json({
            operatorId,
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

    app.get("/bayarea/stations/:mode/lines", async (c) => {
        const operatorIdRaw = c.req.query("operator_id") ?? "";
        const operatorId = normalizeOperatorId(operatorIdRaw);
        if (!operatorId) return c.json({ error: "operator_id is required" }, 400);

        const mode = parseCoreMode(c.req.param("mode") ?? "");
        if (!mode) return c.json({ error: "Invalid mode" }, 400);

        const lines = await listCoreLinesByMode(deps.db, operatorId, mode);
        return c.json({
            operatorId,
            mode,
            count: lines.length,
            lines,
        });
    });

    app.get("/bayarea/stations/:mode/:stopId/lines", async (c) => {
        const operatorIdRaw = c.req.query("operator_id") ?? "";
        const operatorId = normalizeOperatorId(operatorIdRaw);
        if (!operatorId) return c.json({ error: "operator_id is required" }, 400);

        const mode = parseCoreMode(c.req.param("mode") ?? "");
        if (!mode) return c.json({ error: "Invalid mode" }, 400);

        const stopId = (c.req.param("stopId") ?? "").trim();
        if (!stopId) return c.json({ error: "stopId is required" }, 400);

        const station = await getCoreStationById(deps.db, operatorId, mode, stopId);
        if (!station) return c.json({ error: "Station not found" }, 404);

        const lines = await listCoreLinesForStation(deps.db, operatorId, mode, station.stopId);
        return c.json({
            operatorId,
            mode,
            stopId: station.stopId,
            station: station.name,
            lines,
        });
    });

    app.get("/bayarea/stations/:mode/:stopId/arrivals", async (c) => {
        const operatorIdRaw = c.req.query("operator_id") ?? "";
        const operatorId = normalizeOperatorId(operatorIdRaw);
        if (!operatorId) return c.json({ error: "operator_id is required" }, 400);

        const mode = parseCoreMode(c.req.param("mode") ?? "");
        if (!mode) return c.json({ error: "Invalid mode" }, 400);

        const stopId = (c.req.param("stopId") ?? "").trim();
        if (!stopId) return c.json({ error: "stopId is required" }, 400);

        const station = await getCoreStationById(deps.db, operatorId, mode, stopId);
        if (!station) return c.json({ error: "Station not found" }, 404);

        const rawLineIds = (c.req.query("line_ids") ?? "")
            .split(",")
            .map((v) => normalizeCoreLineId(mode, v))
            .filter((v) => v.length > 0);
        const requestedLineIds = Array.from(new Set(rawLineIds));
        if (requestedLineIds.length === 0) {
            return c.json({ error: "line_ids is required (comma-separated route ids)" }, 400);
        }

        const stationLines = await listCoreLinesForStation(deps.db, operatorId, mode, station.stopId);
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
        const direction = parseDirection(c.req.query("direction"));
        const limitPerLine = parseLimit(c.req.query("limit_per_line"), 3, 12);

        const providerId = providerIdForMode(mode);
        const provider = providerRegistry.get(providerId);
        if (!provider) return c.json({ error: "provider not available" }, 500);

        let providerStops = station.childStopIds;
        providerStops = Array.from(new Set(providerStops.map((v) => v.trim()).filter((v) => v.length > 0)));
        if (providerStops.length === 0) providerStops = [station.stopId];

        const now = Date.now();

        const groups = await Promise.all(
            requestedLineIds.map(async (lineId) => {
                const normalizedLineId = normalizeCoreLineId(mode, lineId);
                const arrivalsAcrossStops: ArrivalLike[] = [];
                const errors: string[] = [];

                await Promise.all(
                    providerStops.map(async (providerStop) => {
                        const params: Record<string, string> = {
                            operator_id: operatorId,
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
            operatorId,
            mode,
            stopId: station.stopId,
            station: station.name,
            direction: direction || null,
            lineCount: groups.length,
            groups,
        });
    });
}
