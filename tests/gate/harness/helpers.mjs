#!/usr/bin/env node
/**
 * Black-box fixture test for permission-gate.ts R1 (read coverage).
 *
 * Runs the real extension through a stubbed ExtensionAPI: replays synthetic
 * tool_call / tool_result / session_compact events and asserts block/pass.
 * Each case gets a fresh extension instance (gate state lives inside the
 * factory), so cases cannot leak coverage into each other.
 *
 * Preflight: the gate's bare import `@earendil-works/pi-coding-agent` is not
 * in this repo's node_modules (root package.json holds repo tooling only) —
 * symlink it to the global install under the gitignored root node_modules.
 * Resolves via `npm root -g`; no absolute paths committed.
 *
 * Run: node tests/permission-gate.test.mjs   (exit 0 = all pass)
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pkgLink = join(
  ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true }); // stale empty dir / broken link must not pass
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(
    join(globalRoot, "@earendil-works", "pi-coding-agent"),
    pkgLink,
    "dir",
  );
}

// P2 (2026-10-18): the gate blocks built-in `bash` while pibash is
// registered (pibash-first). The bash-mechanics cases below exercise the
// built-in tool's rules, so the suite runs them in the pibash-opted-out
// configuration; the dedicated P2 cases toggle the env to exercise the default.
process.env.PI_NATIVE_BASH = "0";

const gate = await import("../../../extensions/permission-gate/index.ts");
const rc = await import("../../../extensions/permission-gate/rules/read-coverage.ts"); // S5: hash plumbing units

// ---- stubbed ExtensionAPI + event replay ----

// composing stub: one extension may register several handlers per event
// (H1 cap + bookkeeping both listen on tool_result) — invoke() runs them in
// registration order; a non-undefined return composes forward
function makePi() {
  const lists = new Map();
  return {
    on: (event, handler) => {
      const l = lists.get(event) ?? [];
      l.push(handler);
      lists.set(event, l);
      return () =>
        lists.set(
          event,
          (lists.get(event) ?? []).filter((h) => h !== handler),
        );
    },
    invoke: async (event, ev, ctx) => {
      let result;
      for (const h of lists.get(event) ?? []) {
        const r = await h(ev, ctx);
        if (r !== undefined) result = r;
      }
      return result;
    },
  };
}
const freshGate = () => {
  const pi = makePi();
  gate.default(pi);
  return pi;
};

let seqId = 0;
/** Shared call-id source: modules cannot mutate an imported binding. */
export function nextId() { return ++seqId; }
const textBlocks = (s) => [{ type: "text", text: s }];
const lineText = (n) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

/** R1x manual read cycle: fire piread tool_call then its tool_result and
 * return BOTH handler returns, so probes can assert notes the gate appends
 * to a passing read result (the read() helper discards the result return). */
async function rawRead(pi, id, path, opts, out) {
  const lines = out ?? opts.limit ?? 100;
  const input = { path, ...opts };
  const block = await pi.invoke("tool_call", {
    type: "tool_call", toolName: "piread", toolCallId: id, input,
  });
  const res = await pi.invoke("tool_result", {
    type: "tool_result", toolName: "piread", toolCallId: id, input,
    content: textBlocks(lineText(lines)),
    details: { truncation: { truncated: false, outputLines: lines, totalLines: 100 } },
    isError: false,
  });
  return { block, res };
}

const noteOf = (res) =>
  (res?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

/** read via the gate; default result = untruncated full read of `n` lines */
async function read(pi, path, opts = {}, result = {}) {
  // P6 (2026-10-15): the gate blocks built-in `read` on text files
  // (piread-first). Coverage tests certify text through `piread`; probes that
  // must exercise the built-in `read` tool pass { tool: "read" }, and images
  // stay on `read` automatically.
  const toolName = result.tool ?? (result.image ? "read" : "piread");
  return readVia(pi, toolName, path, opts, result);
}

// P6 (2026-10-15): the gate blocks built-in `read` on text files (piread-first).
// Text-file certification in tests goes through `piread`; images keep `read`.
async function piread(pi, path, opts = {}, result = {}) {
  return readVia(pi, "piread", path, opts, result);
}

async function readVia(pi, toolName, path, opts = {}, result = {}) {
  const n = result.outputLines ?? 100;
  const input = { path, ...opts };
  const toolCallId = `tc${++seqId}`;
  const block = await pi.invoke("tool_call", {
    type: "tool_call",
    toolName,
    toolCallId,
    input,
  });
  if (block) return { blocked: true, reason: block.reason };
  const body = lineText(n);
  const tail = result.note ? `${body}\n\n[${result.note}]` : body;
  await pi.invoke("tool_result", {
    type: "tool_result",
    toolName,
    toolCallId,
    input,
    content: result.image
      ? [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "x" },
          },
        ]
      : textBlocks(tail),
    details:
      result.image || result.noDetails
        ? undefined
        : {
            truncation: {
              truncated: result.truncated ?? false,
              outputLines: n,
              totalLines: result.totalLines ?? n,
            },
            ...(result.compaction ? { compaction: result.compaction } : {}),
          },
    isError: false,
  });
  return { blocked: false };
}

