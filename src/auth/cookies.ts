import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";

import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, authConfig } from "./config.ts";

const baseCookieOptions = {
    httpOnly: true,
    secure: authConfig.cookieSecure,
    sameSite: "Strict" as const,
    path: "/",
};

export function setAuthCookies(c: Context, tokens: { accessToken: string; refreshToken: string }) {
    setCookie(c, ACCESS_COOKIE_NAME, tokens.accessToken, {
        ...baseCookieOptions,
        maxAge: authConfig.accessTokenTtlSeconds,
    });

    setCookie(c, REFRESH_COOKIE_NAME, tokens.refreshToken, {
        ...baseCookieOptions,
        maxAge: authConfig.refreshTokenTtlSeconds,
    });
}

export function clearAuthCookies(c: Context) {
    deleteCookie(c, ACCESS_COOKIE_NAME, baseCookieOptions);
    deleteCookie(c, REFRESH_COOKIE_NAME, baseCookieOptions);
}
