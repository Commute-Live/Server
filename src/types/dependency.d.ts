import type postgres from "postgres";
import type { drizzle } from "drizzle-orm/postgres-js";

type dependency = {
    sql: ReturnType<typeof postgres>;
    db: ReturnType<typeof drizzle>;
};

export type { dependency };
