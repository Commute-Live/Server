import { and, eq, isNull } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

import type { dependency } from "../types/dependency.d.ts";
import {
    authRefreshSessions,
    userDevices,
    users,
} from "../db/schema/schema.ts";
import { authConfig } from "./config.ts";
import {
    signAccessToken,
    signRefreshToken,
    verifyRefreshToken,
} from "./tokens.ts";

const hashPassword = (password: string) =>
    createHash("sha256").update(password).digest("hex");

const hashToken = (token: string) =>
    createHash("sha256").update(token).digest("hex");

const refreshExpiryIso = () =>
    new Date(
        Date.now() + authConfig.refreshTokenTtlSeconds * 1000,
    ).toISOString();

async function getDeviceIdsForUser(
    deps: dependency,
    userId: string,
): Promise<string[]> {
    const deviceRows = await deps.db
        .select({ deviceId: userDevices.deviceId })
        .from(userDevices)
        .where(eq(userDevices.userId, userId));

    return deviceRows.map((row) => row.deviceId);
}

export async function buildUserProfile(deps: dependency, userId: string) {
    const [user] = await deps.db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    if (!user) return null;

    const deviceIds = await getDeviceIdsForUser(deps, user.id);
    return { id: user.id, email: user.email, deviceIds };
}

export async function loginAndIssueTokens(
    deps: dependency,
    credentials: { email: string; password: string },
): Promise<
    | {
          ok: true;
          user: { id: string; email: string; deviceIds: string[] };
          accessToken: string;
          refreshToken: string;
      }
    | { ok: false }
> {
    const [user] = await deps.db
        .select()
        .from(users)
        .where(eq(users.email, credentials.email))
        .limit(1);
    if (!user) return { ok: false };

    const passwordHash = hashPassword(credentials.password);
    if (passwordHash !== user.passwordHash) return { ok: false };

    const sessionId = randomUUID();
    const familyId = randomUUID();
    const jti = randomUUID();

    const refreshToken = await signRefreshToken({
        userId: user.id,
        sessionId,
        familyId,
        jti,
    });
    const accessToken = await signAccessToken({
        userId: user.id,
        sessionId,
        email: user.email,
    });

    await deps.db.insert(authRefreshSessions).values({
        userId: user.id,
        sessionId,
        familyId,
        tokenJti: jti,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshExpiryIso(),
    });

    const deviceIds = await getDeviceIdsForUser(deps, user.id);

    return {
        ok: true,
        user: { id: user.id, email: user.email, deviceIds },
        accessToken,
        refreshToken,
    };
}

async function revokeFamily(deps: dependency, familyId: string): Promise<void> {
    const revokedAt = new Date().toISOString();
    await deps.db
        .update(authRefreshSessions)
        .set({ revokedAt, updatedAt: revokedAt })
        .where(
            and(
                eq(authRefreshSessions.familyId, familyId),
                isNull(authRefreshSessions.revokedAt),
            ),
        );
}

export async function refreshAndRotateTokens(
    deps: dependency,
    refreshToken: string,
): Promise<
    | { ok: true; accessToken: string; refreshToken: string }
    | { ok: false; code: "REFRESH_INVALID" | "REFRESH_REUSED" }
> {
    let claims;
    try {
        claims = await verifyRefreshToken(refreshToken);
    } catch {
        return { ok: false, code: "REFRESH_INVALID" };
    }

    const [existing] = await deps.db
        .select()
        .from(authRefreshSessions)
        .where(eq(authRefreshSessions.tokenJti, claims.jti))
        .limit(1);

    if (!existing) return { ok: false, code: "REFRESH_INVALID" };

    if (existing.revokedAt) return { ok: false, code: "REFRESH_INVALID" };

    if (existing.rotatedAt) {
        await revokeFamily(deps, existing.familyId);
        return { ok: false, code: "REFRESH_REUSED" };
    }

    if (
        existing.userId !== claims.sub ||
        existing.sessionId !== claims.sid ||
        existing.familyId !== claims.fam ||
        existing.tokenHash !== hashToken(refreshToken)
    ) {
        return { ok: false, code: "REFRESH_INVALID" };
    }

    if (new Date(existing.expiresAt).getTime() <= Date.now()) {
        return { ok: false, code: "REFRESH_INVALID" };
    }

    const newJti = randomUUID();
    const nextRefreshToken = await signRefreshToken({
        userId: claims.sub,
        sessionId: claims.sid,
        familyId: claims.fam,
        jti: newJti,
    });

    const nextAccessToken = await signAccessToken({
        userId: claims.sub,
        sessionId: claims.sid,
    });

    const rotationTime = new Date().toISOString();

    const rotationResult = await deps.db.transaction(async (tx) => {
        const updated = await tx
            .update(authRefreshSessions)
            .set({
                rotatedAt: rotationTime,
                replacedByJti: newJti,
                updatedAt: rotationTime,
            })
            .where(
                and(
                    eq(authRefreshSessions.tokenJti, claims.jti),
                    isNull(authRefreshSessions.rotatedAt),
                    isNull(authRefreshSessions.revokedAt),
                ),
            )
            .returning({ tokenJti: authRefreshSessions.tokenJti });

        if (!updated.length) {
            return { rotated: false as const };
        }

        await tx.insert(authRefreshSessions).values({
            userId: claims.sub,
            sessionId: claims.sid,
            familyId: claims.fam,
            tokenJti: newJti,
            tokenHash: hashToken(nextRefreshToken),
            expiresAt: refreshExpiryIso(),
        });

        return { rotated: true as const };
    });

    if (!rotationResult.rotated) {
        await revokeFamily(deps, claims.fam);
        return { ok: false, code: "REFRESH_REUSED" };
    }

    return {
        ok: true,
        accessToken: nextAccessToken,
        refreshToken: nextRefreshToken,
    };
}

export async function revokeSessionByRefreshToken(
    deps: dependency,
    refreshToken: string,
): Promise<void> {
    const tokenHash = hashToken(refreshToken);

    const [row] = await deps.db
        .select({
            userId: authRefreshSessions.userId,
            sessionId: authRefreshSessions.sessionId,
        })
        .from(authRefreshSessions)
        .where(eq(authRefreshSessions.tokenHash, tokenHash))
        .limit(1);

    if (!row) return;

    const revokedAt = new Date().toISOString();

    await deps.db
        .update(authRefreshSessions)
        .set({ revokedAt, updatedAt: revokedAt })
        .where(
            and(
                eq(authRefreshSessions.userId, row.userId),
                eq(authRefreshSessions.sessionId, row.sessionId),
                isNull(authRefreshSessions.revokedAt),
            ),
        );
}