async function edit(pi, path, edits) {
  const toolCallId = `tc${++seqId}`;
  const input = { path, edits };
  const block = await pi.invoke("tool_call", {
    type: "tool_call",
    toolName: "edit",
    toolCallId,
    input,
  });
  if (block) return { blocked: true, reason: block.reason };
  await pi.invoke("tool_result", {
    type: "tool_result",
    toolName: "edit",
    toolCallId,
    input,
    content: textBlocks("ok"),
    isError: false,
  });
  return { blocked: false };
}

/** edit call + result replay exposing the result: warn notes ride the
 * tool_result as appended text blocks, so noteOf(r) reads them — mirrors
 * runBash (plain edit() replays no result, so warns stay invisible) */
async function runEdit(pi, path, edits) {
  const toolCallId = `tc${++seqId}`;
  const input = { path, edits };
  const block = await pi.invoke("tool_call", {
    type: "tool_call", toolName: "edit", toolCallId, input,
  });
  if (block) return { blocked: true, reason: block.reason };
  const res = await pi.invoke("tool_result", {
    type: "tool_result", toolName: "edit", toolCallId, input,
    content: textBlocks("ok"),
    isError: false,
  });
  return { blocked: false, ...res };
}

/** own single edit that ACTUALLY applies to disk between call and result
 * (S5 M3): the real edit tool writes the file before its tool_result fires,
 * so post-op stat/hash certification sees the applied content. Optional T
 * pins the post-edit mtime to a round, exactly-restorable value. */
async function editApplied(pi, path, oldText, newText, T) {
  const toolCallId = `tc${++seqId}`;
  const input = { path, edits: [{ oldText, newText }] };
  const block = await pi.invoke("tool_call", {
    type: "tool_call",
    toolName: "edit",
    toolCallId,
    input,
  });
  if (block) return { blocked: true, reason: block.reason };
  writeFileSync(path, readFileSync(path, "utf8").replace(oldText, newText));
  if (T) utimesSync(path, T, T);
  await pi.invoke("tool_result", {
    type: "tool_result",
    toolName: "edit",
    toolCallId,
    input,
    content: textBlocks("ok"),
    isError: false,
  });
  return { blocked: false };
}

/** multi-edit variant of editApplied: applies every (disjoint) edit to disk —
 * the tool applies edits[] as one overlay against the original content */
async function editsApplied(pi, path, editList) {
  const toolCallId = `tc${++seqId}`;
  const input = { path, edits: editList };
  const block = await pi.invoke("tool_call", {
    type: "tool_call",
    toolName: "edit",
    toolCallId,
    input,
  });
  if (block) return { blocked: true, reason: block.reason };
  let content = readFileSync(path, "utf8");
  for (const e of editList) content = content.replace(e.oldText, e.newText);
  writeFileSync(path, content);
  await pi.invoke("tool_result", {
    type: "tool_result",
    toolName: "edit",
    toolCallId,
    input,
    content: textBlocks("ok"),
    isError: false,
  });
  return { blocked: false };
}

async function bash(
  pi,
  command,
  ctx = { hasUI: true, mode: "tui", ui: { confirm: async () => true } },
) {
  const block = await pi.invoke(
    "tool_call",
    {
      type: "tool_call",
      toolName: "bash",
      toolCallId: `tc${++seqId}`,
      input: { command },
    },
    ctx,
  );
  return block ? { blocked: true, reason: block.reason } : { blocked: false };
}

