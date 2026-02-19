import type { Hono } from "hono";
import { Buffer } from "node:buffer";
import { getRecentMqttDebugEvents } from "../mqtt/mqtt.ts";

const escapeHtml = (value: unknown) =>
    String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

const parseBasicAuth = (authHeader: string) => {
    const basicPrefix = "Basic ";
    if (!authHeader.startsWith(basicPrefix)) return null;
    const encoded = authHeader.slice(basicPrefix.length).trim();
    try {
        const decoded = Buffer.from(encoded, "base64").toString("utf8");
        const sep = decoded.indexOf(":");
        if (sep < 0) return null;
        return {
            user: decoded.slice(0, sep),
            pass: decoded.slice(sep + 1),
        };
    } catch {
        return null;
    }
};

const ensureAdminAuth = (appName: string, authHeader: string | undefined) => {
    const configuredUser = process.env.DB_ADMIN_USERNAME;
    const configuredPass = process.env.DB_ADMIN_PASSWORD;
    if (!configuredUser || !configuredPass) {
        return {
            ok: false as const,
            status: 503 as const,
            body: `${appName} is disabled. Set DB_ADMIN_USERNAME and DB_ADMIN_PASSWORD.`,
        };
    }
    const creds = parseBasicAuth(authHeader ?? "");
    const authorized = creds?.user === configuredUser && creds?.pass === configuredPass;
    if (!authorized) {
        return {
            ok: false as const,
            status: 401 as const,
            body: "Unauthorized",
            challenge: 'Basic realm="MQTT Admin", charset="UTF-8"',
        };
    }
    return { ok: true as const };
};

export function registerMqttAdmin(app: Hono) {
    app.get("/admin/mqtt/events", async (c) => {
        const auth = ensureAdminAuth("MQTT admin page", c.req.header("authorization"));
        if (!auth.ok) {
            if (auth.status === 401 && "challenge" in auth) {
                c.header("WWW-Authenticate", auth.challenge);
            }
            c.status(auth.status);
            return c.text(auth.body);
        }

        const limitRaw = c.req.query("limit") ?? "200";
        const limit = Number(limitRaw);
        const events = getRecentMqttDebugEvents(Number.isFinite(limit) ? limit : 200);
        return c.json({ events }, 200);
    });

    app.get("/admin/mqtt", async (c) => {
        const auth = ensureAdminAuth("MQTT admin page", c.req.header("authorization"));
        if (!auth.ok) {
            if (auth.status === 401 && "challenge" in auth) {
                c.header("WWW-Authenticate", auth.challenge);
            }
            c.status(auth.status);
            return c.text(auth.body);
        }

        const limitRaw = c.req.query("limit") ?? "200";
        const topicFilter = (c.req.query("topic") ?? "").trim();
        const directionFilter = (c.req.query("direction") ?? "").trim().toLowerCase();
        const limit = Number(limitRaw);
        const events = getRecentMqttDebugEvents(Number.isFinite(limit) ? limit : 200).filter((event) => {
            const topicOk = !topicFilter || (event.topic ?? "").toLowerCase().includes(topicFilter.toLowerCase());
            const directionOk = !directionFilter || event.direction === directionFilter;
            return topicOk && directionOk;
        });

        const rows = events
            .slice()
            .reverse()
            .map(
                (event) => `
<tr>
  <td>${escapeHtml(event.ts)}</td>
  <td>${escapeHtml(event.direction)}</td>
  <td>${escapeHtml(event.topic ?? "")}</td>
  <td>${escapeHtml(event.detail ?? "")}</td>
  <td><pre>${escapeHtml(event.payloadPreview ?? "")}</pre></td>
</tr>`,
            )
            .join("");

        const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>MQTT Debug</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: ui-sans-serif, -apple-system, sans-serif; margin: 0; color: #111; background: #f2f4f7; }
    .wrap { padding: 18px; max-width: 1400px; margin: 0 auto; }
    h1 { margin: 0 0 10px 0; font-size: 24px; }
    .card { border: 1px solid #d8dde4; border-radius: 12px; background: #fff; padding: 14px; }
    .controls { display: grid; grid-template-columns: 1fr 180px 120px 120px; gap: 8px; margin-bottom: 12px; }
    input, select, button { border: 1px solid #cfd6df; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
    button { background: #fff; cursor: pointer; }
    .muted { color: #555; font-size: 13px; margin: 8px 0 12px 0; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #dde3ea; text-align: left; padding: 6px; font-size: 12px; vertical-align: top; }
    th { background: #f7f9fb; position: sticky; top: 0; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-width: 560px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>MQTT Debug Console</h1>
      <p class="muted">Shows recent MQTT activity observed by this API process. Auto-refresh every 3 seconds.</p>
      <form method="get" action="/admin/mqtt" class="controls">
        <input name="topic" placeholder="Filter topic contains..." value="${escapeHtml(topicFilter)}" />
        <select name="direction">
          <option value="" ${directionFilter ? "" : "selected"}>All directions</option>
          <option value="outgoing" ${directionFilter === "outgoing" ? "selected" : ""}>outgoing</option>
          <option value="incoming" ${directionFilter === "incoming" ? "selected" : ""}>incoming</option>
          <option value="state" ${directionFilter === "state" ? "selected" : ""}>state</option>
          <option value="error" ${directionFilter === "error" ? "selected" : ""}>error</option>
        </select>
        <input name="limit" type="number" min="1" max="1000" value="${escapeHtml(limitRaw)}" />
        <button type="submit">Apply</button>
      </form>
      <p class="muted">Rows shown: ${events.length}</p>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Direction</th>
            <th>Topic</th>
            <th>Detail</th>
            <th>Payload Preview</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="5">No events yet.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
  <script>
    setTimeout(() => location.reload(), 3000);
  </script>
</body>
</html>`;

        return c.html(html);
    });
}
