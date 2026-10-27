#!/usr/bin/env node
/**
 * S1 session-metrics tests (spec: docs/specs/2026-10-15-s1-metrics-design.md §8).
 * Run: node --test tests/session-metrics.test.mjs  (or directly).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionFromPath, sessionFromExtract, computeMetrics } from '../../skills/session-audit/scripts/metrics.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'session-metrics');
const goldenPath = join(FIX, 'golden.jsonl');
const goldenExtract = JSON.parse(await import('node:fs').then((m) => m.readFileSync(join(FIX, 'golden.extract.json'), 'utf8')));

// A fixed "now" far after the fixture's last event (2026-10-15T10:02Z) so partial=false.
const NOW = Date.parse('2026-10-20T00:00:00Z');

// ---------------------------------------------------------------- shape (Step 2)

test('sessionFromPath returns normalized shape (spec §5.1)', () => {
  const s = sessionFromPath(goldenPath);
  assert.equal(s.sessionId, 'golden');
  assert.equal(s.project, '/home/user/proj');
  assert.ok(Array.isArray(s.turns) && s.turns.length === 5);
  const t = s.turns[0];
  for (const k of ['requestId', 'timestamp', 'model', 'usage']) assert.ok(k in t, `turn.${k}`);
  const c = s.calls[0];
  for (const k of ['id', 'name', 'timestamp', 'rid', 'ph', 'path', 'cmd']) assert.ok(k in c, `call.${k}`);
  const r = s.results[0];
  for (const k of ['toolUseId', 'isError', 'bytes', 'timestamp']) assert.ok(k in r, `result.${k}`);
  assert.ok(Array.isArray(s.uts) && s.uts.every((n) => typeof n === 'number'));
  assert.deepEqual(s.skills, { 'test-skill': 1 });
  assert.equal(s.compactions, 1);
});

test('sessionFromExtract returns the same normalized shape', () => {
  const s = sessionFromExtract(goldenExtract);
  assert.equal(s.sessionId, 'golden');
  assert.equal(s.project, '/home/user/proj');
  assert.equal(s.turns.length, 5);
  for (const k of ['requestId', 'timestamp', 'model', 'usage']) assert.ok(k in s.turns[0]);
  for (const k of ['id', 'name', 'timestamp', 'rid', 'ph', 'path', 'cmd']) assert.ok(k in s.calls[0]);
  for (const k of ['toolUseId', 'isError', 'bytes', 'timestamp']) assert.ok(k in s.results[0]);
  assert.ok(Array.isArray(s.uts));
});

test('sessionFromExtract throws on v !== 1', () => {
  assert.throws(() => sessionFromExtract({ ...goldenExtract, v: 2 }), /extract version/);
});

// ---------------------------------------------------------------- latency (Step 4)

const goldenSession = sessionFromPath(goldenPath);

test('latency: golden fixture per-tool deltas (spec §4.1)', () => {
  const m = computeMetrics(goldenSession, NOW);
  assert.deepEqual(m.tools.read.latencyMs, { n: 4, p50: 6000, p95: 25000, max: 25000, invalid: 1 });
  // write: single sample — p50 = p95 = max
  assert.deepEqual(m.tools.write.latencyMs, { n: 1, p50: 10000, p95: 10000, max: 10000, invalid: 0 });
  // bash: result ts before call ts → invalid, no kept samples
  assert.deepEqual(m.tools.bash.latencyMs, { n: 0, p50: null, p95: null, max: null, invalid: 1 });
  assert.deepEqual(m.tools.edit.latencyMs, { n: 4, p50: 5000, p95: 8000, max: 8000, invalid: 0 });
  // c13 (read /p/g.txt) has no result → unmatched, not a latency sample
  assert.equal(m.unmatchedCalls, 1);
});

test('latency: nearest-rank percentiles on fixed samples', () => {
  // n=3: p50 → ceil(1.5)=2 → idx 1; p95 → ceil(2.85)=3 → idx 2
  const s = {
    sessionId: 'syn', project: null, turns: [], results: [], compactions: 0, skills: {}, uts: [],
    calls: [1, 2, 3].map((i) => ({
      id: `k${i}`, name: 'read', timestamp: new Date(Date.parse('2026-10-15T10:00:00Z')).toISOString(),
      rid: 'r', ph: `p${i}`, path: `/p/${i}.txt`, cmd: null,
    })),
  };
  const mk = (base, deltas) => deltas.map((d, i) => ({
    toolUseId: `k${i + 1}`, isError: false, bytes: 1, timestamp: new Date(Date.parse(base) + d).toISOString(),
  }));
  const one = computeMetrics({ ...s, results: mk('2026-10-15T10:00:00Z', [10, 20, 30]) }, NOW);
  assert.deepEqual(one.tools.read.latencyMs, { n: 3, p50: 20, p95: 30, max: 30, invalid: 0 });
  // n=1: all equal
  const single = computeMetrics({ ...s, calls: s.calls.slice(0, 1), results: mk('2026-10-15T10:00:00Z', [7]) }, NOW);
  assert.deepEqual(single.tools.read.latencyMs, { n: 1, p50: 7, p95: 7, max: 7, invalid: 0 });
  // n=2 exact nearest-rank: p50 → idx 0 (ceil(1)=1), p95 → idx 1 (ceil(1.9)=2)
  const two = computeMetrics({ ...s, calls: s.calls.slice(0, 2), results: mk('2026-10-15T10:00:00Z', [5, 9]) }, NOW);
  assert.deepEqual(two.tools.read.latencyMs, { n: 2, p50: 5, p95: 9, max: 9, invalid: 0 });
});

test('latency: missing result timestamp counts invalid', () => {
  const s = {
    sessionId: 'syn', project: null, turns: [], results: [{ toolUseId: 'k1', isError: false, bytes: 1, timestamp: null }],
    compactions: 0, skills: {}, uts: [],
    calls: [{ id: 'k1', name: 'read', timestamp: '2026-10-15T10:00:00.000Z', rid: 'r', ph: 'p', path: '/p/x', cmd: null }],
  };
  const m = computeMetrics(s, NOW);
  assert.deepEqual(m.tools.read.latencyMs, { n: 0, p50: null, p95: null, max: null, invalid: 1 });
});

// ---------------------------------------------------------------- repeat reads (Step 5)

test('reads: golden fixture — true re-read flagged, continuation/reset not (spec §4.2)', () => {
  const m = computeMetrics(goldenSession, NOW);
  // read calls: c1,c2,c3,c4,c6,c13 → 6; only c3 repeats c1 (same window, no mutation between)
  assert.deepEqual(m.reads, { calls: 6, repeats: 1, repeatRate: 1 / 6 });
});

test('reads: generation resets — write between reads, bash mentioning path', () => {
  // built inline: two identical reads split by (a) a write, (b) a bash mention — zero repeats
  const rd = (id, rid) => ({ id, name: 'read', timestamp: '2026-10-15T10:00:00.000Z', rid, ph: 'ph-same', path: '/p/x.txt', cmd: null });
  const res = (id) => ({ toolUseId: id, isError: false, bytes: 1, timestamp: '2026-10-15T10:00:01.000Z' });
  const s = {
    sessionId: 'syn', project: null, turns: [], results: ['a', 'b', 'w', 'c', 'd', 'z'].map(res),
    compactions: 0, skills: {}, uts: [],
    calls: [
      rd('a', 'r1'), rd('b', 'r1'),
      { id: 'w', name: 'write', timestamp: '2026-10-15T10:00:02.000Z', rid: 'r2', ph: 'w', path: '/p/x.txt', cmd: null },
      rd('c', 'r2'), rd('d', 'r2'),
      { id: 'z', name: 'bash', timestamp: '2026-10-15T10:00:03.000Z', rid: 'r3', ph: 'z', path: null, cmd: 'grep x /p/x.txt' },
    ],
  };
  const m = computeMetrics(s, NOW);
  // a+b are a repeat group; the write resets the generation so c+d form a second
  // group rather than one 4-count group — reset enables re-reads, doesn't ban them.
  // The bash command mentioning /p/x.txt bumps the generation again (no reads after).
  assert.deepEqual(m.reads, { calls: 4, repeats: 2, repeatRate: 0.5 });
});

test('reads: zero read calls → null repeatRate', () => {
  const m = computeMetrics({ sessionId: 'syn', project: null, turns: [], calls: [], results: [], compactions: 0, skills: {}, uts: [] }, NOW);
  assert.deepEqual(m.reads, { calls: 0, repeats: 0, repeatRate: null });
});

// ---------------------------------------------------------------- edit block (Step 6)

test('edits: golden fixture — failure math and ph-group classification (spec §4.3)', () => {
  const m = computeMetrics(goldenSession, NOW);
  // attempts c9-c12; failures c9,c11,c12; /p/e.txt: error then success → failedThenSucceeded;
  // /p/f.txt: all errors (distinct ph from e.txt) → failedTerminal
  assert.deepEqual(m.edits, {
    attempts: 4, failures: 3, failureRate: 0.75, failedThenSucceeded: 1, failedTerminal: 1,
  });
});

test('edits: zero attempts → null failureRate', () => {
  const m = computeMetrics({ sessionId: 'syn', project: null, turns: [], calls: [], results: [], compactions: 0, skills: {}, uts: [] }, NOW);
  assert.deepEqual(m.edits, { attempts: 0, failures: 0, failureRate: null, failedThenSucceeded: 0, failedTerminal: 0 });
});

// ---------------------------------------------------------------- core aggregates (Step 7)

test('aggregates: golden fixture (spec §4)', () => {
  const m = computeMetrics(goldenSession, NOW);
  assert.equal(m.apiTurns, 5); // r5 duplicate deduped, last-wins (output 25)
  assert.deepEqual(m.tokens, { input: 410, output: 165, cacheRead: 4100, cacheWrite: 1000, peakContext: 2390 });
  assert.equal(m.cacheHitRatio, 4100 / 5100); // zero-denominator → 0 tested below
  assert.equal(m.costUsd, 0.09); // r3 carries no cost; r5 counted once
  assert.deepEqual(m.batch, { turnsWithCalls: 5, calls: 12, one: 1, two: 3, multi: 1 });
  assert.equal(m.durationMs, 120000); // union incl. user entry at 10:02:00Z
  assert.equal(m.compactions, 1);
  assert.deepEqual(m.skills, { 'test-skill': 1 });
  assert.equal(m.valid, true);
  assert.equal(m.partial, false);
  assert.equal(m.project, '/home/user/proj');
  assert.equal(m.schema, 's1-metrics/1');
});

test('aggregates: rid-dedupe last-wins on token sums', () => {
  const t = (rid, output, ts) => ({ requestId: rid, timestamp: ts, model: 'm', usage: { input: 10, output, cacheRead: 0, cacheWrite: 0 } });
  const m = computeMetrics({ sessionId: 's', project: null, turns: [t('r1', 5, '2026-10-15T10:00:00Z'), t('r1', 9, '2026-10-15T10:00:00Z')],
    calls: [], results: [], compactions: 0, skills: {}, uts: [] }, NOW);
  assert.equal(m.apiTurns, 1);
  assert.equal(m.tokens.output, 9); // last occurrence wins
});

test('aggregates: cacheHitRatio zero denominator → 0; costUsd null when absent', () => {
  const t = (u) => ({ requestId: 'r', timestamp: '2026-10-15T10:00:00Z', model: 'm', usage: u });
  const m = computeMetrics({ sessionId: 's', project: null, turns: [t({ input: 1, output: 1 })],
    calls: [], results: [], compactions: 0, skills: {}, uts: [] }, NOW);
  assert.equal(m.cacheHitRatio, 0);
  assert.equal(m.costUsd, null);
});

test('aggregates: empty session → valid:false, aggregates null', () => {
  const m = computeMetrics(sessionFromPath(join(FIX, 'empty.jsonl')), NOW);
  assert.equal(m.valid, false);
  assert.equal(m.apiTurns, null); // invalid → aggregates null (spec §4)
  assert.equal(m.durationMs, null);
  assert.equal(m.costUsd, null);
  assert.equal(m.batch, null);
  assert.deepEqual(m.tools, {});
  assert.deepEqual(m.reads, { calls: 0, repeats: 0, repeatRate: null });
  assert.deepEqual(m.edits, { attempts: 0, failures: 0, failureRate: null, failedThenSucceeded: 0, failedTerminal: 0 });
});

test('aggregates: partial flag (last event within 5 min of now)', () => {
  const near = Date.parse('2026-10-15T10:02:00Z') + 4 * 60 * 1000; // < 5 min after last event
  assert.equal(computeMetrics(goldenSession, near).partial, true);
  assert.equal(computeMetrics(goldenSession, NOW).partial, false);
});

test('aggregates: durationMs null when fewer than two ts events', () => {
  const m = computeMetrics({ sessionId: 's', project: null,
    turns: [{ requestId: 'r', timestamp: '2026-10-15T10:00:00Z', model: 'm', usage: { input: 1, output: 1 } }],
    calls: [], results: [], compactions: 0, skills: {}, uts: [] }, NOW);
  assert.equal(m.durationMs, null);
});

// ---------------------------------------------------------------- parity gate (Step 8)

test('parity: parser path ≡ extract path on the golden fixture', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const a = computeMetrics(sessionFromPath(goldenPath), now);
  const b = computeMetrics(sessionFromExtract(goldenExtract), now);
  assert.deepEqual(b, a);
});

// ---------------------------------------------------------------- CLI (Step 9)

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'session-audit', 'scripts', 'metrics.mjs');
const SESSIONS_DIR = join(FIX, 'sessions');

const runCli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const SCHEMA_KEYS = ['schema', 'sessionId', 'project', 'generatedAt', 'valid', 'partial', 'durationMs',
  'apiTurns', 'tokens', 'cacheHitRatio', 'costUsd', 'batch', 'compactions', 'skills', 'tools',
  'reads', 'edits', 'unmatchedCalls'];

test('cli: path arg → exit 0, compact JSON with every schema key', () => {
  const r = runCli(goldenPath);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1); // compact single line
  const m = JSON.parse(r.stdout);
  for (const k of SCHEMA_KEYS) assert.ok(k in m, `key ${k}`);
  assert.equal(m.schema, 's1-metrics/1');
  assert.equal(m.valid, true);
});

test('cli: --pretty emits multi-line JSON', () => {
  const r = runCli(goldenPath, '--pretty');
  assert.equal(r.status, 0);
  assert.ok(r.stdout.trim().split('\n').length > 1);
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)).sort(), [...SCHEMA_KEYS].sort());
});

test('cli: session id resolution via --sessions-dir', () => {
  const r = runCli('golden', '--sessions-dir', SESSIONS_DIR);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  assert.equal(m.sessionId, 'golden');
  assert.equal(m.apiTurns, 5);
});

test('cli: not-found → exit 1, {error} JSON on stderr', () => {
  const r = runCli('no-such-session', '--sessions-dir', SESSIONS_DIR);
  assert.equal(r.status, 1);
  const e = JSON.parse(r.stderr);
  assert.ok(typeof e.error === 'string' && e.error.includes('not found'));
  assert.equal(e.sessionId, 'no-such-session');
  assert.equal(r.stdout, '');
});

test('cli: unreadable path → exit 1, {error} JSON on stderr', () => {
  const r = runCli(join(FIX, 'does-not-exist.jsonl'));
  assert.equal(r.status, 1);
  assert.ok(JSON.parse(r.stderr).error);
});

test('cli: empty session → exit 0, valid:false', () => {
  const r = runCli(join(FIX, 'empty.jsonl'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).valid, false);
});

// repo pattern: directly executable
test('direct execution exits non-zero on failure', () => {
  assert.notEqual(runCli('nope', '--sessions-dir', SESSIONS_DIR).status, 0);
});
