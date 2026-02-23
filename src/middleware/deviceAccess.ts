import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";

import { userDevices } from "../db/schema/schema.ts";
import type { dependency } from "../types/dependency.d.ts";
import { getAuthContext } from "./auth.ts";

export const requireDeviceAccess = (deps: dependency, paramName: string): MiddlewareHandler => {
    return async (c, next) => {
        if (c.get("loadtest") === true) {
            return next();
        }

        const auth = getAuthContext(c);
        const deviceId = c.req.param(paramName);
        if (!deviceId) {
            return c.json({ error: "deviceId is required" }, 400);
        }

        const [link] = await deps.db
            .select({ userId: userDevices.userId })
            .from(userDevices)
            .where(eq(userDevices.deviceId, deviceId))
            .limit(1);

        if (!link || link.userId !== auth.userId) {
            return c.json({ error: "FORBIDDEN" }, 403);
        }

        await next();
    };
};
