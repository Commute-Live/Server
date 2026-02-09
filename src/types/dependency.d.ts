import type postgres from "postgres";
import type { drizzle } from "drizzle-orm/postgres-js";
import type { AggregatorEngine } from "../types.ts";

type dependency = {
    sql: ReturnType<typeof postgres>;
    db: ReturnType<typeof drizzle>;
    aggregator: AggregatorEngine;
};

export type { dependency };
