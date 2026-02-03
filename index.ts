import { startDb } from "./src/db/db.ts";

const { sql } = startDb();

const server = Bun.serve({
    port: 3000,
    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/health") {
            await sql`select 1`;
            return new Response("ok");
        }

        return new Response("Welcome to Bun!");
    },
});

console.log(`Listening on ${server.url}`);
