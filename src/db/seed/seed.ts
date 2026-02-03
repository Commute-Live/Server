import "dotenv/config";
import { startDb } from "../db.ts";
import { devices } from "../schema/schema.ts";

const { db, sql } = startDb();

async function seed() {
    const deviceId = crypto.randomUUID();

    await db.insert(devices).values({
        deviceId,
        deviceName: "bugs-bunny",
        config: {},
    });

    await sql.end();
}

seed().catch((err) => {
    console.error(err);
    process.exit(1);
});
