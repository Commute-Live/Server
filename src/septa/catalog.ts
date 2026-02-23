import { and, asc, eq, ilike, or } from "drizzle-orm";
import { septaRouteStops, septaRoutes, septaStops, type SeptaMode } from "../db/schema/schema.ts";

export type { SeptaMode } from "../db/schema/schema.ts";

type DbLike = {
    select: Function;
};

export type SeptaRouteRow = {
    id: string;
    label: string;
};

export type SeptaStopRow = {
    stopId: string;
    stop: string;
};

export const normalizeSeptaMode = (value: string): SeptaMode | null => {
    const v = value.trim().toLowerCase();
    if (v === "rail" || v === "train") return "rail";
    if (v === "bus") return "bus";
    if (v === "trolley") return "trolley";
    return null;
};

export const providerToMode = (provider: string): SeptaMode | null => {
    const p = provider.trim().toLowerCase();
    if (p === "septa-rail") return "rail";
    if (p === "septa-bus") return "bus";
    if (p === "septa-trolley") return "trolley";
    return null;
};

export const normalizeRouteId = (mode: SeptaMode, value: string): string => {
    const raw = value.trim().toUpperCase();
    if (!raw) return "";
    if (mode === "rail") {
        return raw.replace(/\s+LINE$/i, "").replace(/\s+/g, " ");
    }
    return raw.replace(/\s+/g, " ");
};

