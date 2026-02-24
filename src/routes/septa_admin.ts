import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";
import { latestSeptaSyncStatus, runSeptaSync } from "../septa/sync.ts";
import { runSeptaGtfsImport } from "../septa/gtfs_import.ts";

const requireSyncToken = (headerToken?: string | null) => {
    const configured = process.env.SEPTA_SYNC_TOKEN ?? "";
    if (!configured) return { ok: false as const, code: 500 as const, error: "SEPTA_SYNC_TOKEN not configured" };
    if (!headerToken || headerToken.trim() !== configured) {
        return { ok: false as const, code: 401 as const, error: "UNAUTHORIZED" };
    }
    return { ok: true as const };
};

export function registerSeptaAdmin(app: Hono, deps: dependency) {
    app.get("/admin/septa/sync/status", async (c) => {
        const auth = requireSyncToken(c.req.header("x-septa-sync-token"));
        if (!auth.ok) return c.json({ error: auth.error }, auth.code);
        const latest = await latestSeptaSyncStatus(deps.db);
        return c.json({ latest });
    });

    app.post("/admin/septa/sync", async (c) => {
        const auth = requireSyncToken(c.req.header("x-septa-sync-token"));
        if (!auth.ok) return c.json({ error: auth.error }, auth.code);
        try {
            const result = await runSeptaSync(deps.db);
            return c.json({
                status: result.status,
                runId: result.runId,
                stats: result.stats,
                errorsCount:
                    typeof (result.stats as Record<string, unknown>).errors === "number"
                        ? Number((result.stats as Record<string, unknown>).errors)
                        : 0,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : "SEPTA sync failed";
            return c.json({ error: message }, 502);
        }
    });

    app.post("/admin/septa/import", async (c) => {
        const auth = requireSyncToken(c.req.header("x-septa-sync-token"));
        if (!auth.ok) return c.json({ error: auth.error }, auth.code);
        try {
            const body = await c.req.json().catch(() => null);
            const sourceUrl = typeof body?.sourceUrl === "string" ? body.sourceUrl : undefined;
            const result = await runSeptaGtfsImport(deps.db, sourceUrl);
            return c.json({
                status: result.status,
                runId: result.runId,
                stats: result.stats,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : "SEPTA GTFS import failed";
            const causeMessage =
                err && typeof err === "object" && "cause" in err && err.cause instanceof Error
                    ? err.cause.message
                    : undefined;
            return c.json(
                {
                    error: message,
                    details: causeMessage ? causeMessage.slice(0, 500) : undefined,
                },
                502,
            );
        }
    });
}
