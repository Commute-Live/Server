import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";
import { listLinesForStop, listStops, resolveStopName } from "../gtfs/stops_lookup.ts";

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

}
