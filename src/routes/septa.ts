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
} from "../septa/core_catalog.ts";

const parseLimit = (value: unknown, def: number, max: number) => {
    const parsed = Number(value ?? def);
    if (!Number.isFinite(parsed)) return def;
    return Math.max(1, Math.min(max, Math.floor(parsed)));
};

const parseDirection = (mode: CoreMode, value: string | undefined) => {
    const raw = (value ?? "").trim().toUpperCase();
    if (!raw) return "";
    if (mode === "rail") {
        if (raw === "N" || raw === "S") return raw;
        return "";
    }
    if (raw === "N" || raw === "0") return "0";
    if (raw === "S" || raw === "1") return "1";
    return "";
};

const providerIdForMode = (mode: CoreMode) =>
    mode === "rail" ? "septa-rail" : mode === "trolley" ? "septa-trolley" : "septa-bus";

type ArrivalPayload = {
    arrivals?: unknown;
    [k: string]: unknown;
};

export function registerSeptaRoutes(app: Hono, deps: dependency) {
    app.get("/septa/stations", async (c) => {
        const mode = parseCoreMode(c.req.query("mode") ?? "");
        if (!mode) return c.json({ error: "mode is required (rail|bus|trolley)" }, 400);

        const q = (c.req.query("q") ?? "").trim();
        const limit = parseLimit(c.req.query("limit"), 20, 100);
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

    app.get("/septa/stations/:mode/:stopId/lines", async (c) => {
        const mode = parseCoreMode(c.req.param("mode") ?? "");
        if (!mode) return c.json({ error: "Invalid mode" }, 400);

        const stopId = (c.req.param("stopId") ?? "").trim();
        if (!stopId) return c.json({ error: "stopId is required" }, 400);

        const station = await getCoreStationById(deps.db, mode, stopId);
        if (!station) return c.json({ error: "Station not found" }, 404);

        const lines = await listCoreLinesForStation(deps.db, mode, stopId);
        return c.json({
            mode,
            stopId: station.stopId,
            station: station.name,
            lines,
        });
    });

    app.get("/septa/stations/:mode/:stopId/arrivals", async (c) => {
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

        const stationLines = await listCoreLinesForStation(deps.db, mode, stopId);
        const stationLineIdSet = new Set(stationLines.map((line) => line.id));
        const invalidLineIds = requestedLineIds.filter((lineId) => !stationLineIdSet.has(lineId));
        if (invalidLineIds.length > 0) {
            return c.json(
                {
                    error: "Some line_ids do not serve this station",
                    invalidLineIds,
                },
                400,
            );
        }

        const lineMeta = new Map(stationLines.map((line) => [line.id, line]));
        const direction = parseDirection(mode, c.req.query("direction"));
        const limitPerLine = parseLimit(c.req.query("limit_per_line"), 3, 10);
        const providerId = providerIdForMode(mode);
        const provider = providerRegistry.get(providerId);
        if (!provider) return c.json({ error: "provider not available" }, 500);

        const providerStop = mode === "rail" ? station.name : station.stopId;
        const now = Date.now();

        const groups = await Promise.all(
            requestedLineIds.map(async (lineId) => {
                const params: Record<string, string> = {
                    line: lineId,
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
                    const arrivals = Array.isArray(payload.arrivals) ? payload.arrivals.slice(0, limitPerLine) : [];
                    const line = lineMeta.get(lineId);
                    return {
                        lineId,
                        lineLabel: line?.label ?? lineId,
                        arrivals,
                        error: null,
                    };
                } catch (err) {
                    const line = lineMeta.get(lineId);
                    return {
                        lineId,
                        lineLabel: line?.label ?? lineId,
                        arrivals: [],
                        error: err instanceof Error ? err.message : "Failed to fetch arrivals",
                    };
                }
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
