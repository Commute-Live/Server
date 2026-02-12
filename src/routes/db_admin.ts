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

        const query = (c.req.query("q") ?? "").trim();
        let error = "";
        let rows: Array<Record<string, unknown>> = [];

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
    body { font-family: ui-sans-serif, -apple-system, sans-serif; margin: 24px; color: #111; }
    h1 { margin: 0 0 12px 0; font-size: 22px; }
    form { margin: 0 0 16px 0; }
    textarea { width: 100%; min-height: 120px; font-family: ui-monospace, monospace; font-size: 13px; }
    button { margin-top: 8px; padding: 8px 12px; }
    .note { color: #555; font-size: 13px; margin: 8px 0; }
    .err { color: #a40000; font-weight: 600; margin: 8px 0; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border: 1px solid #ddd; text-align: left; padding: 6px; font-size: 12px; }
    th { background: #f6f6f6; }
  </style>
</head>
<body>
  <h1>Database Explorer</h1>
  <p class="note">Read-only mode. Max ${MAX_ROWS} rows. Protected by HTTP Basic Auth.</p>
  <form method="get" action="/admin/db">
    <textarea name="q" placeholder="select * from devices">${escapeHtml(query)}</textarea>
    <br />
    <button type="submit">Run Query</button>
  </form>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  ${rows.length ? `<p class="note">Returned ${rows.length} row(s).</p>` : ""}
  ${renderRows(rows)}
</body>
</html>`;

        return c.html(html);
    });
}