export const normalizeDirection = (mode: SeptaMode, value?: string | null): string => {
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

export async function listRoutes(
    db: DbLike,
    mode: SeptaMode,
    q: string,
    limit: number,
): Promise<SeptaRouteRow[]> {
    const needle = q.trim();
    const baseWhere = and(eq(septaRoutes.mode, mode), eq(septaRoutes.active, true));
    const where = needle
        ? and(
              baseWhere,
              or(
                  ilike(septaRoutes.id, `%${needle}%`),
                  ilike(septaRoutes.displayName, `%${needle}%`),
                  ilike(septaRoutes.shortName, `%${needle}%`),
                  ilike(septaRoutes.longName, `%${needle}%`),
              ),
          )
        : baseWhere;
    const rows = await db
        .select({
            id: septaRoutes.id,
            label: septaRoutes.displayName,
        })
        .from(septaRoutes)
        .where(where)
        .orderBy(asc(septaRoutes.id))
        .limit(limit);
    return rows.map((r: { id: string; label: string }) => ({
        id: r.id,
        label: (r.label || r.id).trim(),
    }));
}

export async function listStops(
    db: DbLike,
    mode: SeptaMode,
    opts: { routeId?: string; q?: string; limit: number },
): Promise<SeptaStopRow[]> {
    const routeId = normalizeRouteId(mode, opts.routeId ?? "");
    const q = (opts.q ?? "").trim();
    const limit = Math.max(1, opts.limit);

    if (routeId) {
        const where = and(
            eq(septaRouteStops.mode, mode),
            eq(septaRouteStops.routeId, routeId),
            eq(septaRouteStops.active, true),
            eq(septaStops.mode, mode),
            eq(septaStops.active, true),
            q
                ? or(
                      ilike(septaStops.id, `%${q}%`),
                      ilike(septaStops.name, `%${q}%`),
                  )
                : undefined,
        );
        const rows = await db
            .select({
                stopId: septaStops.id,
                stop: septaStops.name,
            })
            .from(septaRouteStops)
            .innerJoin(
                septaStops,
                and(
                    eq(septaStops.mode, septaRouteStops.mode),
                    eq(septaStops.id, septaRouteStops.stopId),
                ),
            )
            .where(where)
            .orderBy(asc(septaStops.name))
            .limit(limit);
        return dedupeStops(rows);
    }

    const where = and(
        eq(septaStops.mode, mode),
        eq(septaStops.active, true),
        q
            ? or(
                  ilike(septaStops.id, `%${q}%`),
                  ilike(septaStops.name, `%${q}%`),
              )
            : undefined,
    );
    const rows = await db
        .select({
            stopId: septaStops.id,
            stop: septaStops.name,
        })
        .from(septaStops)
        .where(where)
        .orderBy(asc(septaStops.name))
        .limit(limit);
    return dedupeStops(rows);
}

export async function listLinesForStop(
    db: DbLike,
    mode: SeptaMode,
    stopId: string,
    direction?: string,
): Promise<string[]> {
    const normalizedStopId = stopId.trim();
    const normalizedDirection = normalizeDirection(mode, direction);
    if (!normalizedStopId) return [];

    const where = and(
        eq(septaRouteStops.mode, mode),
        eq(septaRouteStops.stopId, normalizedStopId),
        eq(septaRouteStops.active, true),
        normalizedDirection ? eq(septaRouteStops.direction, normalizedDirection) : undefined,
    );
    const rows = await db
        .select({ routeId: septaRouteStops.routeId })
        .from(septaRouteStops)
        .where(where)
        .orderBy(asc(septaRouteStops.routeId))
        .limit(3000);
    return Array.from(new Set(rows.map((r: { routeId: string }) => r.routeId)));
}

export async function resolveRoute(
    db: DbLike,
    mode: SeptaMode,
    routeInput: string,
): Promise<{ id: string; label: string } | null> {
    const normalized = normalizeRouteId(mode, routeInput);
    if (!normalized) return null;
    const [exact] = await db
        .select({
            id: septaRoutes.id,
            label: septaRoutes.displayName,
        })
        .from(septaRoutes)
        .where(and(eq(septaRoutes.mode, mode), eq(septaRoutes.id, normalized), eq(septaRoutes.active, true)))
        .limit(1);
    if (exact) return { id: exact.id, label: exact.label || exact.id };

    const [fuzzy] = await db
        .select({
            id: septaRoutes.id,
            label: septaRoutes.displayName,
        })
        .from(septaRoutes)
        .where(
            and(
                eq(septaRoutes.mode, mode),
                eq(septaRoutes.active, true),
                or(
                    ilike(septaRoutes.displayName, `%${routeInput.trim()}%`),
                    ilike(septaRoutes.shortName, `%${routeInput.trim()}%`),
                    ilike(septaRoutes.longName, `%${routeInput.trim()}%`),
                ),
            ),
        )
        .orderBy(asc(septaRoutes.id))
        .limit(1);
    if (!fuzzy) return null;
    return { id: fuzzy.id, label: fuzzy.label || fuzzy.id };
}

export async function resolveStopForRoute(
    db: DbLike,
    mode: SeptaMode,
    routeId: string,
    stopInput: string,
): Promise<{ id: string; name: string } | null> {
    const normalizedRouteId = normalizeRouteId(mode, routeId);
    const needle = stopInput.trim();
    if (!normalizedRouteId || !needle) return null;

    const [idMatch] = await db
        .select({
            id: septaStops.id,
            name: septaStops.name,
        })
        .from(septaRouteStops)
        .innerJoin(
            septaStops,
            and(
                eq(septaStops.mode, septaRouteStops.mode),
                eq(septaStops.id, septaRouteStops.stopId),
            ),
        )
        .where(
            and(
                eq(septaRouteStops.mode, mode),
                eq(septaRouteStops.routeId, normalizedRouteId),
                eq(septaRouteStops.active, true),
                eq(septaStops.active, true),
                eq(septaStops.id, needle),
            ),
        )
        .limit(1);
    if (idMatch) return { id: idMatch.id, name: idMatch.name };

    const [nameMatch] = await db
        .select({
            id: septaStops.id,
            name: septaStops.name,
        })
        .from(septaRouteStops)
        .innerJoin(
            septaStops,
            and(
                eq(septaStops.mode, septaRouteStops.mode),
                eq(septaStops.id, septaRouteStops.stopId),
            ),
        )
        .where(
            and(
                eq(septaRouteStops.mode, mode),
                eq(septaRouteStops.routeId, normalizedRouteId),
                eq(septaRouteStops.active, true),
                eq(septaStops.active, true),
                ilike(septaStops.name, needle),
            ),
        )
        .limit(1);
    if (!nameMatch) return null;
    return { id: nameMatch.id, name: nameMatch.name };
}

export async function getStop(
    db: DbLike,
    mode: SeptaMode,
    stopId: string,
): Promise<{ id: string; name: string } | null> {
    const [row] = await db
        .select({ id: septaStops.id, name: septaStops.name })
        .from(septaStops)
        .where(and(eq(septaStops.mode, mode), eq(septaStops.id, stopId), eq(septaStops.active, true)))
        .limit(1);
    if (!row) return null;
    return { id: row.id, name: row.name };
}

function dedupeStops(rows: Array<{ stopId: string; stop: string }>): SeptaStopRow[] {
    const out = new Map<string, SeptaStopRow>();
    for (const row of rows) {
        if (!row.stopId) continue;
        if (!out.has(row.stopId)) {
            out.set(row.stopId, { stopId: row.stopId, stop: row.stop || row.stopId });
        }
    }
    return Array.from(out.values());
}
