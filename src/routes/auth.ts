import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { dependency } from "../types/dependency.d.ts";
import { devices, users, userDevices } from "../db/schema/schema.ts";
import { REFRESH_COOKIE_NAME } from "../auth/config.ts";
import { clearAuthCookies, setAuthCookies } from "../auth/cookies.ts";
import {
    buildUserProfile,
    loginAndIssueTokens,
    refreshAndRotateTokens,
    revokeSessionByRefreshToken,
} from "../auth/service.ts";
import { authRequired, getAuthContext } from "../middleware/auth.ts";

const hashPassword = (password: string) =>
    createHash("sha256").update(password).digest("hex");

const parseCredentials = async (c: Context) => {
    const body = await c.req.json().catch(() => null);
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    return { email, password };
};

export function registerAuth(app: Hono, deps: dependency) {
    // Register a device (client supplies the device id string)
    app.post("/device/register", async (c) => {
        const body = await c.req.json().catch(() => null);
        const id = body?.id;
        if (!id || typeof id !== "string") {
            return c.json({ error: "id is required (string)" }, 400);
        }

        const timezone =
            typeof body?.timezone === "string" ? body.timezone : "UTC";
        try {
            const [row] = await deps.db
                .insert(devices)
                .values({ id, timezone })
                .returning();
            return c.json({ device: row }, 201);
        } catch (err) {
            return c.json(
                {
                    error: "Device create failed (maybe duplicate id)",
                    detail: `${err}`,
                },
                409,
            );
        }
    });

    // Register a user account (no device linkage here)
    app.post("/user/register", async (c) => {
        const body = await c.req.json().catch(() => null);
        const { email, password } = body ?? {};

        if (!email || !password) {
            return c.json({ error: "email and password are required" }, 400);
        }

        const existingEmail = await deps.db
            .select()
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
        if (existingEmail.length)
            return c.json({ error: "email already registered" }, 409);

        const passwordHash = hashPassword(password);
        try {
            const [user] = await deps.db
                .insert(users)
                .values({ email, passwordHash })
                .returning();
            return c.json({ user, devices: [] }, 201);
        } catch (err) {
            return c.json(
                { error: "User create failed", detail: `${err}` },
                500,
            );
        }
    });

    // Link an existing device to a user
    app.post("/user/device/link", authRequired, async (c) => {
        const auth = getAuthContext(c);
        const body = await c.req.json().catch(() => null);
        const { userId, deviceId } = body ?? {};

        if (!deviceId) {
            return c.json({ error: "deviceId is required" }, 400);
        }

        if (userId && userId !== auth.userId) {
            return c.json({ error: "FORBIDDEN" }, 403);
        }

        const [user] = await deps.db
            .select()
            .from(users)
            .where(eq(users.id, auth.userId))
            .limit(1);
        if (!user) return c.json({ error: "user not found" }, 404);

        const [device] = await deps.db
            .select()
            .from(devices)
            .where(eq(devices.id, deviceId))
            .limit(1);
        if (!device) return c.json({ error: "device not found" }, 404);

        const [taken] = await deps.db
            .select()
            .from(userDevices)
            .where(eq(userDevices.deviceId, deviceId))
            .limit(1);
        if (taken)
            return c.json(
                { error: "device already linked to another user" },
                409,
            );

        try {
            const [link] = await deps.db
                .insert(userDevices)
                .values({ userId: auth.userId, deviceId })
                .returning();
            return c.json({ link }, 201);
        } catch (err) {
            return c.json(
                { error: "Link create failed", detail: `${err}` },
                500,
            );
        }
    });

    const handleLogin = async (c: Context) => {
        const { email, password } = await parseCredentials(c);
        if (!email || !password) {
            return c.json({ error: "email and password are required" }, 400);
        }

        const result = await loginAndIssueTokens(deps, { email, password });
        if (!result.ok) {
            return c.json({ error: "INVALID_CREDENTIALS" }, 401);
        }

        setAuthCookies(c, {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
        });

        return c.json({ user: result.user }, 200);
    };

    app.post("/auth/login", handleLogin);

    // Backward-compatible alias
    app.post("/user/login", handleLogin);

    app.post("/auth/refresh", async (c) => {
        const refreshToken = getCookie(c, REFRESH_COOKIE_NAME);
        if (!refreshToken) {
            clearAuthCookies(c);
            return c.json({ error: "REFRESH_INVALID" }, 401);
        }

        const result = await refreshAndRotateTokens(deps, refreshToken);
        if (!result.ok) {
            clearAuthCookies(c);
            return c.json({ error: result.code }, 401);
        }

        setAuthCookies(c, {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
        });

        return c.json({ status: "ok" }, 200);
    });

    app.post("/auth/logout", async (c) => {
        const refreshToken = getCookie(c, REFRESH_COOKIE_NAME);
        if (refreshToken) {
            await revokeSessionByRefreshToken(deps, refreshToken);
        }

        clearAuthCookies(c);
        return c.json({ status: "ok" }, 200);
    });

    app.get("/auth/me", authRequired, async (c) => {
        const auth = getAuthContext(c);
        const user = await buildUserProfile(deps, auth.userId);
        if (!user) {
            return c.json({ error: "UNAUTHORIZED" }, 401);
        }
        return c.json({ user }, 200);
    });
}
