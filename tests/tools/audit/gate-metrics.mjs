#!/usr/bin/env node
/**
 * Gate metrics from a pidx extract (docs/plans/permission_gate_implementation_plan.md §11–§12).
 *
 * Reads the JSONL that `pidx` already produces — no second session parser — and
 * reports the numbers the watch window needs: repeat-without-change, calls spent
 * inside a failure streak, gate blocks by family, and gate-injected token cost as
 * a share of billed input.
 *
 * Usage:
 *   pidx --sessions-dir ~/.pi/agent/sessions --out /tmp/px.jsonl --force
 *   node tests/tools/audit/gate-metrics.mjs --in /tmp/px.jsonl [--project PATH] [--json]
 *
 * `--out` is required: without it pidx writes the extract to stdout. The `pidx`
 * tool's own cache (`~/.pi/agent/.cache/pidx-extracts.jsonl`) holds only the
 * active project, so an explicit `--sessions-dir` + `--out` is the full history.
 *
 * Facts come from the extract (pidx main.rs): calls[].ph is the param hash,
 * results[].err the outcome, results[].blk the gate family (null for a normal
 * result), turns[].usage the billed tokens.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const IN = arg('in', '.cache/pidx-extracts.jsonl');
const PROJECT = arg('project', process.cwd());
const AS_JSON = argv.includes('--json');

const MUTATING = new Set(['piedit', 'edit', 'write', 'pieditMulti']);
const pct = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

export function metrics(lines, project = PROJECT) {
  const includeAll = project === undefined;
  const agg = {
    sessions: 0,
    calls: 0,
    mutations: 0,
    repeat_without_change: 0,
    calls_in_failure_streak: 0,
    calls_in_long_streak: 0,
    blocks: 0,
    by_family: {},
    billed_input_tokens: 0,
    gate_block_bytes: 0,
    max_streak: 0,
  };

  for (const s of lines) {
    if (!s || (!includeAll && s.project !== project)) continue;
    const results = new Map((s.results ?? []).map((r) => [r.id, r]));
    const chain = (s.calls ?? [])
      .map((c) => {
        const r = results.get(c.id) ?? {};
        return { name: c.name, ph: c.ph, err: r.err === true, bytes: r.bytes ?? 0, blk: r.blk ?? null };
      })
      .sort((a, b) => 0); // pidx emits calls in event order already

    if (chain.length === 0) continue;
    agg.sessions++;

    let mutSeq = 0;
    const seen = new Map(); // ph -> mutSeq at first sighting
    let streak = 0;
    for (const c of chain) {
      agg.calls++;
      const mut = !c.err && MUTATING.has(c.name);
      if (mut) {
        agg.mutations++;
        mutSeq++;
      }
      if (c.blk) {
        agg.blocks++;
        agg.by_family[c.blk] = (agg.by_family[c.blk] ?? 0) + 1;
        agg.gate_block_bytes += c.bytes;
      }
      // repeat with no mutation between the two identical params
      if (seen.has(c.ph) && seen.get(c.ph) === mutSeq && !mut) agg.repeat_without_change++;
      if (!seen.has(c.ph)) seen.set(c.ph, mutSeq);
      // failure streak: calls issued while the streak is open
      if (streak > 0) {
        agg.calls_in_failure_streak++;
        if (streak >= 5) agg.calls_in_long_streak++;
      }
      streak = c.err ? streak + 1 : 0;
      agg.max_streak = Math.max(agg.max_streak, streak);
    }
    for (const t of s.turns ?? []) {
      const u = t.usage ?? {};
      agg.billed_input_tokens += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    }
  }
  return agg;
}

// CLI entry — guarded so importing `metrics` stays side-effect free.
const __isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (__isDirect) {

const lines = readFileSync(IN, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  });

const a = metrics(lines);
const gateTokens = Math.round(a.gate_block_bytes / 4);
const out = {
  project: PROJECT,
  sessions: a.sessions,
  calls: a.calls,
  mutations: a.mutations,
  repeat_without_change: a.repeat_without_change,
  repeat_pct: pct(a.repeat_without_change, a.calls),
  calls_in_failure_streak: a.calls_in_failure_streak,
  calls_in_long_streak: a.calls_in_long_streak,
  max_streak: a.max_streak,
  gate_blocks: a.blocks,
  gate_block_pct: pct(a.blocks, a.calls),
  by_family: a.by_family,
  billed_input_tokens: a.billed_input_tokens,
  gate_tokens_est: gateTokens,
  gate_token_share_pct: pct(gateTokens, a.billed_input_tokens),
};

if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const [k, v] of Object.entries(out)) {
    if (k === 'by_family') console.log(`${k}: ${JSON.stringify(v)}`);
    else console.log(`${k}: ${v}`);
  }
}

}
