import "dotenv/config";
import { startDb } from "../db/db.ts";
import { runSeptaSync } from "../septa/sync.ts";

async function main() {
    const { db } = startDb();
    const result = await runSeptaSync(db);
    console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
