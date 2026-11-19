#!/usr/bin/env node
/**
 * Harness-watch (2026-11-19) — the feedback loop for the WHOLE harness, not
 * just the gate. Deterministic half: harvest every error/warn source, map to
 * a stable id, classify, and keep append-only ledgers so the fixing half
 * (prompts/harness-watch.md, run in a session) always works from evidence:
 *
 *   sources
 *     gate      permission-gate blocks/warns from session logs
 *     tool      non-gate tool failures (recurring shape = call-rule gap)
 *     lesson    new records in lessons/harness.ndjson (an incident unactioned)
 *     suite     test failures from --suite-log FILE or --with-suite
 *
 *   ledgers (~/.pi/agent/.cache/harness-watch/, append-only NDJSON)
 *     events.ndjson  one record per event (deduped gate events by session+call)
 *     tasks.ndjson   one record per task state change (latest per key wins)
 *     metrics.ndjson one record per run per source:id:kind
 *     state.json     cursors — session files (mtime) and lessons (ts)
 *
 *   classification (condition → class → prompt action)
 *     gate block on read-only head ............ misfire   regression test + judge fix
 *     gate block on doc-mandated shape ........ contradiction carve gate or fix doc + canary
 *     any source, same id+shape ≥3 events .... rule-gap   invariant line in the tool rules
 *     new lesson record ....................... lesson    fix/doc/test that retires it
 *     suite failure ........................... test-fail suite green closes it
 *     everything else ......................... watch     tracked, no task
 *
 * The script never edits code, docs, or git — judgement, TDD, and the revert
 * policy live in the prompt. NDJSON per AGENTS.md; command text is reduced
 * to a <=64c head so secrets never persist.
 *
 * Usage: node scripts/harness-watch.mjs [--sessions DIR] [--home DIR]
 *          [--suite-log FILE] [--with-suite] [--json]
 * Cron:  17 * * * * cd "$HOME/.pi/agent" && node scripts/harness-watch.mjs --with-suite >> "$HOME/.pi/agent/.cache/harness-watch/cron.log" 2>&1
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isGateBlockText } from "../tests/gate/gate-labels.mjs";

/** Gate rule-id map — the label prefix a reason starts with → its config id.
 * Single home for the harness; the authoritative table is config.json docs. */
const RULE_IDS = [
  [/^Permission Gate \(Destructive\)/, "H2"],
  [/^Permission Gate \(Control plane\)/, "H2"],
  [/^Anchor Guard/, "AG"],
  [/^Token Economy \(Re-read\)/, "R1"],
  [/^Token Economy \(Re-run\)/, "R10"],
  [/^Token Economy \(Batching\)/, "TE1"],
  [/^Token Economy/, "TE"],
  [/^Locate-first/, "R1c"],
  [/^Hygiene \(Reader-bypass\)/, "SE2"],
  [/^Hygiene \(Error-swallow\)/, "SE1"],
  [/^Hygiene \(native read\)/, "P1"],
  [/^Hygiene \(native bash\)/, "P2"],
  [/^Hygiene \(native write\)/, "P3"],
  [/^Hygiene \(view credit\)/, "VC"],
  [/^Search \(scope\)/, "SS1"],
  [/^Search \(Mid-pipe\)/, "SS2"],
  [/^Search \(fd-first\)/, "SS3"],
  [/^Search \(rg -r\)/, "SS4"],
  [/^Search \(rg -P\)|^Search \(portability\)/, "PB1"],
  [/^Toolchain/, "TC"],
  [/^Commitlint|^Commit Message/, "R9"],
  [/^Loop Guard/, "LG1"],
  [/^Bash cap/, "H1"],
  [/^Output scrub/, "OS"],
  [/^Phase/, "PH1"],
  [/^Cadence/, "CN"],
];
export const ruleIdOf = (reason) => RULE_IDS.find(([re]) => re.test(reason))?.[1] ?? "other";

/** Read-only command heads — a gate confirm block on one of these is a
 * misfire suspect by definition (nothing here mutates). Extend from
 * evidence, one line per incident class. */
