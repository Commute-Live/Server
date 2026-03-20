import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import type { dependency } from "../types/dependency.d.ts";
import { ACCESS_COOKIE_NAME } from "../auth/config.ts";
import { isSessionActive } from "../auth/service.ts";
import { isExpiredJwtError, verifyAccessToken } from "../auth/tokens.ts";

export type AuthContext = {
    userId: string;
    sessionId: string;
    email?: string;
};

export const authRequired = (deps: dependency): MiddlewareHandler => {
    const middleware: MiddlewareHandler = async (c, next) => {
        const token = getCookie(c, ACCESS_COOKIE_NAME);
        if (!token) {
            return c.json({ error: "UNAUTHORIZED" }, 401);
        }

        try {
            const claims = await verifyAccessToken(token);
            const sessionActive = await isSessionActive(deps, {
                userId: claims.sub,
                sessionId: claims.sid,
            });

            if (!sessionActive) {
                return c.json({ error: "SESSION_REVOKED" }, 401);
            }

            c.set("auth", {
                userId: claims.sub,
                sessionId: claims.sid,
                email: claims.email,
            } satisfies AuthContext);
            await next();
        } catch (err) {
            if (isExpiredJwtError(err)) {
                return c.json({ error: "ACCESS_EXPIRED" }, 401);
            }
            return c.json({ error: "UNAUTHORIZED" }, 401);
        }
    };

    return middleware;
};

export const getAuthContext = (c: Context): AuthContext => {
    return c.get("auth") as AuthContext;
};
