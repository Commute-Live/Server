import type { Context } from "hono";

export const getClientIp = (c: Context): string | null => {
    const forwardedFor = c.req.header("x-forwarded-for");
    if (forwardedFor) {
        const [first] = forwardedFor
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        if (first) return first;
    }

    const realIp = c.req.header("x-real-ip")?.trim();
    if (realIp) {
        return realIp;
    }

    return null;
};