const BENIGN_HEADS = {
  H2: /^(?:rg|grep|fd|ls|find|wc|jq|sed -n|awk|cat|head|tail|printf|echo|git (?:status|log|diff|show|ls-files)|node --version|npm (?:run |ls |view ))\b/,
  SE2: /^tail -c 1\b/,
};

/** Docs corpus the contradiction check scans — every surface the model
 * reads before acting must agree with the gate (AGENTS.md invariant). */
const DOC_FILES = ["AGENTS.md", "SYSTEM.md", "agents/scout.md"];

/** Prohibition markers — a docs line naming a shape inside a prohibition
 * ("never open files", "only trim output") is the docs and the gate
 * agreeing; a contradiction needs a line that directs the agent to run it. */
const PROHIBITION = /\b(never|only|don'?t|forbidden|avoid|instead|rather)\b/i;
const docsMandate = (docsText, toks) => {
  const lit = "`" + toks + "`";
  return docsText.split("\n").some((l) => l.includes(lit) && !PROHIBITION.test(l));
};

const SHAPE_LEN = 64;
const shapeOf = (arg) => String(arg ?? "").trim().split(/\s+/).slice(0, 8).join(" ").slice(0, SHAPE_LEN);
const head = (s, n) => String(s ?? "").split("\n")[0].slice(0, n);

/** Tools retired by owner decision — their failures are dead signal, not
 * recurrence evidence; harvesting them would reopen noise forever. */
const RETIRED_TOOLS = new Set(["codemode"]);

/** Parse one session JSONL into gate events + plain tool failures (pure).
 * A gate block is an isError result led by a gate label; a warn is a
 * non-error result led by one (the note rides normal output); everything
 * else that errors is a tool failure for the recurrence classifier. */
export function parseSession(text, session, fileTs) {
  const calls = new Map();
  const results = [];
  for (const line of text.split("\n")) {
    if (!/toolCall|toolResult/.test(line)) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = rec.message;
    if (!msg) continue;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "toolCall")
          calls.set(b.id, { name: b.name, arg: b.arguments?.command ?? b.arguments?.path ?? "" });
      }
    } else if (msg.role === "toolResult") {
      results.push({
        id: msg.toolCallId,
        tool: msg.toolName,
        isError: msg.isError === true,
        text: (msg.content ?? []).map((b) => b.text ?? "").join("\n"),
        arg: calls.get(msg.toolCallId)?.arg ?? "",
      });
    }
  }
  const gate = [];
  const fails = [];
  results.forEach((r, i) => {
    if (RETIRED_TOOLS.has(r.tool)) return;
    const first = head(r.text, 120);
    if (isGateBlockText(first)) {
      const kind = r.isError ? "block" : "warn";
      const key = `${r.tool}:${head(r.arg, 40)}`;
      let recovered = false;
      if (kind === "block") {
        for (let j = i + 1; j <= i + 3 && j < results.length; j++) {
          const nxt = results[j];
          if (!nxt.isError && `${nxt.tool}:${head(nxt.arg, 40)}` === key) { recovered = true; break; }
        }
      }
      gate.push({ ts: fileTs, session, callId: r.id, tool: r.tool, id: ruleIdOf(first), kind, reason: first, shape: shapeOf(r.arg), recovered });
    } else if (r.isError) {
      fails.push({ ts: fileTs, session, callId: r.id, tool: r.tool, id: r.tool, kind: "fail", reason: first, shape: shapeOf(r.arg) });
    }
  });
  return { gate, fails };
}

/** Parse a node --test output log into suite failure events (pure). */
export function parseSuiteLog(text, ts) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^✖ (.+?)(?:\s+\([\d.]+m?s\))?$/.exec(line.trim()) ?? /^not ok \d+ - (.+)$/.exec(line.trim());
    if (m) out.push({ ts, source: "suite", id: m[1].slice(0, 80), kind: "fail", reason: "test failure", shape: m[1].slice(0, SHAPE_LEN) });
  }
  return out;
}

