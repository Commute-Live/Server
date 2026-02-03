import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const dbUrl =
    process.env.DATABASE_URL ??
    `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@localhost:5432/${process.env.POSTGRES_DB}`;

if (!dbUrl || dbUrl.includes("undefined")) {
    throw new Error("DATABASE_URL or POSTGRES_* envs are not set");
}

export default defineConfig({
    schema: "./src/db/schema",
    out: "./src/db/migrations",
    dialect: "postgresql",
    dbCredentials: {
        url: dbUrl,
    },
});
