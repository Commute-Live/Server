import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { startDb } from "../db.ts";
import { devices, userDevices, users } from "../schema/schema.ts";

const { db, sql } = startDb();

async function seed() {
    const deviceId = randomUUID();

    await db.insert(devices).values({
        id: deviceId,
        timezone: "America/New_York",
        config: { brightness: 60, lines: [{ provider: "mta-subway", line: "A", stop: "A01", direction: "N" }] },
    });

    const passwordHash = createHash("sha256").update("demo-password").digest("hex");

    const [user] = await db.insert(users).values({
        email: "demo@example.com",
        passwordHash,
    }).returning({ id: users.id });

    if (!user) {
        throw new Error("Failed to create demo user");
    }

    await db.insert(userDevices).values({
        userId: user.id,
        deviceId,
    });

    await sql.end();
}

seed().catch((err) => {
    console.error(err);
    process.exit(1);
});