/** Classify one event against the docs corpus and its own history (pure). */
export function classify(event, docsText, history) {
  if (event.source === "lesson") return "lesson";
  if (event.source === "suite") return "test-fail";
  if (event.source === "gate" || event.source === undefined) {
    const benign = BENIGN_HEADS[event.id];
    if (event.kind === "block" && benign?.test(event.shape)) return "misfire";
    if (event.kind === "block") {
      const toks = event.shape.split(/\s+/).slice(0, 2).join(" ");
      if (toks && docsMandate(docsText, toks)) return "contradiction";
    }
  }
  const key = `${event.id}|${event.shape}`;
  const n = history.filter((e) => `${e.id}|${e.shape}` === key).length + 1;
  return n >= 3 ? "rule-gap" : "watch";
}

/** Fold new events into the task ledger (pure). Latest record per key wins
 * on replay; open tasks accumulate counts, fixed tasks reopen on recurrence. */
export function updateTasks(prevTasks, newEvents, docsText, historyBefore) {
  const latest = new Map();
  for (const t of prevTasks) latest.set(t.key, t);
  const history = [...historyBefore];
  const out = [];
  for (const ev of newEvents) {
    const cls = classify(ev, docsText, history);
    history.push(ev);
    if (cls === "watch") continue; // first-seen — tracked in events, no task
    const key = `${cls}:${ev.source ?? "gate"}:${ev.id}:${ev.shape}`;
    const cur = latest.get(key);
    if (cur && cur.status !== "reverted") {
      const rec = { ...cur, count: cur.count + 1, lastTs: ev.ts, status: cur.status === "fixed" ? "open" : cur.status };
      latest.set(key, rec);
      out.push(rec);
    } else {
      const rec = { ts: ev.ts, lastTs: ev.ts, key, class: cls, source: ev.source ?? "gate", id: ev.id, shape: ev.shape, count: 1, status: "open" };
      latest.set(key, rec);
      out.push(rec);
    }
  }
  return { records: out, tasks: [...latest.values()] };
}

const readNdjson = (file) =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

/** Fold an append-only task ledger: the ledger grows one record per
 * harvest, so raw reads see every historical count as a separate task.
 * Latest record per key wins — the same rule the repair loop reads by. */
export const foldTasks = (records) => {
  const latest = new Map();
  for (const t of records) latest.set(t.key, t);
  return [...latest.values()];
};

const appendNdjson = (file, records) => {
  if (!records.length) return;
  mkdirSync(join(file, ".."), { recursive: true });
  appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
};

export function summarize(events, tasks) {
  const byKey = {};
  for (const e of events) {
    const k = `${e.source ?? "gate"}:${e.id}:${e.kind}`;
    byKey[k] = (byKey[k] ?? 0) + 1;
  }
  const open = tasks.filter((t) => t.status === "open");
  const top = [...tasks].sort((a, b) => b.count - a.count).slice(0, 8);
  return { events: events.length, byId: byKey, open: open.length, openTasks: open, topRecurrence: top };
}

/** Health snapshot from the ledgers alone (no harvest) — the "report"
 * command: open tasks by class, top recurrence, newest incidents. */
export function healthFrom(events, tasks) {
  const s = summarize(events, foldTasks(tasks));
  const byClass = {};
  for (const t of s.openTasks) byClass[t.class] = (byClass[t.class] ?? 0) + 1;
  // rule-gap rollup: per-path keys fan one behavior out into many tasks;
  // by-rule totals restore the one-behavior-one-line view for triage.
  const gap = {};
  for (const t of s.openTasks) if (t.class === "rule-gap") {
    gap[t.id] ??= { id: t.id, tasks: 0, events: 0 };
    gap[t.id].tasks += 1; gap[t.id].events += t.count;
  }
  const ruleGapById = Object.values(gap).sort((a, b) => b.events - a.events);
  const last = events.slice(-5).map((e) => `${e.ts} ${e.source}:${e.id} ${String(e.reason).slice(0, 60)}`);
  return { ...s, byClass, ruleGapById, lastIncidents: last };
}

