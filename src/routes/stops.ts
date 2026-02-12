import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";
import { listStops } from "../gtfs/stops_lookup.ts";

export function registerStops(app: Hono, _deps: dependency) {
    app.get("/stops", (c) => {
        const q = (c.req.query("q") ?? "").trim().toLowerCase();
        const limitRaw = Number(c.req.query("limit") ?? "300");
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 300;

        let stops = listStops();
        if (q.length > 0) {
            stops = stops.filter((s) => s.stop.toLowerCase().includes(q) || s.stopId.toLowerCase().includes(q));
        }

        return c.json({ count: stops.length, stops: stops.slice(0, limit) });
    });
}

