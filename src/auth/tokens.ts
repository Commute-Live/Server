import { sign, verify } from "hono/jwt";

import { authConfig } from "./config.ts";

export type AccessTokenClaims = {
    sub: string;
    sid: string;
    email?: string;
    type: "access";
    iat: number;
    exp: number;
};

export type RefreshTokenClaims = {
    sub: string;
    sid: string;
    fam: string;
    jti: string;
    type: "refresh";
    iat: number;
    exp: number;
};

const nowInSeconds = () => Math.floor(Date.now() / 1000);

export const isExpiredJwtError = (err: unknown): boolean => {
    return err instanceof Error && err.name === "JwtTokenExpired";
};

export async function signAccessToken(input: {
    userId: string;
    sessionId: string;
    email?: string;
}): Promise<string> {
    const iat = nowInSeconds();
    const exp = iat + authConfig.accessTokenTtlSeconds;

    const payload: AccessTokenClaims = {
        sub: input.userId,
        sid: input.sessionId,
        email: input.email,
        type: "access",
        iat,
        exp,
    };

    return sign(payload, authConfig.accessSecret, "HS256");
}

export async function signRefreshToken(input: {
    userId: string;
    sessionId: string;
    familyId: string;
    jti: string;
}): Promise<string> {
    const iat = nowInSeconds();
    const exp = iat + authConfig.refreshTokenTtlSeconds;

    const payload: RefreshTokenClaims = {
        sub: input.userId,
        sid: input.sessionId,
        fam: input.familyId,
        jti: input.jti,
        type: "refresh",
        iat,
        exp,
    };

    return sign(payload, authConfig.refreshSecret, "HS256");
}

const expectStringClaim = (claims: Record<string, unknown>, key: string): string => {
    const value = claims[key];
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`invalid claim ${key}`);
    }
    return value;
};

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const verified = await verify(token, authConfig.accessSecret, { alg: "HS256" });
    const claims = verified as Record<string, unknown>;
    const type = expectStringClaim(claims, "type");
    if (type !== "access") throw new Error("invalid token type");

    return {
        sub: expectStringClaim(claims, "sub"),
        sid: expectStringClaim(claims, "sid"),
        email: typeof claims.email === "string" ? claims.email : undefined,
        type: "access",
        iat: Number(claims.iat),
        exp: Number(claims.exp),
    };
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
    const verified = await verify(token, authConfig.refreshSecret, { alg: "HS256" });
    const claims = verified as Record<string, unknown>;
    const type = expectStringClaim(claims, "type");
    if (type !== "refresh") throw new Error("invalid token type");

    return {
        sub: expectStringClaim(claims, "sub"),
        sid: expectStringClaim(claims, "sid"),
        fam: expectStringClaim(claims, "fam"),
        jti: expectStringClaim(claims, "jti"),
        type: "refresh",
        iat: Number(claims.iat),
        exp: Number(claims.exp),
    };
}
