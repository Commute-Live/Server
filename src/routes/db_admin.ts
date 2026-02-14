import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";
import { Buffer } from "node:buffer";

const MAX_ROWS = 200;

const isReadOnlyQuery = (query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return false;
    if (q.includes(";")) return false;
    return q.startsWith("select ") || q.startsWith("with ") || q.startsWith("explain ");
};

const escapeHtml = (value: unknown) =>
    String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

const renderRows = (rows: Array<Record<string, unknown>>) => {
    if (!rows.length) return "<p>No rows returned.</p>";

    const columns = Object.keys(rows[0] ?? {});
    const head = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("");
    const body = rows
        .map((row) => {
            const cells = columns
                .map((col) => `<td>${escapeHtml(row[col] ?? "")}</td>`)
                .join("");
            return `<tr>${cells}</tr>`;
        })
        .join("");

    return `
<table>
  <thead><tr>${head}</tr></thead>
  <tbody>${body}</tbody>
</table>`;
};

export function registerDbAdmin(app: Hono, deps: dependency) {
    app.get("/admin/db", async (c) => {
        const configuredUser = process.env.DB_ADMIN_USERNAME;
        const configuredPass = process.env.DB_ADMIN_PASSWORD;
        if (!configuredUser || !configuredPass) {
            return c.text("DB admin page is disabled. Set DB_ADMIN_USERNAME and DB_ADMIN_PASSWORD.", 503);
        }

        const authHeader = c.req.header("authorization") ?? "";
        const basicPrefix = "Basic ";
        let authorized = false;

        if (authHeader.startsWith(basicPrefix)) {
            const encoded = authHeader.slice(basicPrefix.length).trim();
            try {
                const decoded = Buffer.from(encoded, "base64").toString("utf8");
                const sep = decoded.indexOf(":");
                if (sep >= 0) {
                    const user = decoded.slice(0, sep);
                    const pass = decoded.slice(sep + 1);
                    authorized = user === configuredUser && pass === configuredPass;
                }
            } catch {
                authorized = false;
            }
        }

        if (!authorized) {
            c.header("WWW-Authenticate", 'Basic realm="DB Admin", charset="UTF-8"');
            return c.text("Unauthorized", 401);
        }

        const selectedTable = (c.req.query("table") ?? "").trim();
        const escapeSqlIdent = (value: string) => `"${value.replaceAll('"', '""')}"`;
        const defaultTableQuery = selectedTable
            ? `select * from ${escapeSqlIdent(selectedTable)}`
            : "";
        const query = (c.req.query("q") ?? defaultTableQuery).trim();
        let error = "";
        let rows: Array<Record<string, unknown>> = [];
        let tables: string[] = [];

        try {
            const tableRows = (await deps.sql`
                select table_name
                from information_schema.tables
                where table_schema = 'public'
                order by table_name asc
            `) as Array<{ table_name: string }>;
            tables = tableRows.map((row) => row.table_name);
        } catch (err) {
            error = err instanceof Error ? `Failed to list tables: ${err.message}` : String(err);
        }

        if (query) {
            if (!isReadOnlyQuery(query)) {
                error = "Only single read-only queries are allowed (SELECT/WITH/EXPLAIN, no semicolon).";
            } else {
                try {
                    const limitedQuery = `select * from (${query}) as _q limit ${MAX_ROWS}`;
                    rows = (await deps.sql.unsafe(limitedQuery)) as Array<Record<string, unknown>>;
                } catch (err) {
                    error = err instanceof Error ? err.message : String(err);
                }
            }
        }

        const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>DB Admin</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: ui-sans-serif, -apple-system, sans-serif; margin: 0; color: #111; background: #f2f4f7; }
    .wrap { display: flex; min-height: 100vh; }
    .side { width: 300px; border-right: 1px solid #d8dde4; background: #fff; padding: 16px; overflow: auto; }
    .main { flex: 1; padding: 18px; overflow: auto; }
    h1 { margin: 0 0 12px 0; font-size: 22px; }
    h2 { margin: 0 0 8px 0; font-size: 14px; color: #333; }
    form { margin: 0 0 16px 0; }
    textarea { width: 100%; min-height: 120px; font-family: ui-monospace, monospace; font-size: 13px; border: 1px solid #cfd6df; border-radius: 8px; padding: 10px; background: #fff; }
    button { margin-top: 8px; padding: 8px 12px; border-radius: 8px; border: 1px solid #cfd6df; background: #fff; cursor: pointer; }
    .note { color: #555; font-size: 13px; margin: 8px 0; }
    .err { color: #a40000; font-weight: 600; margin: 8px 0; }
    .table-list { margin: 0; padding: 0; list-style: none; border: 1px solid #e2e7ee; border-radius: 10px; overflow: hidden; }
    .table-link { display: block; padding: 10px 12px; text-decoration: none; color: #1d2733; border-bottom: 1px solid #edf1f5; font-size: 13px; }
    .table-link:hover { background: #f4f8ff; }
    .table-link.active { background: #dfeeff; color: #0f3d70; font-weight: 700; }
    .panel { border: 1px solid #d8dde4; background: #fff; border-radius: 12px; padding: 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
    .result { margin-top: 14px; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; background: #fff; }
    th, td { border: 1px solid #dde3ea; text-align: left; padding: 6px; font-size: 12px; vertical-align: top; }
    th { background: #f7f9fb; position: sticky; top: 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <aside class="side">
      <h2>Tables</h2>
      <p class="note">Click a table to preview rows.</p>
      ${
          tables.length
              ? `<ul class="table-list">${tables
                    .map((tableName) => {
                        const active = tableName === selectedTable ? "active" : "";
                        return `<li><a class="table-link ${active}" href="/admin/db?table=${encodeURIComponent(tableName)}">${escapeHtml(tableName)}</a></li>`;
                    })
                    .join("")}</ul>`
              : `<p class="note">No tables found.</p>`
      }
    </aside>
    <main class="main">
      <div class="panel">
        <h1>Database Explorer</h1>
        <p class="note">Read-only mode. Max ${MAX_ROWS} rows. Protected by HTTP Basic Auth.</p>
        <form method="get" action="/admin/db">
          ${selectedTable ? `<input type="hidden" name="table" value="${escapeHtml(selectedTable)}" />` : ""}
          <textarea name="q" placeholder="select * from devices">${escapeHtml(query)}</textarea>
          <br />
          <button type="submit">Run Query</button>
        </form>
        ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
        ${rows.length ? `<p class="note">Returned ${rows.length} row(s).</p>` : ""}
        <div class="result">${renderRows(rows)}</div>
      </div>
    </main>
  </div>
</body>
</html>`;

        return c.html(html);
    });
}
