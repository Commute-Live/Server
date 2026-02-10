import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { dependency } from "../types/dependency.d.ts";
import { devices, users, userDevices } from "../db/schema/schema.ts";

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
        try {
            const [row] = await deps.db
                .insert(devices)
                .values({ id, timezone })
                .returning();
            return c.json({ device: row }, 201);
        } catch (err) {
            return c.json({ error: "Device create failed (maybe duplicate id)", detail: `${err}` }, 409);
        }
    });

    // Register a user account (no device linkage here)
    app.post("/user/register", async (c) => {
        const body = await c.req.json().catch(() => null);
        const { email, password } = body ?? {};

        if (!email || !password) {
            return c.json({ error: "email and password are required" }, 400);
        }

        const existingEmail = await deps.db.select().from(users).where(eq(users.email, email)).limit(1);
        if (existingEmail.length) return c.json({ error: "email already registered" }, 409);

        const passwordHash = hashPassword(password);
        try {
            const [user] = await deps.db
                .insert(users)
                .values({ email, passwordHash })
                .returning();
            return c.json({ user, devices: [] }, 201);
        } catch (err) {
            return c.json({ error: "User create failed", detail: `${err}` }, 500);
        }
    });

    // Link an existing device to a user
    app.post("/user/device/link", async (c) => {
        const body = await c.req.json().catch(() => null);
        const { userId, deviceId } = body ?? {};

        if (!userId || !deviceId) {
            return c.json({ error: "userId and deviceId are required" }, 400);
        }

        const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user) return c.json({ error: "user not found" }, 404);

        const [device] = await deps.db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
        if (!device) return c.json({ error: "device not found" }, 404);

        const [taken] = await deps.db.select().from(userDevices).where(eq(userDevices.deviceId, deviceId)).limit(1);
        if (taken) return c.json({ error: "device already linked to another user" }, 409);

        try {
            const [link] = await deps.db.insert(userDevices).values({ userId, deviceId }).returning();
            return c.json({ link }, 201);
        } catch (err) {
            return c.json({ error: "Link create failed", detail: `${err}` }, 500);
        }
    });

    // Login by email/password and return linked devices
    app.post("/user/login", async (c) => {
        const body = await c.req.json().catch(() => null);
        const { email, password } = body ?? {};
        if (!email || !password) return c.json({ error: "email and password are required" }, 400);

        const [user] = await deps.db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user) return c.json({ error: "invalid credentials" }, 401);

        const passwordHash = hashPassword(password);
        if (passwordHash !== user.passwordHash) return c.json({ error: "invalid credentials" }, 401);

        const deviceRows = await deps.db
            .select({ deviceId: userDevices.deviceId })
            .from(userDevices)
            .where(eq(userDevices.userId, user.id));

        const deviceIds = deviceRows.map((d) => d.deviceId);

        return c.json({ user: { id: user.id, email: user.email, deviceIds } }, 200);
    });
}
