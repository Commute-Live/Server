import type { Hono } from "hono";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { desc } from "drizzle-orm";
import type { dependency } from "../types/dependency.d.ts";
import { devices, firmwareReleases } from "../db/schema/schema.ts";
import { publish } from "../mqtt/mqtt.ts";
import { getActiveDeviceIds } from "../cache.ts";
import { logger } from "../logger.ts";

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
        return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
    } catch {
        return null;
    }
};

const ensureAdminAuth = (authHeader: string | undefined) => {
    const configuredUser = process.env.DB_ADMIN_USERNAME;
    const configuredPass = process.env.DB_ADMIN_PASSWORD;
    if (!configuredUser || !configuredPass) {
        return {
            ok: false as const,
            status: 503 as const,
            body: "OTA Admin is disabled. Set DB_ADMIN_USERNAME and DB_ADMIN_PASSWORD.",
        };
    }
    const creds = parseBasicAuth(authHeader ?? "");
    const authorized =
        creds?.user === configuredUser && creds?.pass === configuredPass;
    if (!authorized) {
        return {
            ok: false as const,
            status: 401 as const,
            body: "Unauthorized",
            challenge: 'Basic realm="OTA Admin", charset="UTF-8"',
        };
    }
    return { ok: true as const };
};

const FIRMWARE_DIR = join(process.cwd(), "uploads", "firmware");

