import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { startDb } from "../db.ts";
import { devices, users } from "../schema/schema.ts";

const { db, sql } = startDb();

async function seed() {
    const deviceId = randomUUID();

    await db.insert(devices).values({
        id: deviceId,
        timezone: "America/New_York",
        config: { brightness: 60, lines: [{ provider: "mta", line: "A", stop: "A01", direction: "N" }] },
    });

    const passwordHash = createHash("sha256").update("demo-password").digest("hex");

    await db.insert(users).values({
        email: "demo@example.com",
        passwordHash,
        deviceId,
    });

    await sql.end();
}

seed().catch((err) => {
    console.error(err);
    process.exit(1);
});
