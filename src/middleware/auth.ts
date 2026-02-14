import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import { ACCESS_COOKIE_NAME } from "../auth/config.ts";
import { isExpiredJwtError, verifyAccessToken } from "../auth/tokens.ts";

export type AuthContext = {
    userId: string;
    sessionId: string;
    email?: string;
};

export const authRequired: MiddlewareHandler = async (c, next) => {
    const token = getCookie(c, ACCESS_COOKIE_NAME);
    if (!token) {
        return c.json({ error: "UNAUTHORIZED" }, 401);
    }

    try {
        const claims = await verifyAccessToken(token);
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

export const getAuthContext = (c: Context): AuthContext => {
    return c.get("auth") as AuthContext;
};
