import type { MiddlewareHandler } from "hono";

const DEFAULT_ORIGINS = "http://localhost:8081,http://127.0.0.1:8081";

export const allowedOrigins = (
    process.env.CORS_ORIGINS ?? DEFAULT_ORIGINS
)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

export const trustedBrowserOriginRequired: MiddlewareHandler = async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
        await next();
        return;
    }

    const origin = c.req.header("origin");
    if (origin && !allowedOrigins.includes(origin)) {
        return c.json({ error: "CSRF_ORIGIN_DENIED" }, 403);
    }

    await next();
};
