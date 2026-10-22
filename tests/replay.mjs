#!/usr/bin/env node
/**
 * Historical replay (brief §4 item 5): feeds every bash toolCall recorded in
 * real session .jsonl logs (READ-ONLY) through a fresh gate, one gate instance
 * per session file so stateful rules (R10 re-run, re-block) see real order.
 *
 * Blocked would-be commands get a synthesized error tool_result carrying the
 * block reason (what pi does), so subsequent state matches the real loop.
 *
 * fp_rate proxy = fraction of commands that ran successfully in real sessions
 * (isError === false) that the current gate would now block.
 *
 * Deterministic: files sorted by path; if over MAX_FILES, a stable sort by
 * (mtime desc, path) + slice keeps the same sample every run — no Math.random.
 *
 * Output: one JSON line  { commands, blocked, fp_rate, by_family, sessions }
 * Run: node tests/replay.mjs [sessionsRoot]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { freshGate, bashProbe, familyOfReason } from './lib/gate-stub.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS = resolve(process.argv[2] ?? join(homedir(), '.pi', 'agent', 'sessions'));
const MAX_FILES = 600; // speed bound; stable over-sample below keeps runs comparable

let files = [];
try {
  files = readdirSync(SESSIONS, { recursive: true, encoding: 'utf8' })
    .filter((f) => String(f).endsWith('.jsonl'))
    .map((f) => join(SESSIONS, String(f)));
} catch {
  console.log(JSON.stringify({ commands: 0, blocked: 0, fp_rate: null, by_family: {}, sessions: 0, error: `no sessions dir at ${SESSIONS}` }));
  process.exit(0);
}
if (files.length > MAX_FILES) {
  const keyed = files.map((f) => { let m = 0; try { m = statSync(f).mtimeMs; } catch {} return { f, m }; });
  keyed.sort((a, b) => (b.m - a.m) || (a.f < b.f ? -1 : 1)); // newest first, path tiebreak
  files = keyed.slice(0, MAX_FILES).map((k) => k.f).sort();
}

let commands = 0, blocked = 0, ran = 0, ranButBlocked = 0, intendedBlocks = 0;
// W2 instrumentation (2026-10-08): chars of real historical bash output that
// would land in model context, uncapped vs under the gate's cap policy — the
// direct measure of the output-cap's W2 savings (spill keeps the tail reachable)
let ctxCharsUncapped = 0, ctxCharsCapped = 0, spillCount = 0, errChars = 0, errBigCount = 0;
// mirror of the gate's cap constants (keep in sync with permission-gate.ts);
// SIM_* overrides exist for calibration sweeps only
const CAP_LINES = Number(process.env.SIM_CAP_LINES ?? 100), CAP_BYTES = Number(process.env.SIM_CAP_BYTES ?? 4096);
const cappedLen = (text) => {
  const lines = text.split('\n');
  if (lines.length <= CAP_LINES && text.length <= CAP_BYTES) return { len: text.length, capped: false };
  let kept = 0, bytes = 0;
  for (const l of lines) {
    if (kept >= CAP_LINES || bytes + l.length + 1 > CAP_BYTES) break;
    kept++; bytes += l.length + 1;
  }
  return { len: bytes, capped: true };
};
const byFamily = {};

for (const file of files) {
  const calls = []; // { id, command, result?: { content, isError } }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"role"')) continue;
    let msg;
    try { msg = JSON.parse(line).message; } catch { continue; }
    if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type === 'toolCall' && b.name === 'bash' && typeof b.arguments?.command === 'string') {
          calls.push({ id: b.id, command: b.arguments.command });
        }
      }
    } else if (msg?.role === 'toolResult' && calls.length) {
      const c = calls.find((x) => x.id === msg.toolCallId && !x.result);
      if (c) c.result = { content: msg.content ?? [], isError: !!msg.isError };
    }
  }
  if (!calls.length) continue;
  const pi = freshGate();
  for (const c of calls) {
    commands++;
    const r = await bashProbe(pi, c.command);
    if (!r.blocked) {
      // feed the real outcome so R10/coverage state tracks the historical run
      const res = c.result ?? { isError: true };
      if (!res.isError) {
        ran++;
        const text = (Array.isArray(res.content) ? res.content : []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
        if (text) {
          const cl = cappedLen(text);
          ctxCharsUncapped += text.length;
          ctxCharsCapped += cl.len;
          if (cl.capped) spillCount++;
        }
      } else {
        // error results also land in context (failed builds/tests flood too)
        const text = (Array.isArray(res.content) ? res.content : []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
        errChars += text.length;
        const big = text.length > 8192;
        if (big) errBigCount++;
      }
      await pi.invoke('tool_result', {
        type: 'tool_result', toolName: 'bash', toolCallId: c.id, input: { command: c.command },
        content: Array.isArray(res.content) ? res.content : [{ type: 'text', text: String(res.content ?? '') }],
        isError: !!res.isError, // real outcome: R10 records successful prior runs
      });
      continue;
    }
    blocked++;
    const fam = familyOfReason(r.reason) ?? 'other';
    byFamily[fam] = (byFamily[fam] ?? 0) + 1;
    // metric v2 (2026-10-08): an INTENDED-correct block is not waste cost — a
    // Commitlint block on a message that genuinely fails the conventional
    // pattern is the gate doing its job (the 460-tok cost model prices FALSE
    // blocks). Without this, closing an evasion lane would read as a regression.
    // The tiny pattern mirror lives here because the gate's validator is not
    // exported; keep in sync with permission-gate.ts CONVENTIONAL_HEADER.
    const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w\-.]+\))?!?: .+/;
    const msgs = [...c.command.matchAll(/(?:^|\s)(?:--[a-zA-Z-]*message|-[a-zA-Z]*m)\s*(?:=\s*)?(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)')/g)].map((m) => (m[1] ?? m[2] ?? '').replace(/\\n/g, '\n').split('\n')[0]);
    const intended = fam === 'Commitlint' && msgs.length > 0 && msgs[0].length > 0 && !CONVENTIONAL.test(msgs[0]);
    if (intended) intendedBlocks++;
    if (c.result && !c.result.isError && !intended) ranButBlocked++;
    await pi.invoke('tool_result', {
      type: 'tool_result', toolName: 'bash', toolCallId: c.id, input: { command: c.command },
      content: [{ type: 'text', text: r.reason }], isError: true,
    });
  }
}

console.log(JSON.stringify({
  commands,
  blocked,
  intended_blocks: intendedBlocks,
  fp_rate: ran > 0 ? Number((ranButBlocked / ran).toFixed(4)) : null,
  by_family: byFamily,
  sessions: files.length,
  ran_ok: ran,
  ctx_chars_uncapped: ctxCharsUncapped,
  ctx_chars_capped: ctxCharsCapped,
  ctx_saved_pct: ctxCharsUncapped > 0 ? Number((100 * (1 - ctxCharsCapped / ctxCharsUncapped)).toFixed(2)) : null,
  spill_count: spillCount,
  err_ctx_chars: errChars,
  err_big_count: errBigCount,
}));
