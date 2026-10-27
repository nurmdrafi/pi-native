#!/usr/bin/env node
/**
 * gate:eval aggregator — one command, one final JSON metrics line (brief §4.6).
 *
 * Runs, in order:
 *   1. tests/gate/eval/fixtures.mjs            (fixtures: pass/fail counts)
 *   2. tests/tools/audit/block-recovery.mjs (historical block recovery; exit code
 *                                      ignored — its <85% gate is advisory here)
 *   3. tests/tools/audit/replay.mjs              (historical bash replay; fp_rate proxy)
 *
 * Metrics printed:
 *   METRIC tokens_per_task=<n>
 *     tokens_per_task = (blocked_cmds * 460 + dup_read_cmds * 300) / sessions
 *       blocked_cmds  = replayed bash commands the current gate would block
 *                       (each block costs ~460 tok: block reason + retry turn;
 *                       block_cost_tok baseline from the block-reason audit)
 *       dup_read_cmds = would-blocks in 'Token Economy (Reading)' or
 *                       '(Re-read)' — proxy for W1 dup-read waste at ~300 tok
 *                       of re-sent file content each
 *       sessions      = replayed session files
 *     Deterministic: no sampling randomness inside (replay.mjs uses a stable
 *     sort + slice when over its file cap, so the sample is identical each run).
 *   Final line: single JSON object with all metrics.
 */
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const env = { ...process.env };

const run = (script, args = []) =>
  spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });

const gateEval = run('tests/gate/eval/fixtures.mjs');
console.log(gateEval.stdout.trim());
if (gateEval.status !== 0) console.error(gateEval.stderr);

const audit = run('tests/tools/audit/block-recovery.mjs', [join(homedir(), '.pi', 'agent', 'sessions')]);
console.log(audit.stdout.trim());

const replay = run('tests/tools/audit/replay.mjs');
console.log(replay.stdout.trim().split('\n').filter((l) => !l.startsWith('{')).join('\n'));

const lastJson = (s) => {
  for (const l of s.trim().split('\n').reverse()) {
    if (l.startsWith('{')) { try { return JSON.parse(l); } catch {} }
  }
  return null;
};
const fx = lastJson(gateEval.stdout) ?? {};
const rp = lastJson(replay.stdout) ?? {};
const recoveryPct = /one-shot-recovery=\d+ \((\d+)%\)/.exec(audit.stdout)?.[1];

// tokens_per_task — exact definition in the header comment
// metric v2 (2026-10-08): intended-correct blocks (e.g. a Commitlint block on
// a genuinely non-conventional message) carry no 460-tok cost — that price is
// for FALSE blocks; closing evasion lanes must not read as regression.
const blockedCmds = (rp.blocked ?? 0) - (rp.intended_blocks ?? 0);
const dupReadCmds = (rp.by_family?.['Token Economy (Reading)'] ?? 0) + (rp.by_family?.['Token Economy (Re-read)'] ?? 0);
const sessions = rp.sessions ?? 0;
const tokensPerTask = sessions > 0 ? Math.round((blockedCmds * 460 + dupReadCmds * 300) / sessions) : null;
const ctxTokPerTask = sessions > 0 ? Math.round((rp.ctx_chars_capped ?? 0) / 4 / sessions) : null;

if (tokensPerTask !== null) console.log(`METRIC tokens_per_task=${tokensPerTask}`);
if (ctxTokPerTask !== null) console.log(`METRIC ctx_tok_per_task=${ctxTokPerTask}`);
console.log(JSON.stringify({
  fixture_pass: fx.fixture_pass ?? 0,
  fixture_total: fx.fixture_total ?? 0,
  allow_fail: fx.allow_fail ?? 0,
  block_fail: fx.block_fail ?? 0,
  one_shot_recovery: recoveryPct !== undefined ? Number(recoveryPct) / 100 : null,
  commands: rp.commands ?? 0,
  blocked: blockedCmds,
  fp_rate: rp.fp_rate ?? null,
  by_family: rp.by_family ?? {},
  ctx_saved_pct: rp.ctx_saved_pct ?? null,
  ctx_tok_per_task: ctxTokPerTask,
  spill_count: rp.spill_count ?? null,
}));
