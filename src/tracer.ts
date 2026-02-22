import tracer from "dd-trace";
tracer.init(); // initialized in a different file to avoid hoisting.

import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";

export const ddTraceMiddleware = createMiddleware(async (c, next) => {
    const span = tracer.startSpan("http.request", {
        tags: {
            "span.type": "web",
            "http.method": c.req.method,
            "http.url": c.req.path,
            "span.kind": "server",
            component: "hono",
            "service.name": process.env.DD_SERVICE ?? "commutelive-api",
        },
    });

    try {
        await tracer.scope().activate(span, () => next());

        const route = routePath(c);
        span.setTag("resource.name", `${c.req.method} ${route}`);
        span.setTag("http.route", route);
        span.setTag("http.status_code", c.res.status);
        if (c.res.status >= 500) {
            span.setTag("error", true);
        }
    } catch (err) {
        span.setTag("error", true);
        if (err instanceof Error) {
            span.setTag("error.message", err.message);
            span.setTag("error.stack", err.stack ?? "");
        }
        throw err;
    } finally {
        span.finish();
    }
});

export default tracer;
