import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

let sqlInstance: ReturnType<typeof postgres> | null = null;
let dbInstance: ReturnType<typeof drizzle> | null = null;

export function startDb() {
    if (dbInstance && sqlInstance) {
        return { db: dbInstance, sql: sqlInstance };
    }

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error("DATABASE_URL is not set");
    }

    sqlInstance = postgres(connectionString, { max: 1 });
    dbInstance = drizzle(sqlInstance);

    return { db: dbInstance, sql: sqlInstance };
}