/** R10: bash call + result replay — the re-run guard records on tool_result */
async function runBash(pi, command, { error = false, ctx } = {}) {
  const toolCallId = `tc${++seqId}`;
  const block = await pi.invoke(
    "tool_call",
    { type: "tool_call", toolName: "bash", toolCallId, input: { command } },
    ctx,
  );
  if (block) return { blocked: true, reason: block.reason };
  const res = await pi.invoke("tool_result", {
    type: "tool_result",
    toolName: "bash",
    toolCallId,
    input: { command },
    content: textBlocks("out"),
    isError: error,
  });
  return { blocked: false, ...res };
}
/** R1c/C4 (2026-10-27): bash call + result replay carrying raw command
 * OUTPUT — hit-anchored seeding parses the result text of rg-family
 * commands, so these probes control exactly what the search "printed". */
async function runSearch(pi, command, output, { error = false } = {}) {
  const toolCallId = `tc${++seqId}`;
  const block = await pi.invoke("tool_call", {
    type: "tool_call",
    toolName: "bash",
    toolCallId,
    input: { command },
  });
  if (block) return { blocked: true, reason: block.reason };
  await pi.invoke("tool_result", {
    type: "tool_result",
    toolName: "bash",
    toolCallId,
    input: { command },
    content: textBlocks(output),
    isError: error,
  });
  return { blocked: false };
}
/** Pibash (2026-10-18): the native bash tool. Same events, toolName `pibash`
 * — the gate must treat it as bash-kind (H1 cap, R10, destructive, malformed). */
async function pibash(pi, command, ctx) {
  const toolCallId = `tc${++seqId}`;
  const block = await pi.invoke(
    "tool_call",
    {
      type: "tool_call",
      toolName: "pibash",
      toolCallId,
      input: { command },
    },
    ctx,
  );
  if (block) return { blocked: true, reason: block.reason };
  await pi.invoke("tool_result", {
    type: "tool_result",
    toolName: "pibash",
    toolCallId,
    input: { command },
    content: textBlocks("out"),
  });
  return { blocked: false };
}

/** nested sub-call (executeTool child): parentToolCallId set, "<parent>/<n>" id */
async function nestedBash(pi, command, { error = false } = {}) {
  const toolCallId = `cm0/${++seqId}`;
  const block = await pi.invoke(
    "tool_call",
    { type: "tool_call", toolName: "bash", toolCallId, parentToolCallId: "cm0", input: { command } },
  );
  if (block) return { blocked: true, reason: block.reason };
  await pi.invoke("tool_result", {
    type: "tool_result", toolName: "bash", toolCallId, parentToolCallId: "cm0",
    input: { command }, content: textBlocks("out"), isError: error,
  });
  return { blocked: false };
}

/** write via the gate; optional apply writes content to disk between call
 * and result (the real tool writes before its result fires), T pins a round
 * restorable stat (S5) */
async function write(pi, path, content, { apply = false, T } = {}) {
  const toolCallId = `tc${++seqId}`;
  const input = { path, content };
  const block = await pi.invoke("tool_call", {
    type: "tool_call",
    toolName: "write",
    toolCallId,
    input,
  });
  if (block) return { blocked: true, reason: block.reason };
  if (apply) writeFileSync(path, content);
  if (T) utimesSync(path, T, T);
  await pi.invoke("tool_result", {
    type: "tool_result",
    toolName: "write",
    toolCallId,
    input,
    content: textBlocks("ok"),
    isError: false,
  });
  return { blocked: false };
}

const approveUi = () => ({
  hasUI: true,
  mode: "tui",
  ui: { confirm: async () => true },
});
const denyUi = () => ({
  hasUI: true,
  mode: "tui",
  ui: { confirm: async () => false },
});

const compact = (pi) =>
  pi.invoke("session_compact", { type: "session_compact" });

// ---- fixtures ----

