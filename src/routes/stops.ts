import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";
import { listLinesForStop, listStops, listStopsForLine, resolveStopName } from "../gtfs/stops_lookup.ts";
import { listCtaSubwayLines, listCtaSubwayLinesForStop, listCtaSubwayStops } from "../gtfs/cta_subway_lookup.ts";
import { listMtaBusRoutes, listMtaBusStopsForRoute } from "../providers/new-york/bus_stops.ts";
import {
    listSeptaBusLinesForStop,
    listSeptaBusRoutes,
    listSeptaBusStops,
    listSeptaBusStopsForRoute,
    listSeptaRailLinesForStop,
    listSeptaRailLinesForStopByDirection,
    listSeptaRailRoutes,
    listSeptaRailStops,
    listSeptaRailStopsForRoute,
    resolveSeptaRailStopName,
} from "../providers/philadelphia/stops_lookup.ts";

export function registerStops(app: Hono, _deps: dependency) {
    type MbtaStop = {
        id: string;
        name: string;
        municipality: string;
        latitude: number | null;
        longitude: number | null;
    };

    type MbtaStopsResult =
        | { ok: true; stops: MbtaStop[] }
        | { ok: false; error: string; status: 500 | 502 };

    const parseLimit = (value: unknown, def = 30, max = 1000) => {
        const raw = Number(value ?? def);
        return Number.isFinite(raw) ? Math.max(1, Math.min(max, Math.floor(raw))) : def;
    };

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

    const fetchMbtaStops = async (route: string, limit: number, routeType?: number): Promise<MbtaStopsResult> => {
        const apiKey = process.env.MBTA_API_KEY;
        if (!apiKey) {
            return { ok: false, error: "MBTA_API_KEY not configured", status: 500 };
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
            return { ok: false, error: `MBTA error ${res.status} ${res.statusText}`, status: 502 };
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
        return { ok: true, stops };
    };

    // MBTA subway/light rail stops (route required)
    app.get("/providers/boston/stops/subway", async (c) => {
        const route = (c.req.query("route") ?? "").trim();
        const limit = parseLimit(c.req.query("limit"), 30, 200);
        if (!route) return c.json({ error: "route is required (e.g., Red, Orange, Green-B)" }, 400);
        const result = await fetchMbtaStops(route, limit /* route_type omitted to allow B/C/D/E */);
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json({ count: result.stops.length, stops: result.stops });
    });

    // MBTA bus stops (route required)
    app.get("/providers/boston/stops/bus", async (c) => {
        const route = (c.req.query("route") ?? "").trim();
        const limit = parseLimit(c.req.query("limit"), 30, 200);
        if (!route) return c.json({ error: "route is required (e.g., 1, 66, SL1)" }, 400);
        const result = await fetchMbtaStops(route, limit, 3 /* bus */);
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json({ count: result.stops.length, stops: result.stops });
    });

    // SEPTA rail stops (route optional; when omitted returns all stations)
    app.get("/providers/philly/stops/rail", (c) => {
        const route = (c.req.query("route") ?? "").trim();
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);
        const stops =
            route.length > 0 ? listSeptaRailStopsForRoute(route, limit) : listSeptaRailStops(q, limit);
        const mapped = stops.map((s) => ({ id: s.stopId, name: s.stop }));
        return c.json({ count: mapped.length, stops: mapped });
    });

    // SEPTA train stops alias (same as rail)
    app.get("/providers/philly/stops/train", (c) => {
        const route = (c.req.query("route") ?? "").trim();
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);
        const stops =
            route.length > 0 ? listSeptaRailStopsForRoute(route, limit) : listSeptaRailStops(q, limit);
        const mapped = stops.map((s) => ({ id: s.stopId, name: s.stop }));
        return c.json({ count: mapped.length, stops: mapped });
    });

    // SEPTA bus/trolley stops (route optional; when omitted returns all stops)
    app.get("/providers/philly/stops/bus", (c) => {
        const route = (c.req.query("route") ?? "").trim();
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);
        const stops =
            route.length > 0 ? listSeptaBusStopsForRoute(route, limit) : listSeptaBusStops(q, limit);
        const mapped = stops.map((s) => ({ id: s.stopId, name: s.stop }));
        return c.json({ count: mapped.length, stops: mapped });
    });

    // SEPTA lines by selected stop (station-first flow)
    app.get("/providers/philly/stops/train/:stopId/lines", async (c) => {
        const stopId = (c.req.param("stopId") ?? "").trim();
        if (!stopId) return c.json({ error: "stopId is required" }, 400);
        const directionRaw = (c.req.query("direction") ?? "").trim().toUpperCase();
        const direction = directionRaw === "N" || directionRaw === "S" ? directionRaw : "";
        const directionScoped =
            direction === "N" || direction === "S"
                ? listSeptaRailLinesForStopByDirection(stopId, direction).map((line) => line.id)
                : [];
        if (directionScoped.length > 0) {
            return c.json({ stopId, direction: direction || null, lines: directionScoped, source: "static-direction" });
        }

        const lines = listSeptaRailLinesForStop(stopId).map((line) => line.id);
        return c.json({ stopId, direction: direction || null, lines, source: "static-all" });
    });

    app.get("/providers/philly/stops/rail/:stopId/lines", (c) => {
        const stopId = (c.req.param("stopId") ?? "").trim();
        if (!stopId) return c.json({ error: "stopId is required" }, 400);
        const lines = listSeptaRailLinesForStop(stopId).map((line) => line.id);
        return c.json({ stopId, lines });
    });

    app.get("/providers/philly/stops/bus/:stopId/lines", (c) => {
        const stopId = (c.req.param("stopId") ?? "").trim();
        if (!stopId) return c.json({ error: "stopId is required" }, 400);
        const lines = listSeptaBusLinesForStop(stopId).map((line) => line.id);
        return c.json({ stopId, lines });
    });

    // SEPTA rail routes (GTFS static)
    app.get("/providers/philly/routes/rail", (c) => {
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);
        const routes = listSeptaRailRoutes(q, limit);
        return c.json({ count: routes.length, routes });
    });

    // SEPTA train routes alias (same as rail)
    app.get("/providers/philly/routes/train", (c) => {
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);
        const routes = listSeptaRailRoutes(q, limit);
        return c.json({ count: routes.length, routes });
    });

    // SEPTA bus/trolley routes (GTFS static)
    app.get("/providers/philly/routes/bus", (c) => {
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limit = parseLimit(c.req.query("limit"), 300, 1000);
        const routes = listSeptaBusRoutes(q, limit);
        return c.json({ count: routes.length, routes });
    });

    // SEPTA debug: raw Arrivals API payload for frontend inspection
    app.get("/providers/philly/debug/arrivals", async (c) => {
        const stationInput = (c.req.query("station") ?? c.req.query("stop") ?? "").trim();
        if (!stationInput) {
            return c.json({ error: "station (or stop) is required" }, 400);
        }

        const station = resolveSeptaRailStopName(stationInput) ?? stationInput;
        const directionRaw = (c.req.query("direction") ?? "").trim().toUpperCase();
        const direction = directionRaw === "N" || directionRaw === "S" ? directionRaw : "";
        const results = parseLimit(c.req.query("results"), 30, 100);

        const search = new URLSearchParams({
            station,
            results: String(results),
        });
        if (direction) search.set("direction", direction);

        const url = `https://www3.septa.org/api/Arrivals/index.php?${search.toString()}`;
        const res = await fetch(url);
        if (!res.ok) {
            return c.json({ error: `SEPTA Arrivals error ${res.status} ${res.statusText}`, url }, 502);
        }

        const raw = await res.json();
        return c.json({
            requestedAt: new Date().toISOString(),
            stationInput,
            stationResolved: station,
            direction: direction || null,
            url,
            raw,
        });
    });
}
