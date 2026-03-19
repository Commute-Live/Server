const parseNumber = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
};

const resolveSecret = (name: string, fallback: string): string => {
    const value = process.env[name];
    if (value && value.trim() !== "") return value;

    if (process.env.NODE_ENV === "production") {
        throw new Error(`${name} is required in production`);
    }

    return fallback;
};

const boolFromEnv = (value: string | undefined, fallback: boolean): boolean => {
    if (!value) return fallback;
    return value.toLowerCase() === "true";
};

const sameSiteFromEnv = (value: string | undefined, fallback: "Strict" | "Lax" | "None") => {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "strict") return "Strict";
    if (normalized === "lax") return "Lax";
    if (normalized === "none") return "None";
    return fallback;
};

const accessTokenTtlMinutes = parseNumber(process.env.ACCESS_TOKEN_TTL_MIN, 15);
const refreshTokenTtlDays = parseNumber(process.env.REFRESH_TOKEN_TTL_DAYS, 30);

export const authConfig = {
    accessSecret: resolveSecret("JWT_ACCESS_SECRET", "dev-access-secret-change-me"),
    refreshSecret: resolveSecret("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"),
    accessTokenTtlMinutes,
    refreshTokenTtlDays,
    accessTokenTtlSeconds: Math.floor(accessTokenTtlMinutes * 60),
    refreshTokenTtlSeconds: Math.floor(refreshTokenTtlDays * 24 * 60 * 60),
    cookieSecure: boolFromEnv(process.env.COOKIE_SECURE, process.env.NODE_ENV === "production"),
    cookieSameSite: sameSiteFromEnv(
        process.env.COOKIE_SAME_SITE,
        process.env.NODE_ENV === "production" ? "None" : "Lax",
    ),
} as const;

export const ACCESS_COOKIE_NAME = "access_token";
export const REFRESH_COOKIE_NAME = "refresh_token";