const tmp = mkdtempSync(join(tmpdir(), "pgate-"));
const fileA = join(tmp, "a.ts");
writeFileSync(fileA, "a\nb\nc\n");
const fileInj = join(tmp, "injected.md"); // R-inj: CLI @file block certification (2026-10-10)
writeFileSync(fileInj, "i1\ni2\ni3");
const relA = relative(process.cwd(), fileA); // same file via the other key form (Q3)
const skillFile = join(tmp, "SKILL.md"); // 2026-10-06 feedback: R1 coverage must close same-session skill re-reads
writeFileSync(
  skillFile,
  Array.from({ length: 30 }, (_, i) => `skill line ${i + 1}`).join("\n") + "\n",
);
const fileC = join(tmp, "hydrate-c.ts"); // 2026-10-07: resume-hydration fixtures
writeFileSync(fileC, "l1\nl2\nl3\n");
const fileD = join(tmp, "hydrate-d.ts");
writeFileSync(fileD, "l1\nl2\n");
const fileE = join(tmp, "hydrate-e.ts");
writeFileSync(fileE, "l1\nl2\nl3\n");
/** build fake previous-session branch entries for the hydration fixtures */
function prevBranch(descs) {
  return descs.map((d) =>
    d.compactionAfter
      ? { type: "compaction", id: d.id, firstKeptEntryId: d.compactionAfter }
      : d.call
        ? {
            type: "message",
            id: d.id,
            timestamp: d.ts,
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: d.callId,
                  name: d.call,
                  arguments:
                    d.call === "write"
                      ? { path: d.path, content: "x" }
                      : { path: d.path },
                },
              ],
            },
          }
        : {
            type: "message",
            id: d.id,
            message: {
              role: "toolResult",
              toolCallId: d.resultFor,
              toolName: d.tool ?? "read",
              content: [{ type: "text", text: d.text }],
              isError: false,
            },
          },
  );
}
const hydrate = (pi, descs) =>
  pi.invoke(
    "session_start",
    { type: "session_start", reason: "resume" },
    { sessionManager: { getBranch: () => prevBranch(descs) } },
  );
const fileB = join(tmp, "dup.ts"); // duplicate line for the anchor-uniqueness case
writeFileSync(fileB, "x\nx\n");
const tinyFile = join(tmp, "tiny.json"); // 2026-10-08: R2 trivial-cat batch exemption (audit: 49 B watermark case)
writeFileSync(tinyFile, '{ "auditedThrough": "2026-10-07" }\n'); // 34 B
const bigFile = join(tmp, "big.json");
writeFileSync(bigFile, `${"x".repeat(199)}\n`); // 200 B — over the 128 B exemption
const spanFile = join(tmp, "spans.ts"); // item 11: gapped coverage spans
writeFileSync(
  spanFile,
  Array.from({ length: 120 }, (_, i) => `s${i + 1}`).join("\n") + "\n",
);
// R1c/C4 (2026-10-26 session replay): the incident's file, named only in rg
// OUTPUT (`__tests__/…/hitApi.test.ts:158:`), never in argv — the wide read
// that followed was blocked. Same shape, sandboxed.
const hitRoot = join(tmp, "hit-root");
mkdirSync(join(hitRoot, "__tests__/src/api/query"), { recursive: true });
const hitApi = join(hitRoot, "__tests__/src/api/query/hitApi.test.ts");
writeFileSync(hitApi, Array.from({ length: 600 }, (_, i) => `h${i + 1}`).join("\n") + "\n");
const hugeFile = join(tmp, "extension-huge.ts"); // 2026-10-10: R1b big-read gate (audit: 44KB/51KB whole-file reads rode two sessions' prefixes)
const midFile = join(tmp, "extension-mid.tsx"); // 2026-10-18: elision blind-spot fixture (~13KB / 330 lines)
writeFileSync(
  hugeFile,
  Array.from({ length: 900 }, () => "x".repeat(59)).join("\n") + "\n",
); // ~54 KB / 900 lines
// 2026-10-18 session: a ~14KB whole read passed the
// 24KB floor, then piread compacted it — model saw 11.5KB of elided middle
// and treated it as read. Anything over piread's 2KB model budget elides, so
// the gate floor must sit under the compaction threshold, not over it.
writeFileSync(
  midFile,
  Array.from({ length: 330 }, () => "y".repeat(39)).join("\n") + "\n",
); // ~13 KB / 330 lines
// ---- S4 (2026-10-15) live-shell canary suite (spec §5.3) ----
// mkdtemp sandbox + fake HOME carrying byte-compared canaries; commands go
// through the gate headless ({hasUI:false}) and EXECUTE (spawnSync bash -c,
// 10 s) only when the gate allows — a wrongly-allowed destructive command
// destroys a canary and fails the test. The runner-side hard net,
// independent of the gate, refuses system paths / sudo|su / network
// binaries / git push WITHOUT executing, so a gate bug can never damage the
// machine during the test; a gate evasion caught by the net fails the case.
let canary = null;
const canaryBytes = (c) =>
  [
    join(c.home, ".ssh", "authorized_keys"),
    join(c.home, ".bashrc"),
    c.work,
  ].map((p) => {
    try {
      return readFileSync(p);
    } catch {
      return Buffer.alloc(0); // destroyed/missing canary: empty ≠ non-empty original → broken
    }
  });
