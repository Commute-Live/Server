import type { MiddlewareHandler } from "hono";

const HEADER = "X-Loadtest-Key";

export const loadtestGuard: MiddlewareHandler = async (c, next) => {
    const expectedKey = process.env.LOADTEST_SECRET_KEY;

    // Env var not set → guard is a no-op; don't break production
    if (!expectedKey) {
        return next();
    }

    const incomingKey = c.req.header(HEADER);

    // No header → normal request, let it through unchanged
    if (incomingKey === undefined) {
        return next();
    }

    // Header present but wrong → reject immediately
    if (incomingKey !== expectedKey) {
        return c.json({ error: "FORBIDDEN" }, 403);
    }

    // Header present and correct → mark as load-test traffic and continue
    c.set("loadtest", true);
    return next();
};
