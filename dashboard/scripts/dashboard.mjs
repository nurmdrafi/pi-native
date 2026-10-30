#!/usr/bin/env node
/**
 * Real-time dashboard server over existing pi session logs.
 *
 * Data layer lives in ./data.mjs (pure, unit-tested); this file is the shell:
 *   GET /            single-page UI (dashboard/ build)
 *   GET /api/sessions  full snapshot: sessions + aggregates + active tails
 *   GET /api/session/:id  per-session detail
 *   GET /api/stream    SSE: `snapshot` on each pidx cycle, `live` per new turn
 *
 * Finished sessions come from bin/pidx (incremental, cached under .cache/).
 * Active sessions (which pidx excludes) are found by mtime and tailed here.
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateModelMix,
  aggregateSessions,
  costAlerts,
  createSessionTailer,
  detailFor,
  gateSummary,
  spendSummary,
  summarizeSession,
} from "./data.mjs";
// ── Server shell ─────────────────────────────────────────────


function readGateRules() {
  try {
    const cfg = JSON.parse(readFileSync(GATE_CONFIG, "utf8"));
    return cfg?.rules && typeof cfg.rules === "object" ? cfg.rules : {};
  } catch {
    return {};
  }
}

function runPidx() {
  return new Promise((resolvePromise) => {
    execFile(
      PIDX_BIN,
      ["--sessions-dir", SESSIONS_DIR, "--state", STATE_FILE, "--out", OUT_FILE],
      { timeout: 30_000 },
      (error, _stdout, stderr) => resolvePromise({ ok: !error, stderr: String(stderr).slice(0, 200) }),
    );
  });
}

async function readRawExtracts() {
  if (!existsSync(OUT_FILE)) return [];
  const raw = await readFile(OUT_FILE, "utf8");
  const lines = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // Skip malformed extract lines; the next pidx cycle rewrites the file.
    }
  }
  return lines;
}

async function readExtracts() {
  return (await readRawExtracts()).map(summarizeSession);
}

async function findActiveFiles() {
  const found = [];
  const now = Date.now();
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          const mtime = (await stat(full)).mtimeMs;
          if (now - mtime < ACTIVE_WINDOW_MS) found.push(full);
        } catch {}
      }
    }
  }
  await walk(SESSIONS_DIR);
  return found;
}

const sseClients = new Set();

function broadcast(event, data) {
  for (const res of sseClients) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

let pidxRunning = false;
async function cycle(tailers) {
  if (!pidxRunning) {
    pidxRunning = true;
    const { ok, stderr } = await runPidx();
    pidxRunning = false;
    if (!ok) console.error(`pidx failed: ${stderr}`);
  }

  const activeFiles = await findActiveFiles();
  for (const file of activeFiles) {
    if (!tailers.has(file)) tailers.set(file, createSessionTailer(file));
  }
  const active = [];
  for (const [file, tailer] of tailers) {
    const events = tailer.tick();
    if (events.length > 0) {
      broadcast("live", { file: basename(file), events });
    }
    if (!activeFiles.includes(file)) {
      tailers.delete(file);
      continue;
    }
    active.push({
      file: basename(file),
      path: file,
      project: basename(dirname(file)),
      turns: tailer.turns,
      cost: Number(tailer.cost.toFixed(6)),
    });
  }

  const raw = await readRawExtracts();
  const idByPath = new Map(raw.map((e) => [e.path, e.sessionId]));
  for (const a of active) a.sessionId = idByPath.get(a.path) ?? null;
  const sessions = raw.map(summarizeSession);
  const sessionsAgg = aggregateSessions(sessions);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    sessions: sessions.sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? "")),
    aggregates: {
      ...sessionsAgg,
      modelMix: aggregateModelMix(raw),
      spend: spendSummary(sessions, new Date()),
      alerts: costAlerts(sessions, SESSION_BUDGET),
      gate: gateSummary(sessionsAgg.blocksByFamily, readGateRules(), {
        blocksByTool: sessionsAgg.blocksByTool,
        avoidedSpend: sessionsAgg.avoidedSpend,
      }),
    },
    active,
  };
  broadcast("snapshot", snapshot);
  return snapshot;
}

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>pi sessions</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, monospace; margin: 0; background: #0d1117; color: #c9d1d9; }
  header { padding: 10px 16px; border-bottom: 1px solid #21262d; display: flex; gap: 24px; align-items: baseline; }
  header h1 { font-size: 15px; margin: 0; }
  .stat { font-size: 12px; color: #8b949e; }
  .stat b { color: #c9d1d9; }
  main { display: grid; grid-template-columns: minmax(420px, 1fr) minmax(360px, 1fr); height: calc(100vh - 45px); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid #161b22; white-space: nowrap; }
  th { color: #8b949e; font-weight: normal; position: sticky; top: 0; background: #0d1117; }
  tr:hover, tr.sel { background: #161b22; cursor: pointer; }
  .live { color: #3fb950; }
  #detail { border-left: 1px solid #21262d; padding: 12px 16px; overflow-y: auto; font-size: 12px; }
  #detail h2 { font-size: 13px; margin: 4px 0 10px; word-break: break-all; }
  #detail svg { width: 100%; height: 80px; }
  #feed { margin-top: 14px; border-top: 1px solid #21262d; padding-top: 8px; }
  #feed div { padding: 2px 0; color: #8b949e; }
  .bar { fill: #58a6ff; }
  .num { text-align: right; }
</style></head><body>
<header>
  <h1>pi sessions</h1>
  <span class="stat" id="totals"></span>
  <span class="stat live" id="conn">connecting…</span>
</header>
<main>
  <div style="overflow-y:auto"><table id="tbl"><thead><tr>
    <th>session</th><th>project</th><th>model(s)</th><th class="num">turns</th><th class="num">cost</th><th>last</th>
  </tr></thead><tbody></tbody></table></div>
  <div id="detail"><h2>select a session</h2><div id="feed"></div></div>
</main>
<script>
let snapshot = null, selected = null;
const fmtCost = (c) => '$' + c.toFixed(3);
const ago = (ts) => { if (!ts) return '-'; const s = (Date.now() - new Date(ts)) / 1000;
  return s < 60 ? s.toFixed(0) + 's' : s < 3600 ? (s/60).toFixed(0) + 'm' : (s/3600).toFixed(1) + 'h'; };
function render() {
  if (!snapshot) return;
  const tb = document.querySelector('#tbl tbody');
  const activeFiles = new Set(snapshot.active.map(a => a.file));
  tb.innerHTML = snapshot.sessions.map(s => {
    const file = (s.path || '').split('/').pop();
    const live = activeFiles.has(file);
    return '<tr data-id="' + s.sessionId + '" class="' + (selected === s.sessionId ? 'sel' : '') + '">' +
      '<td>' + (live ? '<span class="live">●</span> ' : '') + s.sessionId.slice(0, 12) + '</td>' +
      '<td title="' + s.project + '">' + (s.project || '').split('/').pop().slice(0, 24) + '</td>' +
      '<td>' + s.models.join(',') + '</td>' +
      '<td class="num">' + s.turns + '</td>' +
      '<td class="num">' + fmtCost(s.cost) + '</td>' +
      '<td>' + ago(s.lastTs) + '</td></tr>';
  }).join('');
  document.getElementById('totals').innerHTML =
    '<b>' + snapshot.aggregates.totals.sessions + '</b> sessions · <b>' +
    snapshot.aggregates.totals.turns + '</b> turns · <b>' + fmtCost(snapshot.aggregates.totals.cost) + '</b> · <b>' +
    snapshot.aggregates.totals.toolCalls + '</b> tool calls';
  document.querySelectorAll('#tbl tbody tr').forEach(tr =>
    tr.onclick = () => { selected = tr.dataset.id; renderDetail(); render(); });
  if (selected) renderDetail();
}
function renderDetail() {
  const s = snapshot.sessions.find(x => x.sessionId === selected);
  if (!s) return;
  const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1])
    .map(([n, c]) => n + '×' + c).join('  ') || 'none';
  document.querySelector('#detail h2').textContent = s.project + ' — ' + s.sessionId;
  const turns = [];
  for (const s2 of [s]) {} // placeholder to keep scoping simple
  document.getElementById('feed').innerHTML =
    '<div>turns <b>' + s.turns + '</b> · cost <b>' + fmtCost(s.cost) + '</b> · tools: ' + tools + '</div>';
}
const es = new EventSource('/api/stream');
es.addEventListener('snapshot', (e) => { snapshot = JSON.parse(e.data); render(); });
es.addEventListener('live', (e) => {
  const d = JSON.parse(e.data);
  const feed = document.getElementById('feed');
  for (const ev of d.events.slice(-3)) {
    const div = document.createElement('div');
    div.textContent = new Date().toISOString().slice(11, 19) + ' ' + d.file.slice(0, 20) +
      (ev.model ? ' ' + ev.model : '') + (ev.cost ? ' +' + fmtCost(ev.cost) : '');
    feed.prepend(div);
  }
  while (feed.children.length > 30) feed.lastChild.remove();
});
es.onopen = () => document.getElementById('conn').textContent = 'live';
es.onerror = () => document.getElementById('conn').textContent = 'reconnecting…';
</script></body></html>`;

async function main() {
  const tailers = new Map();
  const PORT = process.env.PORT || 8989;

  const server = createServer(async (req, res) => {
    if (req.url === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(":ok\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (req.url?.startsWith("/api/session/")) {
      const id = decodeURIComponent(req.url.slice("/api/session/".length));
      const raw = (await readRawExtracts()).find((e) => e.sessionId === id);
      if (!raw) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "session not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(detailFor(raw)));
      return;
    }
    if (req.url === "/api/sessions") {
      const snapshot = await cycle(tailers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (req.url === "/" || req.url?.startsWith("/assets/")) {
      const DASH_DIST = join(REPO_ROOT, "dashboard", "dist");
      const rel = req.url === "/" ? "index.html" : req.url.slice(1);
      const file = join(DASH_DIST, rel);
      if (existsSync(file)) {
        const mime =
          { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" }[
            file.slice(file.lastIndexOf("."))
          ] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": mime });
        res.end(await readFile(file));
        return;
      }
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(HTML);
        return;
      }
    }
    res.writeHead(404).end();
  });

  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  console.log(`dashboard: http://127.0.0.1:${PORT} (sessions: ${SESSIONS_DIR})`);
  await cycle(tailers);
  setInterval(() => {
    cycle(tailers).catch((err) => console.error("cycle failed:", err?.message));
  }, POLL_MS);
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
