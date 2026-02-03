import type postgres from "postgres";

type dependency = {
    sql: ReturnType<typeof postgres>;
};

export type { dependency };
