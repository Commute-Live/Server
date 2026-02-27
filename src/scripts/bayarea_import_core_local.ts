import "dotenv/config";
import { join, resolve } from "node:path";
import { startDb } from "../db/db.ts";
import { runBayAreaCoreLocalImport } from "../bayarea/import_core_local.ts";

async function main() {
    const sourceDirArg = process.argv[2];
    const sourceDir = sourceDirArg ? resolve(process.cwd(), sourceDirArg) : join(process.cwd(), "bayarea");

    const { db, sql } = startDb();
    try {
        const result = await runBayAreaCoreLocalImport(db, sourceDir);
        console.log(JSON.stringify(result, null, 2));
    } finally {
        await sql.end();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