export function registerOtaAdmin(app: Hono, deps: dependency) {
    // Serve firmware binaries — no auth required (devices cannot set auth headers)
    app.get("/firmware/:versionParam/firmware.bin", async (c) => {
        const versionParam = c.req.param("versionParam") ?? "";
        const version = versionParam.startsWith("v")
            ? versionParam.slice(1)
            : versionParam;
        if (!/^\d+\.\d+\.\d+$/.test(version))
            return c.json({ error: "Invalid version" }, 400);
        const filePath = join(FIRMWARE_DIR, `v${version}`, "firmware.bin");
        if (!existsSync(filePath)) return c.json({ error: "Not found" }, 404);
        const file = Bun.file(filePath);
        return new Response(file, {
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Disposition": `attachment; filename="firmware.bin"`,
                "Content-Length": String(file.size),
            },
        });
    });

    // Upload firmware binary
    app.post("/admin/ota/upload", async (c) => {
        const auth = ensureAdminAuth(c.req.header("authorization"));
        if (!auth.ok) {
            if (auth.status === 401 && "challenge" in auth)
                c.header("WWW-Authenticate", auth.challenge);
            c.status(auth.status);
            return c.text(auth.body);
        }

        const formData = await c.req.formData();
        const file = formData.get("firmware") as File | null;
        const version =
            (formData.get("version") as string | null)?.trim() ?? "";
        const description =
            (formData.get("description") as string | null)?.trim() ?? "";

        if (!file) return c.json({ error: "Missing firmware file" }, 400);
        if (!/^\d+\.\d+\.\d+$/.test(version))
            return c.json(
                { error: "Version must be semver (e.g. 1.2.3)" },
                400,
            );

        const versionDir = join(FIRMWARE_DIR, `v${version}`);
        if (!existsSync(versionDir)) mkdirSync(versionDir, { recursive: true });

        const buffer = await file.arrayBuffer();
        writeFileSync(join(versionDir, "firmware.bin"), Buffer.from(buffer));

        const host = c.req.header("host") ?? "localhost";
        const firmwareUrl = `https://${host}/firmware/v${version}/firmware.bin`;

        let release: typeof firmwareReleases.$inferSelect;
        try {
            [release] = await deps.db
                .insert(firmwareReleases)
                .values({ version, description, url: firmwareUrl, sizeBytes: buffer.byteLength })
                .returning();
        } catch (err: any) {
            if (err?.code === "23505")
                return c.json(
                    { error: `Version ${version} already exists. Bump the version number to upload a new build.` },
                    409,
                );
            logger.error({ err }, "firmware DB insert failed");
            return c.json({ error: "Failed to save firmware metadata" }, 500);
        }

        logger.info(
            { version, firmwareUrl, sizeBytes: buffer.byteLength },
            "firmware uploaded",
        );
        return c.json({
            success: true,
            version: release.version,
            description: release.description,
            url: release.url,
            sizeBytes: release.sizeBytes,
            releasedAt: release.releasedAt,
        });
    });

    // Dispatch OTA to one or more devices
    app.post("/admin/ota/dispatch", async (c) => {
        const auth = ensureAdminAuth(c.req.header("authorization"));
        if (!auth.ok) {
            if (auth.status === 401 && "challenge" in auth)
                c.header("WWW-Authenticate", auth.challenge);
            c.status(auth.status);
            return c.text(auth.body);
        }

        const body = (await c.req.json()) as {
            deviceIds?: string[];
            url?: string;
            version?: string;
        };
        if (!Array.isArray(body.deviceIds) || body.deviceIds.length === 0)
            return c.json(
                { error: "deviceIds must be a non-empty array" },
                400,
            );
        if (!body.url || !body.version)
            return c.json({ error: "Missing url or version" }, 400);

        const results: {
            deviceId: string;
            success: boolean;
            error?: string;
        }[] = [];
        for (const deviceId of body.deviceIds) {
            try {
                await publish(
                    `/device/${deviceId}/commands`,
                    JSON.stringify({ type: "ota_update", url: body.url }),
                );
                results.push({ deviceId, success: true });
                logger.info(
                    { deviceId, version: body.version, url: body.url },
                    "OTA dispatched",
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                results.push({ deviceId, success: false, error: msg });
                logger.error(
                    { deviceId, version: body.version, err },
                    "OTA dispatch failed",
                );
            }
        }

        return c.json({ results });
    });

    // Main OTA admin page
    app.get("/admin/ota", async (c) => {
        const auth = ensureAdminAuth(c.req.header("authorization"));
        if (!auth.ok) {
            if (auth.status === 401 && "challenge" in auth)
                c.header("WWW-Authenticate", auth.challenge);
            c.status(auth.status);
            return c.text(auth.body);
        }

        const [allDevices, releases] = await Promise.all([
            deps.db.select({ id: devices.id, config: devices.config, lastActive: devices.lastActive, firmwareVersion: devices.firmwareVersion }).from(devices).orderBy(devices.id),
            deps.db
                .select()
                .from(firmwareReleases)
                .orderBy(desc(firmwareReleases.releasedAt)),
        ]);
        const activeIds = await getActiveDeviceIds(allDevices.map((d) => d.id));

        const releaseRows = releases.length
            ? releases
                  .map(
                      (r, idx) => `<tr id="fw-row-${idx}" class="fw-row${idx === 0 ? " fw-row-selected" : ""}">
  <td><span class="fw-version-pill">v${escapeHtml(r.version)}</span></td>
  <td class="desc-cell">${escapeHtml(r.description) || '<span class="muted">\u2014</span>'}</td>
  <td>${(r.sizeBytes / 1024).toFixed(1)} KB</td>
  <td>${escapeHtml(new Date(r.releasedAt).toLocaleString())}</td>
  <td><span class="fw-url">${escapeHtml(r.url)}</span></td>
  <td><button class="btn btn-sm${idx === 0 ? " btn-primary" : ""}" onclick="selectFirmware(${idx})">Select</button></td>
</tr>`,
                  )
                  .join("")
            : '<tr><td colspan="6" style="color:#9ca3af;text-align:center;padding:20px">No firmware uploaded yet.</td></tr>';

        const allReleasesJson = JSON.stringify(
            releases.map((r) => ({
                version: r.version,
                description: r.description,
                url: r.url,
                sizeBytes: r.sizeBytes,
                releasedAt: r.releasedAt,
            })),
        );

        const latestVersion = releases[0]?.version ?? "";

        const latestReleasedVersion = releases[0]?.version ?? null;

        const deviceRows = allDevices
            .map((device, idx) => {
                const isOnline = activeIds.has(device.id);
                const lastActiveFmt = device.lastActive
                    ? new Date(device.lastActive).toLocaleString()
                    : "Never";
                const statusBadge = isOnline
                    ? '<span class="badge badge-online">Online</span>'
                    : '<span class="badge badge-offline">Offline</span>';
                const fwBadge = device.firmwareVersion
                    ? device.firmwareVersion === latestReleasedVersion
                        ? `<span class="badge badge-current">v${escapeHtml(device.firmwareVersion)}</span>`
                        : `<span class="badge badge-outdated">v${escapeHtml(device.firmwareVersion)}</span>`
                    : '<span class="badge badge-unknown">Unknown</span>';

                const cfg = device.config ?? {};
                const rowId = `cfg-${idx}`;

                type LineEntry = {
                    provider?: string;
                    line?: string;
                    stop?: string;
                    direction?: string;
                };
                const lines: LineEntry[] =
                    (cfg as { lines?: LineEntry[] }).lines ?? [];
                const linesHtml = lines.length
                    ? lines
                          .map(
                              (l) =>
                                  `<div class="cfg-line"><span class="cfg-line-tag">${escapeHtml(l.provider ?? "")} ${escapeHtml(l.line ?? "")}</span>${l.stop ? ` <span class="cfg-line-stop">${escapeHtml(l.stop)}</span>` : ""}${l.direction ? ` <span class="cfg-line-dir">${escapeHtml(l.direction)}</span>` : ""}</div>`,
                          )
                          .join("")
                    : `<span class="muted">No lines configured</span>`;

                const cfgPanel = `<tr id="${rowId}" class="cfg-row" style="display:none">
  <td colspan="6" class="cfg-cell">
    <div class="cfg-grid">
      <div class="cfg-field"><span class="cfg-label">Brightness</span><span class="cfg-val">${escapeHtml((cfg as { brightness?: number }).brightness ?? "—")}</span></div>
      <div class="cfg-field"><span class="cfg-label">Display Type</span><span class="cfg-val">${escapeHtml((cfg as { displayType?: number }).displayType ?? "—")}</span></div>
      <div class="cfg-field"><span class="cfg-label">Scrolling</span><span class="cfg-val">${escapeHtml(String((cfg as { scrolling?: boolean }).scrolling ?? "—"))}</span></div>
      <div class="cfg-field"><span class="cfg-label">Arrivals</span><span class="cfg-val">${escapeHtml((cfg as { arrivalsToDisplay?: number }).arrivalsToDisplay ?? "—")}</span></div>
    </div>
    <div class="cfg-lines-label">Lines</div>
    <div class="cfg-lines">${linesHtml}</div>
  </td>
</tr>`;

                return `<tr>
  <td><input type="checkbox" class="device-check" value="${escapeHtml(device.id)}" /></td>
  <td><code>${escapeHtml(device.id)}</code></td>
  <td>${fwBadge}</td>
  <td>${escapeHtml(lastActiveFmt)}</td>
  <td>${statusBadge}</td>
  <td><button class="btn btn-sm" onclick="toggleConfig('${rowId}', this)">Config</button></td>
</tr>${cfgPanel}`;
            })
            .join("");

        const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>OTA Manager</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: ui-sans-serif, -apple-system, sans-serif; margin: 0; color: #111; background: #f2f4f7; }
    .wrap { padding: 18px; max-width: 1200px; margin: 0 auto; }
    h1 { margin: 0 0 4px 0; font-size: 24px; font-weight: 700; }
    h2 { margin: 0 0 14px 0; font-size: 15px; font-weight: 600; }
    .subtitle { color: #6b7280; font-size: 13px; margin: 0 0 20px 0; }
    .card { border: 1px solid #d8dde4; border-radius: 12px; background: #fff; padding: 18px; margin-bottom: 18px; }
    .field { margin-bottom: 12px; }
    .field label { display: block; font-size: 12px; font-weight: 500; color: #4b5563; margin-bottom: 4px; }
    input[type=text], input[type=file], textarea { border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 10px; font-size: 13px; width: 100%; outline: none; font-family: inherit; }
    input[type=text]:focus, textarea:focus { border-color: #2563eb; box-shadow: 0 0 0 2px #dbeafe; }
    textarea { resize: vertical; }
    .btn { border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer; background: #fff; font-weight: 500; }
    .btn-primary { background: #2563eb; color: #fff; border-color: #2563eb; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-danger { background: #dc2626; color: #fff; border-color: #dc2626; }
    .btn-danger:hover { background: #b91c1c; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #e5e7eb; text-align: left; padding: 8px 10px; font-size: 13px; vertical-align: middle; }
    th { background: #f9fafb; font-weight: 600; font-size: 12px; color: #374151; }
    tr:hover td { background: #f9fafb; }
    code { font-family: ui-monospace, monospace; font-size: 11px; background: #f3f4f6; padding: 2px 5px; border-radius: 4px; color: #374151; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
    .badge-online { background: #dcfce7; color: #15803d; }
    .badge-offline { background: #f3f4f6; color: #6b7280; }
    .fw-version-pill { display: inline-block; background: #dcfce7; color: #15803d; padding: 3px 10px; border-radius: 20px; font-family: ui-monospace, monospace; font-size: 12px; font-weight: 700; white-space: nowrap; }
    .fw-url { font-size: 11px; color: #6b7280; word-break: break-all; font-family: ui-monospace, monospace; }
    .muted { color: #9ca3af; font-size: 13px; margin: 0; }
    .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
    .toolbar label { font-size: 13px; color: #374151; display: flex; align-items: center; gap: 6px; }
    .deploy-pill { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: #374151; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 5px 12px; }
    .deploy-pill-none { font-size: 13px; color: #9ca3af; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 5px 12px; }
    #status-upload, #status-dispatch { margin-top: 10px; font-size: 13px; min-height: 20px; }
    .msg-ok { color: #15803d; }
    .msg-err { color: #dc2626; }
    .progress { color: #6b7280; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .cfg-row td { background: #f8fafc !important; }
    .cfg-cell { padding: 14px 16px !important; }
    .cfg-grid { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px; }
    .cfg-field { display: flex; flex-direction: column; gap: 2px; }
    .cfg-label { font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; }
    .cfg-val { font-size: 13px; font-family: ui-monospace, monospace; color: #111; }
    .cfg-lines-label { font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
    .cfg-lines { display: flex; flex-direction: column; gap: 4px; }
    .cfg-line { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .cfg-line-tag { background: #dbeafe; color: #1d4ed8; padding: 2px 8px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px; font-weight: 600; }
    .cfg-line-stop { color: #374151; }
    .cfg-line-dir { color: #6b7280; font-size: 12px; }
    .fw-row-selected td { background: #f0fdf4 !important; }
    .desc-cell { max-width: 260px; white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
<div class="wrap">
  <h1>OTA Manager</h1>
  <p class="subtitle">Upload firmware and push over-the-air updates to CommuteLive devices.</p>

  <div class="card">
    <h2>Upload Firmware</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
      <div>
        <div class="field">
          <label>Version (semver &mdash; e.g. 1.2.3)</label>
          <input type="text" id="fw-version" placeholder="1.2.3" />
        </div>
        <div class="field">
          <label>Firmware .bin file</label>
          <input type="file" id="fw-file" accept=".bin" />
        </div>
      </div>
      <div class="field" style="margin:0">
        <label>Description &mdash; what changed in this release?</label>
        <textarea id="fw-description" rows="4" placeholder="e.g. Fixed OTA reconnect loop, improved WiFi stability"></textarea>
      </div>
    </div>
    <button class="btn btn-primary" onclick="uploadFirmware()" style="margin-top:4px">Upload</button>
    <div id="status-upload"></div>
  </div>

  <div class="card">
    <h2>Firmware Releases (${releases.length})</h2>
    <table>
      <thead>
        <tr>
          <th style="width:100px">Version</th>
          <th>Description</th>
          <th style="width:80px">Size</th>
          <th style="width:160px">Released</th>
          <th>URL</th>
          <th style="width:90px"></th>
        </tr>
      </thead>
      <tbody>
        ${releaseRows}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Devices (${allDevices.length})</h2>
    <div class="toolbar">
      ${releases.length ? `<div class="deploy-pill"><span>Deploy:</span> <span id="deploy-version-text" class="fw-version-pill">v${escapeHtml(latestVersion)}</span></div>` : '<div class="deploy-pill-none">No firmware uploaded yet</div>'}
      <label><input type="checkbox" id="select-all" onchange="toggleAll(this.checked)" /> Select all</label>
      <button class="btn btn-primary" onclick="dispatchSelected()">Deploy to Selected</button>
      <button class="btn btn-danger" onclick="dispatchAll()">Deploy to ALL</button>
      <button class="btn" onclick="location.reload()">Refresh</button>
    </div>
    <table>
      <thead>
        <tr>
          <th style="width:36px"></th>
          <th>Device ID</th>
          <th style="width:110px">Firmware</th>
          <th>Last Active</th>
          <th>Status</th>
          <th style="width:80px"></th>
        </tr>
      </thead>
      <tbody>
        ${deviceRows || '<tr><td colspan="6" style="color:#9ca3af;text-align:center;padding:20px">No devices registered.</td></tr>'}
      </tbody>
    </table>
    <div id="status-dispatch"></div>
  </div>
</div>

<script>
  const allFirmware = ${allReleasesJson};
  let currentFirmware = allFirmware[0] ?? null;

  function setStatus(id, cls, msg) {
    const el = document.getElementById(id);
    el.textContent = '';
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = msg;
    el.appendChild(span);
  }

  function selectFirmware(idx) {
    currentFirmware = allFirmware[idx];
    document.querySelectorAll('.fw-row').forEach(function(row, i) {
      row.classList.toggle('fw-row-selected', i === idx);
      var btn = row.querySelector('button');
      if (btn) btn.classList.toggle('btn-primary', i === idx);
    });
    var pill = document.getElementById('deploy-version-text');
    if (pill) pill.textContent = 'v' + currentFirmware.version;
  }

  function toggleAll(checked) {
    document.querySelectorAll('.device-check').forEach(function(cb) { cb.checked = checked; });
  }

  function toggleConfig(rowId, btn) {
    var row = document.getElementById(rowId);
    var visible = row.style.display !== 'none';
    row.style.display = visible ? 'none' : 'table-row';
    btn.textContent = visible ? 'Config' : 'Hide';
  }

  async function uploadFirmware() {
    const version = document.getElementById('fw-version').value.trim();
    const description = document.getElementById('fw-description').value.trim();
    const fileInput = document.getElementById('fw-file');
    const file = fileInput.files[0];

    if (!/^\\d+\\.\\d+\\.\\d+$/.test(version)) {
      setStatus('status-upload', 'msg-err', 'Version must be semver (e.g. 1.2.3).');
      return;
    }
    if (!file) {
      setStatus('status-upload', 'msg-err', 'Select a .bin file first.');
      return;
    }

    setStatus('status-upload', 'progress', 'Uploading ' + (file.size / 1024).toFixed(1) + ' KB\u2026');
    const fd = new FormData();
    fd.append('version', version);
    fd.append('description', description);
    fd.append('firmware', file);

    try {
      const res = await fetch('/admin/ota/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        setStatus('status-upload', 'msg-err', 'Error: ' + (data.error || 'upload failed'));
        return;
      }
      setStatus('status-upload', 'msg-ok', 'Uploaded v' + data.version + ' (' + (data.sizeBytes / 1024).toFixed(1) + ' KB). Reload to see it in the releases table.');
    } catch (e) {
      setStatus('status-upload', 'msg-err', 'Network error: ' + e.message);
    }
  }

  async function dispatch(deviceIds) {
    if (!currentFirmware) {
      setStatus('status-dispatch', 'msg-err', 'No firmware selected. Upload firmware first.');
      return;
    }
    if (deviceIds.length === 0) {
      setStatus('status-dispatch', 'msg-err', 'No devices selected.');
      return;
    }
    setStatus('status-dispatch', 'progress', 'Dispatching v' + currentFirmware.version + ' to ' + deviceIds.length + ' device(s)\u2026');
    try {
      const res = await fetch('/admin/ota/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: deviceIds, url: currentFirmware.url, version: currentFirmware.version })
      });
      const data = await res.json();
      const ok = data.results.filter(function(r) { return r.success; }).length;
      const fail = data.results.filter(function(r) { return !r.success; }).length;

      const statusEl = document.getElementById('status-dispatch');
      statusEl.textContent = '';

      const okSpan = document.createElement('span');
      okSpan.className = 'msg-ok';
      okSpan.textContent = 'Sent v' + currentFirmware.version + ' to ' + ok + ' device(s). ';
      statusEl.appendChild(okSpan);

      if (fail > 0) {
        const failSpan = document.createElement('span');
        failSpan.className = 'msg-err';
        failSpan.textContent = fail + ' failed.';
        statusEl.appendChild(failSpan);
      }
    } catch (e) {
      setStatus('status-dispatch', 'msg-err', 'Network error: ' + e.message);
    }
  }

  function dispatchSelected() {
    const ids = Array.from(document.querySelectorAll('.device-check:checked')).map(function(cb) { return cb.value; });
    dispatch(ids);
  }

  function dispatchAll() {
    const ids = Array.from(document.querySelectorAll('.device-check')).map(function(cb) { return cb.value; });
    const ver = currentFirmware ? currentFirmware.version : '?';
    if (!confirm('Deploy firmware v' + ver + ' to ALL ' + ids.length + ' devices?')) return;
    dispatch(ids);
  }
</script>
</body>
</html>`;

        return c.html(html);
    });
}
