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
  localDayKey,
  sessionRangeView,
  spendSummary,
  summarizeSession,
} from "./data.mjs";
// ── Config (defaults are the README environment table) ──────
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** pidx binary the snapshot is built with (`npm run bootstrap` installs it). */
const PIDX_BIN = join(REPO_ROOT, "bin", "pidx");
/** pi's session tree; pidx leaves a session out while it is still being written. */
const SESSIONS_DIR =
  process.env.PI_DASH_SESSIONS_DIR ||
  join(process.env.HOME ?? "", ".pi", "agent", "sessions");
/** Cache files under the repo's gitignored `.cache/`, so runs stay incremental. */
const STATE_FILE = join(REPO_ROOT, ".cache", "dashboard-pidx-state.bin");
const OUT_FILE = join(REPO_ROOT, ".cache", "dashboard-extracts.jsonl");
const GATE_CONFIG = join(REPO_ROOT, "extensions", "permission-gate", "config.json");
/** Per-session cost budget in USD for alerts; 0 (the default) disables them. */
const SESSION_BUDGET = Number(process.env.PI_DASH_SESSION_BUDGET ?? 0) || 0;
/** Snapshot refresh cadence. */
const POLL_MS = 5_000;
/** Wall-clock start of this server process, shown in the header so a process
 * running older code than the checkout is visible at a glance — server
 * modules load once at start and never reload. */
const SERVER_STARTED_AT = new Date().toISOString();
/** A session file touched within this window is active and tailed live. */
const ACTIVE_WINDOW_MS = 5 * 60_000;
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

/** Open SSE responses with the date window they asked for; a null bound means
 * unbounded, so the default client sees the whole history. */
const sseClients = new Map();

function broadcast(event, data) {
  for (const res of sseClients.keys()) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

/** Date window from a query string; absent or unparsable bounds mean "all". */
function parseRange(url) {
  try {
    const u = new URL(url, "http://127.0.0.1");
    const iso = (v) => {
      if (!v) return null;
      const t = Date.parse(v);
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    };
    const from = iso(u.searchParams.get("from"));
    const to = iso(u.searchParams.get("to"));
    return { from, to };
  } catch {
    return { from: null, to: null };
  }
}

const rangeKey = (r) => `${r.from ?? ""}|${r.to ?? ""}`;

const inRange = (ts, range) => {
  if (!range.from && !range.to) return true;
  if (!ts) return false;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  if (range.from && t < Date.parse(range.from)) return false;
  if (range.to && t > Date.parse(range.to)) return false;
  return true;
};

/** One snapshot for one date window: the session list, every aggregate and the
 * gate rollup are recomputed from the filtered sessions, so a range selection
 * changes the numbers rather than just the table. Cost, turns and tool
 * traffic are attributed to the turns/calls inside the window — a session
 * merely touched by the window contributes only that in-window activity. */
export function snapshotFor(base, range) {
  const sessions = base.sessions.filter((s) => inRange(s.lastTs ?? s.firstTs, range));
  const keepIds = new Set(sessions.map((s) => s.sessionId));
  const raw = base.raw.filter((e) => keepIds.has(e.sessionId));
  const extractById = new Map(raw.map((e) => [e.sessionId, e]));
  const fromMs = range.from ? Date.parse(range.from) : null;
  const toMs = range.to ? Date.parse(range.to) : null;
  // Window-clipped copies of the session summaries: the client's per-session
  // rollups (the tools chart) read these objects directly.
  const views = sessions.map((s) => sessionRangeView(s, extractById.get(s.sessionId), fromMs, toMs));
  const agg = aggregateSessions(views, {
    fromDay: range.from ? localDayKey(range.from) : null,
    toDay: range.to ? localDayKey(range.to) : null,
    raw,
    from: fromMs,
    to: toMs,
  });
  return {
    generatedAt: base.generatedAt,
    serverStartedAt: SERVER_STARTED_AT,
    range,
    sessions: views.slice().sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? "")),
    aggregates: {
      ...agg,
      modelMix: aggregateModelMix(raw, fromMs, toMs),
      spend: spendSummary(views, new Date(), { raw, from: fromMs, to: toMs }),
      alerts: costAlerts(sessions, SESSION_BUDGET),
      gate: gateSummary(agg.blocksByFamily, readGateRules(), {
        blocksByTool: agg.blocksByTool,
        avoidedSpend: agg.avoidedSpend,
        gateTags: agg.gateTags,
        gateByDay: agg.gateByDay,
        toolAvgCost: agg.toolAvgCost,
        globalAvgCost: agg.globalAvgCost,
      }),
    },
    active: base.active,
  };
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
  // Active files are absent from the extracts (pidx skips sessions still being
  // written), so the project comes from a closed sibling in the same directory.
  const projectByDir = new Map(raw.map((e) => [dirname(e.path), e.project]));
  for (const a of active) {
    a.sessionId = idByPath.get(a.path) ?? null;
    a.project = projectByDir.get(dirname(a.path)) ?? a.project;
  }
  const sessions = raw.map(summarizeSession);
  const base = { raw, sessions, active, generatedAt: new Date().toISOString() };
  // One snapshot per distinct date window among the open streams: the window
  // is client state, so the payload cannot be shared.
  const byRange = new Map([[rangeKey({ from: null, to: null }), { from: null, to: null }]]);
  for (const range of sseClients.values()) byRange.set(rangeKey(range), range);
  const built = new Map();
  for (const [key, range] of byRange) built.set(key, snapshotFor(base, range));
  for (const [res, range] of sseClients) {
    const snapshot = built.get(rangeKey(range));
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  }
  return base;
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
  const PORT = Number(process.env.PI_DASH_PORT ?? 8787);

  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/api/stream")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(":ok\n\n");
      sseClients.set(res, parseRange(req.url));
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
    if (req.url?.startsWith("/api/sessions")) {
      const base = await cycle(tailers);
      const snapshot = snapshotFor(base, parseRange(req.url));
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
        // The entry document must revalidate every load or a rebuild is
        // invisible to a normal reload; hashed asset names can cache forever.
        const cache =
          req.url === "/" ? "no-cache" : "public, max-age=31536000, immutable";
        res.writeHead(200, { "content-type": mime, "cache-control": cache });
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
  // Log the port the OS actually bound: PI_DASH_PORT=0 asks for a free one.
  const bound = server.address()?.port ?? PORT;
  console.log(`dashboard: http://127.0.0.1:${bound} (sessions: ${SESSIONS_DIR})`);
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
