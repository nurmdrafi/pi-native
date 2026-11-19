/** Harness-watch tests (2026-11-19): the deterministic half of the full-
 * harness feedback loop — session extraction (gate + tool fails), suite-log
 * parsing, classification across sources, task folding, and an end-to-end
 * CLI pass with cursor/dedup on a fixture sessions tree.
 * Run: node --test tests/tools/harness-watch.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSession, parseSuiteLog, classify, updateTasks, summarize, healthFrom, foldTasks, evalSpawn } from "../../scripts/harness-watch.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const call = (id, command) =>
  JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id, name: "pibash", arguments: { command } }] } });
const result = (id, text, isError) =>
  JSON.stringify({ message: { role: "toolResult", toolCallId: id, toolName: "pibash", isError, content: [{ type: "text", text }] } });

const SESSION = [
  call("c1", "rg -o '\"text\":\"(x|Bash y)' f.jsonl"),
  result("c1", "Permission Gate (Destructive): 'rg …' mutates files, deps, or history and needs approval", true),
  call("c2", "tail -c 1 /tmp/ledger.ndjson"),
  result("c2", "Hygiene (Reader-bypass): read windows with piread", true),
  call("c3", "tail -c 1 /tmp/ledger.ndjson"),
  result("c3", "ok", false), // same shape retried clean → recovery
  call("c4", "rg -rn foo src/"),
  result("c4", "Search (rg -r): '-r' is rg's --replace, not recursion", false), // warn
  call("c5", "ls nope"),
  result("c5", "ls: nope: No such file or directory", true), // plain tool failure
  call("c6", "ls nope"),
  result("c6", "ls: nope: No such file or directory", true),
].join("\n");

test("parseSession: gate events with ids/kinds/recovery, tool fails separate, non-errors ignored", () => {
  const { gate, fails } = parseSession(SESSION, "s.jsonl", "2026-11-19T00:00:00Z");
  assert.equal(gate.length, 3);
  const [h2, se2, ss4] = gate;
  assert.equal(h2.id, "H2"); assert.equal(h2.kind, "block"); assert.equal(h2.recovered, false);
  assert.equal(se2.id, "SE2"); assert.equal(se2.recovered, true);
  assert.equal(ss4.id, "SS4"); assert.equal(ss4.kind, "warn");
  assert.equal(fails.length, 2);
  assert.equal(fails[0].tool, "pibash"); assert.match(fails[0].shape, /^ls nope/);
});

test("parseSuiteLog: node --test failure lines become suite events", () => {
  const ev = parseSuiteLog("✔ passing\n✖ tests/parity/x.test.mjs (1.2s)\n✖ gate: protected-path blocks\n", "T");
  assert.equal(ev.length, 2);
  assert.equal(ev[0].source, "suite"); assert.equal(ev[0].kind, "fail");
});

const DOCS = "guard with `tail -c 1` and `jq -r` under the bound";

test("classify: benign head → misfire; docs shape → contradiction; recurrence ≥3 → rule-gap; lesson/suite direct", () => {
  assert.equal(classify({ source: "gate", id: "H2", kind: "block", shape: "rg -o x f" }, DOCS, []), "misfire");
  assert.equal(classify({ source: "gate", id: "SE2", kind: "block", shape: "jq -r '.x' big.json" }, DOCS, []), "contradiction");
  const hist2 = [{ id: "SS4", shape: "rg -rn foo src/" }, { id: "SS4", shape: "rg -rn foo src/" }];
  assert.equal(classify({ source: "gate", id: "SS4", kind: "warn", shape: "rg -rn foo src/" }, DOCS, hist2), "rule-gap");
  assert.equal(classify({ source: "gate", id: "SS4", kind: "warn", shape: "rg -rn foo src/" }, DOCS, hist2.slice(0, 1)), "watch");
  assert.equal(classify({ source: "tool", id: "pibash", kind: "fail", shape: "ls nope" }, DOCS, hist2.concat([{ id: "pibash", shape: "ls nope" }, { id: "pibash", shape: "ls nope" }])), "rule-gap");
  assert.equal(classify({ source: "lesson", id: "lesson:gate", kind: "incident" }, DOCS, []), "lesson");
  assert.equal(classify({ source: "suite", id: "x.test.mjs", kind: "fail" }, DOCS, []), "test-fail");
});

test("updateTasks opens tasks per class, folds recurrence, reopens fixed on repeat", () => {
  const { gate, fails } = parseSession(SESSION, "s.jsonl", "2026-11-19T00:00:00Z");
  const ev = [...gate, ...fails].map((e) => ({ ...e, source: e.source ?? (e.kind === "fail" && !e.reason.startsWith("Permission") && !/^(Hygiene|Search|Anchor|Token)/.test(e.reason) ? "tool" : "gate") }));
  // simpler: tag explicitly
  for (const e of ev) if (e.kind === "fail") e.source = "tool"; else e.source = "gate";
  const first = updateTasks([], ev, DOCS, []);
  const mis = first.tasks.find((t) => t.class === "misfire");
  assert.ok(mis, "H2 misfire task opens");
  const again = updateTasks(first.tasks, [{ ...ev[0], callId: "c9" }], DOCS, ev);
  assert.equal(again.tasks.find((t) => t.key === mis.key).count, 2);
  const reopened = updateTasks([{ ...mis, status: "fixed", commit: "abc" }], [{ ...ev[0], callId: "c9" }], DOCS, []);
  assert.equal(reopened.tasks.find((t) => t.key === mis.key).status, "open");
});

test("summarize counts per source:id:kind and lists open tasks", () => {
  const { gate, fails } = parseSession(SESSION, "s.jsonl", "2026-11-19T00:00:00Z");
  const ev = [...gate.map((e) => ({ ...e, source: "gate" })), ...fails.map((e) => ({ ...e, source: "tool" }))];
  const { tasks } = updateTasks([], ev, DOCS, []);
  const s = summarize(ev, tasks);
  assert.equal(s.events, 5);
  assert.equal(s.byId["gate:H2:block"], 1);
  assert.equal(s.byId["tool:pibash:fail"], 2);
});

test("healthFrom/foldTasks: append-only task ledger folds — latest record per key wins", () => {
  const rec = (count, status = "open") => ({ ts: "T1", lastTs: "T2", key: "rule-gap:tool:codemode:", class: "rule-gap", source: "tool", id: "codemode", shape: "", count, status });
  const events = [{ ts: "T3", source: "tool", id: "codemode", kind: "fail", reason: "Script failed" }];
  const h = healthFrom(events, [rec(1), rec(2), rec(3), rec(4)]); // one key, four historical appends
  assert.equal(h.open, 1, "one open task after folding");
  assert.equal(h.topRecurrence.length, 1);
  assert.equal(h.topRecurrence[0].count, 4, "latest count wins");
  assert.deepEqual(foldTasks([rec(1), { ...rec(2), status: "fixed" }]).map((t) => t.status), ["fixed"], "fixed supersedes earlier open");
  assert.equal(healthFrom(events, [rec(1), { ...rec(2), status: "fixed" }]).open, 0);
});

test("classify: contradiction needs a docs mandate — a named-but-forbidden shape is not one", () => {
  const docs = [
    "File views go through piread windows; `cat`/`head`/`tail`/`sed -n` only trim command output, never open files.",
    "then run `git add` and `git commit -F` <msgfile> in one shell call",
  ].join("\n");
  // sed -n named inside a prohibition line: gate and docs agree, so no contradiction
  assert.notEqual(classify({ source: "gate", id: "SE2", kind: "block", shape: "sed -n 1,20p CHANGELOG.md" }, docs, []), "contradiction");
  // git add mandated by the docs: a block on it is a real contradiction
  assert.equal(classify({ source: "gate", id: "R9", kind: "block", shape: "git add AGENTS.md package.json" }, docs, []), "contradiction");
});

test("healthFrom rolls open rule-gap tasks up by rule id — one behavior, one line", () => {
  const mk = (id, path, count) => ({ key: `rule-gap:gate:${id}:${path}`, class: "rule-gap", source: "gate", id, shape: path, count, status: "open" });
  const h = healthFrom([], [mk("AG", "a.ts", 3), mk("AG", "b.ts", 5), mk("R1", "c.ts", 2), { ...mk("H2", "d.sh", 9), class: "misfire" }]);
  assert.deepEqual(h.ruleGapById, [{ id: "AG", tasks: 2, events: 8 }, { id: "R1", tasks: 1, events: 2 }]);
});

test("parseSession: retired tools are not harvested — dead signal, not recurrence", () => {
  const retired = [
    JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id: "cm1", name: "codemode", arguments: { code: "return 1" } }] } }),
    JSON.stringify({ message: { role: "toolResult", toolCallId: "cm1", toolName: "codemode", isError: true, content: [{ type: "text", text: "Script failed" }] } }),
    JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id: "ls1", name: "pibash", arguments: { command: "ls nope" } }] } }),
    JSON.stringify({ message: { role: "toolResult", toolCallId: "ls1", toolName: "pibash", isError: true, content: [{ type: "text", text: "ls: nope: No such file or directory" }] } }),
  ].join("\n");
  const { gate, fails } = parseSession(retired, "r.jsonl", "T");
  assert.equal(fails.length, 1);
  assert.equal(fails[0].tool, "pibash");
  assert.equal(gate.length, 0);
});

test("CLI: harvests fixture tree, dedupes on re-run, writes ledgers + cursor", () => {
  const home = mkdtempSync(join(tmpdir(), "hw-home-"));
  const sess = join(home, "sessions/proj");
  mkdirSync(sess, { recursive: true });
  writeFileSync(join(sess, "2026-11-19T00-00-00Z_a.jsonl"), SESSION);
  const run = (args = []) =>
    execFileSync("node", [join(ROOT, "scripts/harness-watch.mjs"), "--home", home, ...args], { encoding: "utf8" });
  const out1 = run();
  assert.match(out1, /5 new events/);
  assert.match(out1, /\[misfire\] gate:H2/);
  const dir = join(home, ".cache/harness-watch");
  for (const f of ["events.ndjson", "tasks.ndjson", "metrics.ndjson", "state.json"])
    assert.ok(existsSync(join(dir, f)), `${f} written`);
  const out2 = run();
  assert.match(out2, /0 new events/); // cursor + dedup: nothing re-harvested
  const status = run(["--status"]);
  assert.match(status, /open tasks/); // status reads ledgers without harvest
});

test("evalSpawn: nightly eval writes into the harvested ledger, not the default home", () => {
  const { args, env } = evalSpawn("/tmp/hw-home-x", "/tmp/hw-home-x/.cache/harness-watch");
  assert.equal(args[0], process.execPath);
  assert.equal(args[1], "/tmp/hw-home-x/tests/gate/eval/run.mjs");
  assert.equal(env.GATE_EVAL_METRICS, "/tmp/hw-home-x/.cache/harness-watch/metrics.ndjson");
});