/** Nightly gate:eval invocation — the eval persists its metrics (eval:<name>
 * keys) via GATE_EVAL_METRICS into the harvested ledger, so the series rides
 * the same --home the daemon watches instead of the homedir default. */
export const evalSpawn = (home, stateDir) => ({
  file: process.execPath,
  args: [join(home, "tests/gate/eval/run.mjs")],
  env: { GATE_EVAL_METRICS: join(stateDir, "metrics.ndjson") },
});

async function main(passed = process.argv.slice(2)) {
  const argv = passed;
  const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = arg("home", process.env.PGATE_HOME ?? join(homedir(), ".pi/agent"));
  const sessionsDir = arg("sessions", join(home, "sessions"));
  const stateDir = join(home, ".cache/harness-watch");
  const asJson = argv.includes("--json");

  const docsText = DOC_FILES.map((f) => { try { return readFileSync(join(home, f), "utf8"); } catch { return ""; } }).join("\n");

  const stateFile = join(stateDir, "state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { processed: {}, lessonsTs: "" };
  const eventsFile = join(stateDir, "events.ndjson");
  const tasksFile = join(stateDir, "tasks.ndjson");
  const metricsFile = join(stateDir, "metrics.ndjson");

  const priorEvents = readNdjson(eventsFile);
  const seen = new Set(priorEvents.filter((e) => e.source !== "lesson" && e.source !== "suite").map((e) => `${e.session}|${e.callId}`));
  const priorTasks = readNdjson(tasksFile);

  // -- sessions: gate + tool-fail collectors
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) files.push(p);
    }
  };
  const newEvents = [];
  try { walk(sessionsDir); } catch { console.error(`no sessions dir: ${sessionsDir}`); process.exit(1); }
  for (const f of files) {
    const mtimeMs = statSync(f).mtimeMs;
    const name = f.slice(sessionsDir.length + 1);
    if (state.processed[name] === mtimeMs) continue;
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    const { gate, fails } = parseSession(text, name, new Date(mtimeMs).toISOString());
    for (const ev of gate) if (!seen.has(`${ev.session}|${ev.callId}`)) { ev.source = "gate"; newEvents.push(ev); }
    for (const ev of fails) if (!seen.has(`${ev.session}|${ev.callId}`)) { ev.source = "tool"; newEvents.push(ev); }
    state.processed[name] = mtimeMs;
  }

  // -- lessons collector: records newer than the cursor are open incidents
  const runTs = new Date().toISOString();
  const lessonsFile = join(home, "lessons/harness.ndjson");
  for (const l of readNdjson(lessonsFile)) {
    if (!l.ts || l.ts <= state.lessonsTs) continue;
    newEvents.push({ ts: l.ts, source: "lesson", id: `lesson:${l.source ?? "unknown"}`, kind: "incident", reason: head(l.lesson, 120), shape: shapeOf(l.lesson), session: l.session_id ?? "" });
  }
  const newestLesson = readNdjson(lessonsFile).filter((l) => l.ts).map((l) => l.ts).sort().pop();
  if (newestLesson) state.lessonsTs = newestLesson;

  // -- suite collector: from a log file or a live run
  if (argv.includes("--suite-log")) {
    for (const ev of parseSuiteLog(readFileSync(arg("suite-log", "/dev/null"), "utf8"), runTs)) newEvents.push(ev);
  } else if (argv.includes("--with-suite")) {
    try {
      const out = execFileSync("node", ["--test", "tests/**/*.test.mjs", "dashboard/tests/**/*.test.mjs"], { cwd: home, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
      for (const ev of parseSuiteLog(out, runTs)) newEvents.push(ev);
    } catch (err) {
      for (const ev of parseSuiteLog(String(err.stdout ?? ""), runTs)) newEvents.push(ev);
      if (!newEvents.some((e) => e.source === "suite"))
        newEvents.push({ ts: runTs, source: "suite", id: "suite:run", kind: "fail", reason: head(err.message, 120), shape: "suite run crashed" });
    }
    const ev = evalSpawn(home, stateDir);
    try {
      const out = execFileSync(ev.file, ev.args, { cwd: home, encoding: "utf8", timeout: 600_000, env: { ...process.env, ...ev.env }, stdio: ["ignore", "pipe", "pipe"] });
      console.log(out.trim());
    } catch (err) {
      console.error(`gate:eval failed: ${head(String(err?.message ?? err), 120)}`);
      if (err?.stdout) console.log(String(err.stdout).trim());
    }
  }

  const { records, tasks } = updateTasks(priorTasks, newEvents, docsText, priorEvents);
  appendNdjson(eventsFile, newEvents);
  appendNdjson(tasksFile, records);
  const counts = {};
  for (const e of newEvents) {
    const k = `${e.source ?? "gate"}:${e.id}:${e.kind}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  appendNdjson(metricsFile, Object.entries(counts).map(([k, n]) => ({ ts: runTs, key: k, n })));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state));

  const summary = summarize(newEvents, tasks);
  summary.newEvents = newEvents.length;
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`harness-watch ${runTs} — ${summary.newEvents} new events`);
    for (const [k, n] of Object.entries(summary.byId)) console.log(`  ${k.padEnd(20)} ${n}`);
    if (summary.openTasks.length) {
      console.log(`open tasks (${summary.openTasks.length}):`);
      for (const t of summary.openTasks.slice(0, 20)) console.log(`  [${t.class}] ${t.source}:${t.id} x${t.count}  ${t.shape.slice(0, 50)}`);
    } else console.log("no open tasks");
    console.log(`ledgers: ${stateDir}`);
  }
}

async function printStatus(home, asJson) {
  const stateDir = join(home, ".cache/harness-watch");
  const events = readNdjson(join(stateDir, "events.ndjson"));
  const tasks = readNdjson(join(stateDir, "tasks.ndjson"));
  const h = healthFrom(events, tasks);
  if (asJson) return console.log(JSON.stringify(h, null, 2));
  console.log(`harness-watch status — ${h.events} events tracked, ${h.open} open tasks`);
  for (const [k, n] of Object.entries(h.byClass)) console.log(`  ${k.padEnd(14)} ${n}`);
  if (h.ruleGapById?.length) {
    console.log("  rule-gap by rule (events/tasks):");
    for (const g of h.ruleGapById.slice(0, 6)) console.log(`    ${g.id.padEnd(6)} ${g.events}/${g.tasks}`);
  }
  for (const t of h.topRecurrence.slice(0, 5)) console.log(`  recur ${t.source}:${t.id} x${t.count}  ${String(t.shape).slice(0, 50)}`);
  for (const l of h.lastIncidents) console.log(`  last ${l}`);
}

/** Daemon mode — the always-on sentinel: fs.watch on the sessions tree and
 * the lessons log, a 2 s debounce, then an incremental harvest. Every
 * summary line lands in the cron log, so the queue is fresh within seconds
 * of any incident; the repair session (/harness-watch) is one command away. */
async function daemon(home, sessionsDir) {
  const { watch } = await import("node:fs");
  let timer = null;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await main(["--home", home, "--sessions", sessionsDir]); }
      catch (e) { console.error(`harvest failed: ${e.message}`); }
    }, 2000);
  };
  try { watch(sessionsDir, { recursive: true }, kick); } catch (e) { console.error(`watch failed: ${e.message}`); process.exit(1); }
  try { watch(join(home, "lessons"), { recursive: true }, kick); } catch { /* lessons dir optional */ }
  kick(); // prime the ledgers at startup
  console.log(`harness-watch daemon — watching ${sessionsDir} (Ctrl-C to stop)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const argOf = (n, d) => { const i = a.indexOf(`--${n}`); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const home = argOf("home", process.env.PGATE_HOME ?? join(homedir(), ".pi/agent"));
  if (a.includes("--status")) await printStatus(home, a.includes("--json"));
  else if (a.includes("--daemon")) await daemon(home, argOf("sessions", join(home, "sessions")));
  else await main();
}