function startCanary() {
  const sandbox = mkdtempSync(join(tmpdir(), "pgate-canary-"));
  const home = join(sandbox, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "authorized_keys"), "canary-ssh\n");
  writeFileSync(join(home, ".bashrc"), "canary-rc\n");
  const work = join(sandbox, "work.txt");
  writeFileSync(work, "canary-work\n");
  canary = {
    sandbox,
    home,
    work,
    prevHome: process.env.HOME,
    prevCwd: process.cwd(),

  };
  canary.before = canaryBytes(canary);
  process.chdir(sandbox);
  return freshGate();
}
function stopCanary() {
  if (!canary) return;
  process.chdir(canary.prevCwd);
  if (canary.prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = canary.prevHome;

  canary = null;
}
const canaryIntact = () =>
  canaryBytes(canary).every((b, i) => b.equals(canary.before[i]));
const HARD_NET =
  /(?:^|[\s"'=;(&>|])(?:(?:\/(?:etc|usr|var|boot|root|bin|sbin|lib)(?:\/|\b))|(?:sudo|su|curl|wget|ssh|scp)\b|git\s+push\b)/;
/** gate decides headless; only gate-allowed commands execute; net first,
 * without executing */
async function gatedExec(pi, command) {
  if (HARD_NET.test(command)) return { netRefused: true };
  const block = await pi.invoke(
    "tool_call",
    { type: "tool_call", toolName: "bash", toolCallId: `tc${++seqId}`, input: { command } },
    { hasUI: false },
  );
  if (block) return { blocked: true, reason: block.reason };
  const r = spawnSync("/bin/bash", ["-c", command], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return { blocked: false, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
/** family helper: the command MUST be gate-blocked, never executed, canaries
 * byte-identical throughout */
async function canaryBlocked(pi, command) {
  try {
    const r = await gatedExec(pi, command);
    const intact = canaryIntact();
    return !r.netRefused && r.blocked && intact
      ? { blocked: true, reason: r.reason }
      : {
          blocked: false,
          reason: `netRefused=${!!r.netRefused} blocked=${!!r.blocked} intact=${intact}`,
        };
  } finally {
    stopCanary();
  }
}

// ---- cases: [name, expectation, async fn -> {blocked}] ----

/** C2/C3 fixture (2026-10-27): an elided piread of window 225–290 — head
 * 225–245, marker gap 246–269, tail 270–290 — carrying piread's structured
 * omissions[] (C3) in details.compaction. */
async function elidedReadC3(pi, f) {
  const head = Array.from({ length: 21 }, (_, i) => `line ${225 + i}`);
  const tail = Array.from({ length: 21 }, (_, i) => `line ${270 + i}`);
  const text = [
    ...head,
    "",
    "[... omitted 1942 chars / 24 lines ...]",
    "",
    ...tail,
  ].join("\n");
  const toolCallId = `tc${++seqId}`;
  const input = { path: f, offset: 225, limit: 66 };
  const block = await pi.invoke("tool_call", {
    type: "tool_call",
    toolName: "piread",
    toolCallId,
    input,
  });
  if (block) return { blocked: true, reason: block.reason };
  await pi.invoke("tool_result", {
    type: "tool_result",
    toolName: "piread",
    toolCallId,
    input,
    content: textBlocks(text),
    details: {
      truncation: { truncated: false, outputLines: 66, totalLines: 300 },
      compaction: {
        strategy: "head-tail",
        originalChars: 3600,
        visibleChars: 1100,
        omittedChars: 1942,
        omissions: [
          { startLine: 246, endLine: 269, chars: 1942, lines: 24 },
        ],
        partial: false,
      },
    },
    isError: false,
  });
  return { blocked: false };
}

// shared round timestamp for the S5 R4 hydration preamble↔probe pair
let HYD_T = new Date();
/** Imported bindings are read-only: cases mutate the round timestamp via these. */
export function getHydT() { return HYD_T; }
export function setHydT(d) { HYD_T = d; }
export { ROOT, pkgLink, gate, rc, makePi, freshGate, textBlocks, lineText, rawRead, noteOf, read, piread, readVia, edit, runEdit, editApplied, editsApplied, bash, runBash, runSearch, pibash, nestedBash, write, approveUi, denyUi, compact, tmp, fileA, fileInj, relA, skillFile, fileC, fileD, fileE, prevBranch, hydrate, fileB, tinyFile, bigFile, spanFile, hitRoot, hitApi, hugeFile, midFile, canary, canaryBytes, startCanary, stopCanary, canaryIntact, HARD_NET, gatedExec, canaryBlocked, elidedReadC3 };
