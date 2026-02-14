import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";
import { listLinesForStop, listStops, listStopsForLine, resolveStopName } from "../gtfs/stops_lookup.ts";
import { listCtaSubwayLines, listCtaSubwayLinesForStop, listCtaSubwayStops } from "../gtfs/cta_subway_lookup.ts";
import { listMtaBusRoutes, listMtaBusStopsForRoute } from "../providers/new-york/bus_stops.ts";

export function registerStops(app: Hono, _deps: dependency) {
    const parseLimit = (value: unknown, def = 30, max = 1000) => {
        const raw = Number(value ?? def);
        return Number.isFinite(raw) ? Math.max(1, Math.min(max, Math.floor(raw))) : def;
    };

    const loadCsvLines = (path: string) => {
        return require("node:fs").readFileSync(path, "utf8").split(/\r?\n/).filter((l: string) => l.length > 0);
    };

    const buildSeptaLoader = (mode: "bus" | "rail") => {
        const base = mode === "bus" ? "data/septa/bus" : "data/septa/rail";
        let stopMap: Map<string, string> | null = null;
        let routeToStops: Map<string, Set<string>> | null = null;

        const ensureStops = () => {
            if (stopMap) return stopMap;
            const rows = loadCsvLines(`${base}/stops.txt`);
            const header = rows.shift()?.split(",") ?? [];
            const idIdx = header.indexOf("stop_id");
            const nameIdx = header.indexOf("stop_name");
            stopMap = new Map();
            for (const line of rows) {
                const cols = line.split(",");
                const id = cols[idIdx]?.trim();
                const name = cols[nameIdx]?.trim();
                if (id) stopMap.set(id, name ?? id);
            }
            return stopMap;
        };

        const ensureRouteStops = () => {
            if (routeToStops) return routeToStops;
            routeToStops = new Map();
            const rows = loadCsvLines(`${base}/route_stops.txt`);
            const header = rows.shift()?.split(",") ?? [];
            const rIdx = header.indexOf("route_id");
            const sIdx = header.indexOf("stop_id");
            for (const line of rows) {
                const cols = line.split(",");
                const r = cols[rIdx]?.trim();
                const s = cols[sIdx]?.trim();
                if (!r || !s) continue;
                if (!routeToStops.has(r)) routeToStops.set(r, new Set());
                routeToStops.get(r)!.add(s);
            }
            return routeToStops;
        };

        return {
            stopsForRoute: (route: string, limit: number) => {
                const routeStops = Array.from(ensureRouteStops().get(route) ?? []).slice(0, limit);
                const map = ensureStops();
                const stops = routeStops.map((id) => ({ id, name: map.get(id) ?? id }));
                return { count: stops.length, stops };
            },
        };
    };

    const septaBusStops = buildSeptaLoader("bus");
    const septaRailStops = buildSeptaLoader("rail");

    app.get("/stops", (c) => {
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);

        let stops = listStops();
        if (q.length > 0) {
            stops = stops.filter((s) => s.stop.toLowerCase().includes(q) || s.stopId.toLowerCase().includes(q));
        }

        return c.json({ count: stops.length, stops: stops.slice(0, limit) });
    });

    app.get("/stops/:stopId/lines", async (c) => {
        const stopId = (c.req.param("stopId") ?? "").trim().toUpperCase();
        if (!stopId) {
            return c.json({ error: "stopId is required" }, 400);
        }

        const stop = resolveStopName(stopId);
        if (!stop) {
            return c.json({ error: "Stop not found" }, 404);
        }

        const lines = await listLinesForStop(stopId);
        return c.json({ stopId, stop, lines });
    });

    // NYC subway stops scoped to route (line), for line-first station selection UX.
    app.get("/providers/new-york/stops/subway", async (c) => {
        const route = (c.req.query("route") ?? "").trim().toUpperCase();
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);
        if (!route) return c.json({ error: "route is required (e.g., A, 7, Q)" }, 400);

        let stops = await listStopsForLine(route);
        if (q.length > 0) {
            stops = stops.filter((s) => s.stop.toLowerCase().includes(q) || s.stopId.toLowerCase().includes(q));
        }
        return c.json({ route, count: stops.length, stops: stops.slice(0, limit) });
    });

    app.get("/providers/new-york/stops/bus", async (c) => {
        const route = (c.req.query("route") ?? "").trim().toUpperCase();
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);
        if (!route) return c.json({ error: "route is required (e.g., M15, Bx12, Q44)" }, 400);

        try {
            let stops = await listMtaBusStopsForRoute(route);
            if (q.length > 0) {
                stops = stops.filter((s) => s.stop.toLowerCase().includes(q) || s.stopId.toLowerCase().includes(q));
            }
            return c.json({ route, count: stops.length, stops: stops.slice(0, limit) });
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to fetch NYC bus stops";
            return c.json({ error: message }, 500);
        }
    });

    app.get("/providers/new-york/routes/bus", async (c) => {
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);
        try {
            let routes = await listMtaBusRoutes();
            if (q.length > 0) {
                routes = routes.filter((r) => r.id.toLowerCase().includes(q) || r.label.toLowerCase().includes(q));
            }
            return c.json({ count: routes.length, routes: routes.slice(0, limit) });
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to fetch NYC bus routes";
            return c.json({ error: message }, 500);
        }
    });

    app.get("/providers/chicago/stops/subway", (c) => {
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);
        let stops = listCtaSubwayStops();
        if (q.length > 0) {
            stops = stops.filter((s) => s.stop.toLowerCase().includes(q) || s.stopId.toLowerCase().includes(q));
        }
        return c.json({ count: stops.length, stops: stops.slice(0, limit) });
    });

    app.get("/providers/chicago/stops/:stopId/lines", async (c) => {
        const stopId = (c.req.param("stopId") ?? "").trim();
        if (!stopId) return c.json({ error: "stopId is required" }, 400);

        const station = listCtaSubwayStops().find((s) => s.stopId === stopId);
        const lines = await listCtaSubwayLinesForStop(stopId);
        if (!station && lines.length === 0) {
            return c.json({ error: "Stop not found" }, 404);
        }

        return c.json({
            stopId: station?.stopId ?? stopId,
            stop: station?.stop ?? stopId,
            lines,
        });
    });

    app.get("/providers/chicago/routes/subway", (c) => {
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limit = parseLimit(c.req.query("limit"), 30, 100);
        let routes = listCtaSubwayLines().map((id) => ({ id, label: id }));
        if (q.length > 0) {
            routes = routes.filter((r) => r.id.toLowerCase().includes(q) || r.label.toLowerCase().includes(q));
        }
        return c.json({ count: routes.length, routes: routes.slice(0, limit) });
    });

    const fetchMbtaStops = async (route: string, limit: number, routeType?: number) => {
        const apiKey = process.env.MBTA_API_KEY;
        if (!apiKey) {
            return { error: "MBTA_API_KEY not configured", status: 500 };
        }
        const search = new URLSearchParams({
            "filter[route]": route,
            "page[limit]": limit.toString(),
            sort: "name",
        });
        if (routeType !== undefined) {
            search.set("filter[route_type]", routeType.toString());
        }
        const url = `https://api-v3.mbta.com/stops?${search.toString()}`;
        const res = await fetch(url, { headers: { "x-api-key": apiKey } });
        if (!res.ok) {
            return { error: `MBTA error ${res.status} ${res.statusText}`, status: 502 };
        }
        const json = (await res.json()) as {
            data?: Array<{
                id: string;
                attributes?: { name?: string; municipality?: string; latitude?: number; longitude?: number };
            }>;
        };
        const stops =
            json.data?.map((item) => ({
                id: item.id,
                name: item.attributes?.name ?? item.id,
                municipality: item.attributes?.municipality ?? "",
                latitude: item.attributes?.latitude ?? null,
                longitude: item.attributes?.longitude ?? null,
            })) ?? [];
        return { stops };
    };

    // MBTA subway/light rail stops (route required)
    app.get("/providers/boston/stops/subway", async (c) => {
        const route = (c.req.query("route") ?? "").trim();
        const limit = parseLimit(c.req.query("limit"), 30, 200);
        if (!route) return c.json({ error: "route is required (e.g., Red, Orange, Green-B)" }, 400);
        const result = await fetchMbtaStops(route, limit /* route_type omitted to allow B/C/D/E */);
        if ("error" in result) return c.json({ error: result.error }, result.status);
        return c.json({ count: result.stops.length, stops: result.stops });
    });

    // MBTA bus stops (route required)
    app.get("/providers/boston/stops/bus", async (c) => {
        const route = (c.req.query("route") ?? "").trim();
        const limit = parseLimit(c.req.query("limit"), 30, 200);
        if (!route) return c.json({ error: "route is required (e.g., 1, 66, SL1)" }, 400);
        const result = await fetchMbtaStops(route, limit, 3 /* bus */);
        if ("error" in result) return c.json({ error: result.error }, result.status);
        return c.json({ count: result.stops.length, stops: result.stops });
    });

    // SEPTA rail stops (GTFS static)
    app.get("/providers/philly/stops/rail", (c) => {
        const route = (c.req.query("route") ?? "").trim();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);
        if (!route) return c.json({ error: "route is required (e.g., AIR, FOX, WTR)" }, 400);
        const result = septaRailStops.stopsForRoute(route, limit);
        return c.json(result);
    });

    // SEPTA bus/trolley stops (GTFS static)
    app.get("/providers/philly/stops/bus", (c) => {
        const route = (c.req.query("route") ?? "").trim();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);
        if (!route) return c.json({ error: "route is required (e.g., 33, 47M)" }, 400);
        const result = septaBusStops.stopsForRoute(route, limit);
        return c.json(result);
    });
}
