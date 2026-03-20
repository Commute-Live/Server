import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq, isNull } from "drizzle-orm";

import type { dependency } from "../types/dependency.d.ts";
import {
    authRefreshSessions,
    devices,
    passwordResetTokens,
    users,
    userDevices,
} from "../db/schema/schema.ts";
import { REFRESH_COOKIE_NAME } from "../auth/config.ts";
import { clearAuthCookies, setAuthCookies } from "../auth/cookies.ts";
import {
    normalizeEmail,
    validatePasswordStrength,
    hashPassword,
} from "../auth/password.ts";
import {
    PASSWORD_RESET_GENERIC_MESSAGE,
    createPasswordResetRecord,
    createPasswordResetToken,
    deletePasswordResetRecordByHash,
    getPasswordResetRecordByRawToken,
    isWellFormedPasswordResetToken,
} from "../auth/passwordReset.ts";
import {
    buildUserProfile,
    loginAndIssueTokens,
    refreshAndRotateTokens,
    revokeSessionByRefreshToken,
} from "../auth/service.ts";
import { authRequired, getAuthContext } from "../middleware/auth.ts";
import { loadtestGuard } from "../middleware/loadtest.ts";
import { logger } from "../logger.ts";
import { sendPasswordResetEmail } from "../email/service.ts";
import { trustedBrowserOriginRequired } from "../security/origin.ts";
import { getClientIp } from "../security/request.ts";
import { enforceRateLimit } from "../security/rateLimit.ts";

const parseCredentials = async (c: Context) => {
    const body = await c.req.json().catch(() => null);
    const email =
        typeof body?.email === "string" ? normalizeEmail(body.email) : "";
    const password = typeof body?.password === "string" ? body.password : "";
    return { email, password };
};

