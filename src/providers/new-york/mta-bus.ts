import type { FetchContext, FetchResult, ProviderPlugin } from "../../types.ts";
import { buildKey, parseKeySegments, registerProvider } from "../index.ts";

// MTA BusTime API docs: https://bustime.mta.info/wiki/Developers/Index

type SiriStopMonitoringResponse = {
    Siri?: {
        ServiceDelivery?: {
            StopMonitoringDelivery?: Array<{
                MonitoredStopVisit?: any[];
            }>;
        };
    };
};

const fetchBusArrivals = async (key: string, ctx: FetchContext): Promise<FetchResult> => {
    const { params } = parseKeySegments(key);
    const stop = params.stop;
    if (!stop) throw new Error("Bus stop (MonitoringRef) is required");

    const line = params.line || undefined;
    const direction = params.direction || undefined;
    const apiKey = process.env.MTA_BUS_API_KEY;
    if (!apiKey) {
        throw new Error("MTA BusTime API key is required (set MTA_BUS_API_KEY)");
    }

    const normalizeLineRef = (lineRef?: string) => {
        if (!lineRef) return undefined;
        // BusTime typically uses "MTA NYCT_<route>" for NYCT-operated buses and "MTABC_<route>" for Bus Co.
        if (lineRef.includes("_")) return lineRef;
        return `MTA NYCT_${lineRef.toUpperCase()}`;
    };

    const fetchVisits = async (opts: { line?: string; direction?: string }) => {
        const search = new URLSearchParams({
            key: apiKey,
            OperatorRef: "MTA",
            MonitoringRef: stop,
        });
        const lineRef = normalizeLineRef(opts.line);
        if (lineRef) search.set("LineRef", lineRef);
        if (opts.direction) search.set("DirectionRef", opts.direction);

        const url = `https://bustime.mta.info/api/siri/stop-monitoring.json?${search.toString()}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`BusTime error ${res.status} ${res.statusText}`);
        const json = (await res.json()) as SiriStopMonitoringResponse;
        return json?.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]?.MonitoredStopVisit ?? [];
    };

    const pickStopName = (visits: any[]) => {
        for (const visit of visits) {
            const name = visit?.MonitoredVehicleJourney?.MonitoredCall?.StopPointName;
            if (typeof name === "string" && name.trim()) return name.trim();
            if (Array.isArray(name) && name.length) {
                const first = name.find((v) => typeof v === "string" && v.trim());
                if (first) return first.trim();
            }
        }
        return undefined;
    };

    // First attempt with provided filters
    let visits = await fetchVisits({ line, direction });
    // Fallback: if empty and filters were applied, retry without line/direction to avoid over-filtering
    if (!visits.length && (line || direction)) {
        ctx.log?.("[BUS]", "no results with line/direction filters, retrying broad", { line, direction });
        visits = await fetchVisits({});
    }

    const stopName = pickStopName(visits);

    const arrivals = visits.slice(0, 10).map((visit: any) => {
        const mvp = visit.MonitoredVehicleJourney?.MonitoredCall ?? {};
        const aimed = mvp.AimedArrivalTime || mvp.AimedDepartureTime || null;
        const expected = mvp.ExpectedArrivalTime || mvp.ExpectedDepartureTime || aimed;
        const expectedMs = expected ? Date.parse(expected) : null;
        const aimedMs = aimed ? Date.parse(aimed) : null;
        const delaySeconds =
            expectedMs !== null && aimedMs !== null ? Math.round((expectedMs - aimedMs) / 1000) : null;

        return {
            arrivalTime: expected ?? null,
            scheduledTime: aimed ?? null,
            delaySeconds,
        };
    });

    return {
        payload: {
            provider: "mta-bus",
            stop,
            line,
            direction,
            stopName,
            arrivals,
            fetchedAt: new Date(ctx.now).toISOString(),
        },
        ttlSeconds: 20,
    };
};

export const mtaBusProvider: ProviderPlugin = {
    providerId: "mta-bus",
    supports: (type: string) => type === "arrivals",
    toKey: ({ type, config }) => buildKey("mta-bus", type, config),
    parseKey: (key: string) => parseKeySegments(key),
    fetch: (key: string, ctx: FetchContext) => fetchBusArrivals(key, ctx),
};

registerProvider(mtaBusProvider);
