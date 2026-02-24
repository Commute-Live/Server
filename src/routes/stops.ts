import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";
import { listLinesForStop, listStops, listStopsForLine, resolveStopName } from "../gtfs/stops_lookup.ts";
import { listCtaSubwayLines, listCtaSubwayLinesForStop, listCtaSubwayStops } from "../gtfs/cta_subway_lookup.ts";
import { listMtaBusRoutes, listMtaBusStopsForRoute } from "../providers/new-york/bus_stops.ts";
import { buildKey, providerRegistry } from "../providers/index.ts";
import {
    getStop,
    listLinesForStop as listSeptaLinesForStop,
    listRoutes as listSeptaRoutes,
    listStops as listSeptaStops,
    normalizeDirection,
    normalizeRouteId,
    normalizeSeptaMode,
    type SeptaMode,
} from "../septa/catalog.ts";

export function registerStops(app: Hono, deps: dependency) {
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

    const resolvePhillyModeParam = (raw: string): SeptaMode | null => {
        const mode = normalizeSeptaMode(raw);
        return mode;
    };

    const registerPhillyRoutes = (path: string, modeRaw: string) => {
        app.get(path, async (c) => {
            const mode = resolvePhillyModeParam(modeRaw);
            if (!mode) return c.json({ error: "Invalid mode" }, 400);
            const q = (c.req.query("q") ?? "").trim();
            const limit = parseLimit(c.req.query("limit"), 300, 1000);
            const routes = await listSeptaRoutes(deps.db, mode, q, limit);
            return c.json({ count: routes.length, routes });
        });
    };

    const registerPhillyStops = (path: string, modeRaw: string) => {
        app.get(path, async (c) => {
            const mode = resolvePhillyModeParam(modeRaw);
            if (!mode) return c.json({ error: "Invalid mode" }, 400);
            const route = (c.req.query("route") ?? "").trim();
            const q = (c.req.query("q") ?? "").trim();
            const limit = parseLimit(c.req.query("limit"), 300, 1000);
            const stops = await listSeptaStops(deps.db, mode, {
                routeId: route || undefined,
                q,
                limit,
            });
            const mapped = stops.map((s) => ({ id: s.stopId, name: s.stop, stopId: s.stopId, stop: s.stop }));
            return c.json({ count: mapped.length, stops: mapped });
        });
    };

    const registerPhillyLinesForStop = (path: string, modeRaw: string) => {
        app.get(path, async (c) => {
            const mode = resolvePhillyModeParam(modeRaw);
            if (!mode) return c.json({ error: "Invalid mode" }, 400);
            const stopId = (c.req.param("stopId") ?? "").trim();
            if (!stopId) return c.json({ error: "stopId is required" }, 400);
            const direction = normalizeDirection(mode, c.req.query("direction"));
            const lines = await listSeptaLinesForStop(
                deps.db,
                mode,
                stopId,
                direction || undefined,
            );
            return c.json({
                stopId,
                direction: direction || null,
                lines,
            });
        });
    };

    registerPhillyStops("/providers/philly/stops/rail", "rail");
    registerPhillyStops("/providers/philly/stops/train", "rail");
    registerPhillyStops("/providers/philly/stops/bus", "bus");
    registerPhillyStops("/providers/philly/stops/trolley", "trolley");

    registerPhillyLinesForStop("/providers/philly/stops/rail/:stopId/lines", "rail");
    registerPhillyLinesForStop("/providers/philly/stops/train/:stopId/lines", "rail");
    registerPhillyLinesForStop("/providers/philly/stops/bus/:stopId/lines", "bus");
    registerPhillyLinesForStop("/providers/philly/stops/trolley/:stopId/lines", "trolley");

    registerPhillyRoutes("/providers/philly/routes/rail", "rail");
    registerPhillyRoutes("/providers/philly/routes/train", "rail");
    registerPhillyRoutes("/providers/philly/routes/bus", "bus");
    registerPhillyRoutes("/providers/philly/routes/trolley", "trolley");

    app.get("/providers/philly/arrivals", async (c) => {
        const mode = resolvePhillyModeParam(c.req.query("mode") ?? "");
        if (!mode) return c.json({ error: "mode is required (rail|bus|trolley)" }, 400);
        const lineRaw = (c.req.query("line") ?? "").trim();
        const stopId = (c.req.query("stopId") ?? "").trim();
        const direction = normalizeDirection(mode, c.req.query("direction"));
        const limit = parseLimit(c.req.query("limit"), 3, 10);
        if (!lineRaw || !stopId) return c.json({ error: "line and stopId are required" }, 400);
        if (!direction) return c.json({ error: "direction is required" }, 400);

        const line = normalizeRouteId(mode, lineRaw);
        const providerId =
            mode === "rail"
                ? "septa-rail"
                : mode === "trolley"
                  ? "septa-trolley"
                  : "septa-bus";
        const provider = providerRegistry.get(providerId);
        if (!provider) return c.json({ error: "provider not available" }, 500);

        let stopParam = stopId;
        if (mode === "rail") {
            const stop = await getStop(deps.db, mode, stopId);
            if (!stop) return c.json({ error: "Stop not found" }, 404);
            stopParam = stop.name;
        }

        const key = buildKey(providerId, "arrivals", {
            line,
            stop: stopParam,
            direction,
        });

        try {
            const result = await provider.fetch(key, {
                now: Date.now(),
                key,
                log: () => undefined,
            });
            const payload =
                result.payload && typeof result.payload === "object"
                    ? (result.payload as Record<string, unknown>)
                    : {};
            const arrivals = Array.isArray(payload.arrivals)
                ? payload.arrivals.slice(0, limit)
                : [];
            const message =
                arrivals.length === 0
                    ? mode === "rail"
                      ? "No upcoming trains for this line at this station right now."
                      : "No upcoming arrivals for this line at this stop right now."
                    : null;
            return c.json({
                mode,
                provider: providerId,
                line,
                stopId,
                direction,
                arrivals,
                message,
                raw: payload,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to fetch arrivals";
            return c.json({ error: message }, 502);
        }
    });
}
