import "dotenv/config";
import { startDb } from "../db/db.ts";
import { runSeptaGtfsImport } from "../septa/gtfs_import.ts";

async function main() {
    const { db } = startDb();
    const sourceUrl = process.env.SEPTA_STATIC_GTFS_URL;
    const result = await runSeptaGtfsImport(db, sourceUrl);
    console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
