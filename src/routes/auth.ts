import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { dependency } from "../types/dependency.d.ts";
import { devices, users } from "../db/schema/schema.ts";

const hashPassword = (password: string) =>
    createHash("sha256").update(password).digest("hex");

export function registerAuth(app: Hono, deps: dependency) {
    // Register a device (client supplies the device id string)
    app.post("/device/register", async (c) => {
        const body = await c.req.json().catch(() => null);
        const id = body?.id;
        if (!id || typeof id !== "string") {
            return c.json({ error: "id is required (string)" }, 400);
        }

        const timezone = typeof body?.timezone === "string" ? body.timezone : "UTC";
        const preferences = typeof body?.preferences === "object" && body.preferences !== null ? body.preferences : {};

        try {
            const [row] = await deps.db
                .insert(devices)
                .values({ id, timezone, preferences })
                .returning();
            return c.json({ device: row }, 201);
        } catch (err) {
            return c.json({ error: "Device create failed (maybe duplicate id)", detail: `${err}` }, 409);
        }
    });

    // Register a user tied to a device
    app.post("/user/register", async (c) => {
        const body = await c.req.json().catch(() => null);
        const { email, password, deviceId } = body ?? {};

        if (!email || !password || !deviceId) {
            return c.json({ error: "email, password, deviceId are required" }, 400);
        }

        // Ensure device exists
        const [device] = await deps.db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
        if (!device) return c.json({ error: "device not found" }, 404);

        // Ensure device not already linked
        const existingDeviceUser = await deps.db.select().from(users).where(eq(users.deviceId, deviceId)).limit(1);
        if (existingDeviceUser.length) return c.json({ error: "device already registered to a user" }, 409);

        // Ensure email unique
        const existingEmail = await deps.db.select().from(users).where(eq(users.email, email)).limit(1);
        if (existingEmail.length) return c.json({ error: "email already registered" }, 409);

        const passwordHash = hashPassword(password);
        try {
            const [user] = await deps.db
                .insert(users)
                .values({ email, passwordHash, deviceId })
                .returning();
            return c.json({ user }, 201);
        } catch (err) {
            return c.json({ error: "User create failed", detail: `${err}` }, 500);
        }
    });

    // Login by email/password
    app.post("/user/login", async (c) => {
        const body = await c.req.json().catch(() => null);
        const { email, password } = body ?? {};
        if (!email || !password) return c.json({ error: "email and password are required" }, 400);

        const [user] = await deps.db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user) return c.json({ error: "invalid credentials" }, 401);

        const passwordHash = hashPassword(password);
        if (passwordHash !== user.passwordHash) return c.json({ error: "invalid credentials" }, 401);

        return c.json({ user: { id: user.id, email: user.email, deviceId: user.deviceId } }, 200);
    });
}