export function registerAuth(app: Hono, deps: dependency) {
    const requireAuth = authRequired(deps);

    // Register a device (client supplies the device id string)
    app.post("/device/register", loadtestGuard, async (c) => {
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
    app.post("/user/register", loadtestGuard, trustedBrowserOriginRequired, async (c) => {
        const body = await c.req.json().catch(() => null);
        const email =
            typeof body?.email === "string" ? normalizeEmail(body.email) : "";
        const password = typeof body?.password === "string" ? body.password : "";

        if (!email || !password) {
            return c.json({ error: "email and password are required" }, 400);
        }

        const passwordErrors = validatePasswordStrength(password);
        if (passwordErrors.length) {
            return c.json({ error: "WEAK_PASSWORD", details: passwordErrors }, 400);
        }

        const existingEmail = await deps.db
            .select()
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
        if (existingEmail.length)
            return c.json({ error: "email already registered" }, 409);

        const passwordHash = await hashPassword(password);
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
    app.post("/user/device/link", loadtestGuard, requireAuth, async (c) => {
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

    app.post("/auth/login", loadtestGuard, trustedBrowserOriginRequired, handleLogin);

    // Backward-compatible alias
    app.post("/user/login", loadtestGuard, trustedBrowserOriginRequired, handleLogin);

    app.post("/auth/refresh", trustedBrowserOriginRequired, async (c) => {
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

    app.post("/auth/logout", trustedBrowserOriginRequired, async (c) => {
        const refreshToken = getCookie(c, REFRESH_COOKIE_NAME);
        if (refreshToken) {
            await revokeSessionByRefreshToken(deps, refreshToken);
        }

        clearAuthCookies(c);
        return c.json({ status: "ok" }, 200);
    });

    app.post("/auth/forgot-password", trustedBrowserOriginRequired, async (c) => {
        const body = await c.req.json().catch(() => null);
        const email =
            typeof body?.email === "string" ? normalizeEmail(body.email) : "";
        const ip = getClientIp(c) ?? "unknown";

        if (!email) {
            return c.json({ error: "email is required" }, 400);
        }

        const [ipLimit, emailLimit] = await Promise.all([
            enforceRateLimit({
                key: `forgot-password:ip:${ip}`,
                limit: 5,
                windowSeconds: 15 * 60,
            }),
            enforceRateLimit({
                key: `forgot-password:email:${email}`,
                limit: 3,
                windowSeconds: 15 * 60,
            }),
        ]);

        if (!ipLimit.allowed || !emailLimit.allowed) {
            logger.warn({ event: "auth.password_reset.rate_limited", ip, email }, "password reset request throttled");
            return c.json({ error: "RATE_LIMITED" }, 429, {
                "Retry-After": String(
                    Math.max(ipLimit.retryAfterSeconds, emailLimit.retryAfterSeconds),
                ),
            });
        }

        const [user] = await deps.db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);

        logger.info({ event: "auth.password_reset.requested", ip, email }, "password reset requested");

        if (!user) {
            return c.json({ message: PASSWORD_RESET_GENERIC_MESSAGE }, 200);
        }

        const resetToken = createPasswordResetToken();
        await createPasswordResetRecord(deps, {
            userId: user.id,
            tokenHash: resetToken.tokenHash,
            expiresAt: resetToken.expiresAt,
            requestedByIp: ip,
        });

        try {
            await sendPasswordResetEmail({
                to: user.email,
                rawToken: resetToken.rawToken,
            });

            logger.info(
                {
                    event: "auth.password_reset.email_sent",
                    userId: user.id,
                    email: user.email,
                    expiresAt: resetToken.expiresAt,
                },
                "password reset email sent",
            );
        } catch (err) {
            await deletePasswordResetRecordByHash(deps, resetToken.tokenHash);
            logger.error(
                {
                    event: "auth.password_reset.email_failed",
                    err,
                    userId: user.id,
                    email: user.email,
                },
                "password reset email failed",
            );
        }

        return c.json({ message: PASSWORD_RESET_GENERIC_MESSAGE }, 200);
    });

    app.get("/auth/reset-password/validate", async (c) => {
        const token = c.req.query("token")?.trim() ?? "";
        const ip = getClientIp(c) ?? "unknown";

        const ipLimit = await enforceRateLimit({
            key: `reset-password-validate:ip:${ip}`,
            limit: 30,
            windowSeconds: 15 * 60,
        });

        if (!ipLimit.allowed) {
            return c.json({ valid: false, code: "RATE_LIMITED" }, 429, {
                "Retry-After": String(ipLimit.retryAfterSeconds),
            });
        }

        if (!isWellFormedPasswordResetToken(token)) {
            return c.json({ valid: false, code: "INVALID_TOKEN" }, 400);
        }

        const record = await getPasswordResetRecordByRawToken(deps, token);
        if (!record) {
            return c.json({ valid: false, code: "INVALID_OR_EXPIRED" }, 400);
        }

        return c.json({
            valid: true,
            expiresAt: record.expiresAt,
        });
    });

    app.post("/auth/reset-password", trustedBrowserOriginRequired, async (c) => {
        const body = await c.req.json().catch(() => null);
        const token = typeof body?.token === "string" ? body.token.trim() : "";
        const password = typeof body?.password === "string" ? body.password : "";
        const confirmPassword =
            typeof body?.confirmPassword === "string" ? body.confirmPassword : "";
        const ip = getClientIp(c) ?? "unknown";

        const ipLimit = await enforceRateLimit({
            key: `reset-password:ip:${ip}`,
            limit: 10,
            windowSeconds: 15 * 60,
        });

        if (!ipLimit.allowed) {
            logger.warn({ event: "auth.password_reset.complete_rate_limited", ip }, "password reset completion throttled");
            return c.json({ error: "RATE_LIMITED" }, 429, {
                "Retry-After": String(ipLimit.retryAfterSeconds),
            });
        }

        if (!isWellFormedPasswordResetToken(token)) {
            return c.json({ error: "INVALID_TOKEN" }, 400);
        }

        if (!password || !confirmPassword) {
            return c.json(
                { error: "password and confirmPassword are required" },
                400,
            );
        }

        if (password !== confirmPassword) {
            return c.json({ error: "PASSWORD_MISMATCH" }, 400);
        }

        const passwordErrors = validatePasswordStrength(password);
        if (passwordErrors.length) {
            return c.json({ error: "WEAK_PASSWORD", details: passwordErrors }, 400);
        }

        const resetRecord = await getPasswordResetRecordByRawToken(deps, token);
        if (!resetRecord) {
            logger.warn({ event: "auth.password_reset.invalid_token", ip }, "invalid or expired password reset token");
            return c.json({ error: "INVALID_OR_EXPIRED" }, 400);
        }

        const accountLimit = await enforceRateLimit({
            key: `reset-password:user:${resetRecord.userId}`,
            limit: 5,
            windowSeconds: 15 * 60,
        });

        if (!accountLimit.allowed) {
            logger.warn(
                { event: "auth.password_reset.complete_user_rate_limited", ip, userId: resetRecord.userId },
                "password reset completion throttled for user",
            );
            return c.json({ error: "RATE_LIMITED" }, 429, {
                "Retry-After": String(accountLimit.retryAfterSeconds),
            });
        }

        const now = new Date().toISOString();

        const consumed = await deps.db.transaction(async (tx) => {
            const [usedToken] = await tx
                .update(passwordResetTokens)
                .set({
                    usedAt: now,
                    usedByIp: ip,
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(passwordResetTokens.id, resetRecord.id),
                        isNull(passwordResetTokens.usedAt),
                        isNull(passwordResetTokens.invalidatedAt),
                    ),
                )
                .returning({ userId: passwordResetTokens.userId });

            if (!usedToken) {
                return false;
            }

            const nextPasswordHash = await hashPassword(password);
            await tx
                .update(users)
                .set({
                    passwordHash: nextPasswordHash,
                    updatedAt: now,
                })
                .where(eq(users.id, resetRecord.userId));

            await tx
                .update(passwordResetTokens)
                .set({
                    invalidatedAt: now,
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(passwordResetTokens.userId, resetRecord.userId),
                        isNull(passwordResetTokens.usedAt),
                        isNull(passwordResetTokens.invalidatedAt),
                    ),
                );

            await tx
                .update(authRefreshSessions)
                .set({
                    revokedAt: now,
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(authRefreshSessions.userId, resetRecord.userId),
                        isNull(authRefreshSessions.revokedAt),
                    ),
                );

            return true;
        });

        if (!consumed) {
            return c.json({ error: "INVALID_OR_EXPIRED" }, 400);
        }

        clearAuthCookies(c);

        logger.info(
            {
                event: "auth.password_reset.completed",
                userId: resetRecord.userId,
                ip,
            },
            "password reset completed",
        );

        return c.json({ status: "ok" }, 200);
    });

    app.get("/auth/me", requireAuth, async (c) => {
        const auth = getAuthContext(c);
        const user = await buildUserProfile(deps, auth.userId);
        if (!user) {
            return c.json({ error: "UNAUTHORIZED" }, 401);
        }
        return c.json({ user }, 200);
    });
}
