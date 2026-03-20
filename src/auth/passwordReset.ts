import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";

import type { dependency } from "../types/dependency.d.ts";
import { passwordResetTokens, users } from "../db/schema/schema.ts";

export const PASSWORD_RESET_TTL_MINUTES = 15;
export const PASSWORD_RESET_TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60 * 1000;
export const PASSWORD_RESET_GENERIC_MESSAGE =
    "If an account with that email exists, we sent a password reset link.";

const RESET_TOKEN_REGEX = /^[A-Za-z0-9_-]{32,256}$/;

export const hashPasswordResetToken = (token: string) =>
    createHash("sha256").update(token).digest("hex");

export const isWellFormedPasswordResetToken = (token: string): boolean =>
    RESET_TOKEN_REGEX.test(token);

export function createPasswordResetToken() {
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = hashPasswordResetToken(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();

    return { rawToken, tokenHash, expiresAt };
}

export async function invalidateOutstandingPasswordResetTokens(
    deps: dependency,
    userId: string,
    invalidatedAt: string,
): Promise<void> {
    await deps.db
        .update(passwordResetTokens)
        .set({
            invalidatedAt,
            updatedAt: invalidatedAt,
        })
        .where(
            and(
                eq(passwordResetTokens.userId, userId),
                isNull(passwordResetTokens.usedAt),
                isNull(passwordResetTokens.invalidatedAt),
            ),
        );
}

export async function createPasswordResetRecord(
    deps: dependency,
    input: { userId: string; tokenHash: string; expiresAt: string; requestedByIp?: string | null },
) {
    const now = new Date().toISOString();
    return deps.db.transaction(async (tx) => {
        await tx
            .update(passwordResetTokens)
            .set({
                invalidatedAt: now,
                updatedAt: now,
            })
            .where(
                and(
                    eq(passwordResetTokens.userId, input.userId),
                    isNull(passwordResetTokens.usedAt),
                    isNull(passwordResetTokens.invalidatedAt),
                ),
            );

        const [record] = await tx
            .insert(passwordResetTokens)
            .values({
                userId: input.userId,
                tokenHash: input.tokenHash,
                expiresAt: input.expiresAt,
                requestedByIp: input.requestedByIp ?? null,
            })
            .returning();

        return record;
    });
}

export async function deletePasswordResetRecordByHash(
    deps: dependency,
    tokenHash: string,
): Promise<void> {
    await deps.db
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, tokenHash));
}

export async function getPasswordResetRecordByRawToken(
    deps: dependency,
    rawToken: string,
) {
    if (!isWellFormedPasswordResetToken(rawToken)) {
        return null;
    }

    const tokenHash = hashPasswordResetToken(rawToken);
    const now = new Date().toISOString();

    const [record] = await deps.db
        .select({
            id: passwordResetTokens.id,
            userId: passwordResetTokens.userId,
            tokenHash: passwordResetTokens.tokenHash,
            expiresAt: passwordResetTokens.expiresAt,
            usedAt: passwordResetTokens.usedAt,
            invalidatedAt: passwordResetTokens.invalidatedAt,
            email: users.email,
        })
        .from(passwordResetTokens)
        .innerJoin(users, eq(users.id, passwordResetTokens.userId))
        .where(
            and(
                eq(passwordResetTokens.tokenHash, tokenHash),
                isNull(passwordResetTokens.usedAt),
                isNull(passwordResetTokens.invalidatedAt),
                gt(passwordResetTokens.expiresAt, now),
            ),
        )
        .limit(1);

    return record ?? null;
}
