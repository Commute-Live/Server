import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";

import type { dependency } from "../types/dependency.d.ts";
import { users } from "../db/schema/schema.ts";

const LEGACY_SHA256_REGEX = /^[a-f0-9]{64}$/i;
const ARGON2_MEMORY_COST_KIB = 19_456;
const ARGON2_TIME_COST = 2;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const validatePasswordStrength = (password: string): string[] => {
    const errors: string[] = [];

    if (password.length < 12) {
        errors.push("Password must be at least 12 characters long.");
    }
    if (password.length > 128) {
        errors.push("Password must be 128 characters or fewer.");
    }
    if (!/[a-z]/.test(password)) {
        errors.push("Password must include a lowercase letter.");
    }
    if (!/[A-Z]/.test(password)) {
        errors.push("Password must include an uppercase letter.");
    }
    if (!/[0-9]/.test(password)) {
        errors.push("Password must include a number.");
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
        errors.push("Password must include a symbol.");
    }

    return errors;
};

export const isLegacyPasswordHash = (passwordHash: string): boolean =>
    LEGACY_SHA256_REGEX.test(passwordHash);

export async function hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password, {
        algorithm: "argon2id",
        memoryCost: ARGON2_MEMORY_COST_KIB,
        timeCost: ARGON2_TIME_COST,
    });
}

export async function verifyPassword(
    password: string,
    storedPasswordHash: string,
): Promise<boolean> {
    if (storedPasswordHash.startsWith("$argon2")) {
        return Bun.password.verify(password, storedPasswordHash);
    }

    if (!isLegacyPasswordHash(storedPasswordHash)) {
        return false;
    }

    const candidate = createHash("sha256").update(password).digest();
    const existing = Buffer.from(storedPasswordHash, "hex");

    if (candidate.length !== existing.length) {
        return false;
    }

    return timingSafeEqual(candidate, existing);
}

export async function upgradeLegacyPasswordHash(
    deps: dependency,
    userId: string,
    password: string,
): Promise<string> {
    const nextPasswordHash = await hashPassword(password);
    const now = new Date().toISOString();

    await deps.db
        .update(users)
        .set({
            passwordHash: nextPasswordHash,
            updatedAt: now,
        })
        .where(eq(users.id, userId));

    return nextPasswordHash;
}
