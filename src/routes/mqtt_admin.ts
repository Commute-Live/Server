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
    const normalizeEta = (etaRaw: string) => {
        const upper = etaRaw.trim().toUpperCase();
        if (!upper) return "--";
        if (upper === "NOW" || upper === "DUE") return "DUE";
        const minutesMatch = upper.match(/(\d+)/);
        if (minutesMatch) {
            const minutes = Number(minutesMatch[1]);
            if (Number.isFinite(minutes)) return minutes <= 1 ? "DUE" : `${minutes}m`;
        }
        return etaRaw;
    };

    const etaFromArrivals = (arrivals: unknown, fetchedAtRaw?: string) => {
        if (!Array.isArray(arrivals) || arrivals.length === 0) return "--";
        const fetchedAtMs = fetchedAtRaw ? Date.parse(fetchedAtRaw) : Number.NaN;
        const hasFetchedAt = Number.isFinite(fetchedAtMs);
        let sawDue = false;
        for (const item of arrivals) {
            if (!item || typeof item !== "object") continue;
            const row = item as Record<string, unknown>;
            const arrival = typeof row.arrivalTime === "string" ? row.arrivalTime : "";
            if (!arrival) continue;
            const arrivalMs = Date.parse(arrival);
            if (!Number.isFinite(arrivalMs)) continue;
            if (!hasFetchedAt) {
                return arrival.length >= 16 ? arrival.slice(11, 16) : "--";
            }
            const diffSec = Math.max(0, Math.floor((arrivalMs - fetchedAtMs) / 1000));
            const mins = Math.floor((diffSec + 59) / 60);
            const label = mins <= 1 ? "DUE" : `${mins}m`;
            if (label === "DUE") {
                sawDue = true;
                continue;
            }
            return label;
        }
        return sawDue ? "DUE" : "--";
    };

    const ledPreviewFromEvent = (topic: string | undefined, payloadPreview: string | undefined) => {
        if (!payloadPreview || !topic) return "";
        let data: Record<string, unknown> | null = null;
        try {
            data = JSON.parse(payloadPreview) as Record<string, unknown>;
        } catch {
            return "";
        }
        if (!data || typeof data !== "object") return "";

        // ESP-reported currently rendered rows.
        if (topic.includes("/display")) {
            const row1 = (data.row1 ?? {}) as Record<string, unknown>;
            const row2 = (data.row2 ?? {}) as Record<string, unknown>;
            const r1Line = typeof row1.line === "string" ? row1.line : "";
            const r1Label = typeof row1.label === "string" ? row1.label : "";
            const r1Eta = typeof row1.eta === "string" ? normalizeEta(row1.eta) : "--";
            const r2Line = typeof row2.line === "string" ? row2.line : "";
            const r2Label = typeof row2.label === "string" ? row2.label : "";
            const r2Eta = typeof row2.eta === "string" ? normalizeEta(row2.eta) : "--";
            const first = r1Line ? `${r1Line} ${r1Label} ${r1Eta}`.trim() : "";
            const second = r2Line ? `${r2Line} ${r2Label} ${r2Eta}`.trim() : "";
            return [first, second].filter(Boolean).join(" | ");
        }

        // Inferred from outgoing command payload when ESP report is not present.
        if (topic.includes("/commands")) {
            const lines = Array.isArray(data.lines) ? data.lines : [];
            const fetchedAt = typeof data.fetchedAt === "string" ? data.fetchedAt : undefined;
            const parts = lines
                .slice(0, 2)
                .map((entry) => {
                    if (!entry || typeof entry !== "object") return "";
                    const row = entry as Record<string, unknown>;
                    const line = typeof row.line === "string" ? row.line : "";
                    if (!line) return "";
                    const label =
                        typeof row.directionLabel === "string"
                            ? row.directionLabel
                            : typeof row.stop === "string"
                              ? row.stop
                              : "";
                    const eta = etaFromArrivals(row.nextArrivals, typeof row.fetchedAt === "string" ? row.fetchedAt : fetchedAt);
                    return `${line} ${label} ${eta}`.trim();
                })
                .filter(Boolean);
            return parts.join(" | ");
        }

        return "";
    };

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
        const secondsRaw = (c.req.query("seconds") ?? "all").trim().toLowerCase();
        const limit = Number(limitRaw);
        const nowMs = Date.now();
        const seconds =
            secondsRaw === "all" || secondsRaw === ""
                ? null
                : Number.isFinite(Number(secondsRaw))
                  ? Math.max(1, Math.floor(Number(secondsRaw)))
                  : null;
        const events = getRecentMqttDebugEvents(Number.isFinite(limit) ? limit : 200).filter((event) => {
            if (seconds == null) return true;
            const tsMs = Date.parse(event.ts);
            if (!Number.isFinite(tsMs)) return false;
            return nowMs - tsMs <= seconds * 1000;
        });
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
        const secondsRaw = (c.req.query("seconds") ?? "all").trim().toLowerCase();
        const topicFilter = (c.req.query("topic") ?? "").trim();
        const directionFilter = (c.req.query("direction") ?? "").trim().toLowerCase();
        const limit = Number(limitRaw);
        const seconds =
            secondsRaw === "all" || secondsRaw === ""
                ? null
                : Number.isFinite(Number(secondsRaw))
                  ? Math.max(1, Math.floor(Number(secondsRaw)))
                  : null;
        const nowMs = Date.now();
        const events = getRecentMqttDebugEvents(Number.isFinite(limit) ? limit : 200).filter((event) => {
            const topicOk = !topicFilter || (event.topic ?? "").toLowerCase().includes(topicFilter.toLowerCase());
            const directionOk = !directionFilter || event.direction === directionFilter;
            const secondsOk =
                seconds == null
                    ? true
                    : (() => {
                          const tsMs = Date.parse(event.ts);
                          if (!Number.isFinite(tsMs)) return false;
                          return nowMs - tsMs <= seconds * 1000;
                      })();
            return topicOk && directionOk && secondsOk;
        });

        const rows = events
            .slice()
            .reverse()
            .map((event) => {
                const ledPreview = ledPreviewFromEvent(event.topic, event.payloadPreview);
                return `
<tr>
  <td>${escapeHtml(event.ts)}</td>
  <td>${escapeHtml(event.direction)}</td>
  <td>${escapeHtml(event.topic ?? "")}</td>
  <td>${escapeHtml(ledPreview)}</td>
  <td>${escapeHtml(event.detail ?? "")}</td>
  <td><pre>${escapeHtml(event.payloadPreview ?? "")}</pre></td>
</tr>`;
            })
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
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-width: 520px; }
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
        <select name="seconds">
          <option value="all" ${seconds == null ? "selected" : ""}>All time</option>
          <option value="10" ${seconds === 10 ? "selected" : ""}>Last 10s</option>
          <option value="30" ${seconds === 30 ? "selected" : ""}>Last 30s</option>
          <option value="60" ${seconds === 60 ? "selected" : ""}>Last 60s</option>
          <option value="300" ${seconds === 300 ? "selected" : ""}>Last 5m</option>
        </select>
        <input name="limit" type="number" min="1" max="1000" value="${escapeHtml(limitRaw)}" />
        <button type="submit">Apply</button>
      </form>
      <p class="muted">Rows shown: ${events.length} ${seconds == null ? "(all time)" : `(last ${seconds}s)`}</p>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Direction</th>
            <th>Topic</th>
            <th>LED</th>
            <th>Detail</th>
            <th>Payload Preview</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="6">No events yet.</td></tr>'}
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
