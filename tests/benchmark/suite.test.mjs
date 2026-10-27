#!/usr/bin/env node
/**
 * S2 benchmark-suite tests (spec: docs/specs/2026-10-15-s2-benchmark-design.md §11).
 * Run: node --test tests/bench-suite.test.mjs  (or directly).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadArms, getArm, discoverTasks, getTask } from '../../benchmark/lib/manifests.mjs';
import { newRunId, prepareWorkdir } from '../../benchmark/lib/workdir.mjs';
import { runValidator } from '../../benchmark/lib/validate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, '..', '..', 'benchmark');
const FIX = join(HERE, '..', 'fixtures', 'bench');
const tmp = () => mkdtempSync(join(tmpdir(), 'bench-suite-'));

const runCli = (...args) => spawnSync(process.execPath, [join(BENCH, 'bench.mjs'), ...args], { encoding: 'utf8' });

// ---------------------------------------------------------------- manifests (Step 1)

test('manifests: arms.json loads with a baseline:true entry', () => {
  const arms = loadArms(join(BENCH, 'arms.json'));
  assert.ok(Array.isArray(arms) && arms.length >= 2);
  assert.equal(arms.filter((a) => a.baseline).length, 1);
  const b = getArm(arms, 'baseline');
  assert.equal(b.baseline, true);
  for (const k of ['name', 'description', 'config']) assert.equal(typeof b[k], 'string', `arm.${k}`);
});

test('manifests: unknown arm name rejected', () => {
  const arms = loadArms(join(BENCH, 'arms.json'));
  assert.throws(() => getArm(arms, 'nope'), /unknown arm: nope/);
});

test('manifests: arms.json rejects zero or multiple baselines', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'a.json'), JSON.stringify([{ name: 'x', description: 'd', config: 'c' }]));
  assert.throws(() => loadArms(join(dir, 'a.json')), /baseline/);
  writeFileSync(join(dir, 'b.json'),
    JSON.stringify([{ name: 'x', description: 'd', config: 'c', baseline: true }, { name: 'y', description: 'd', config: 'c', baseline: true }]));
  assert.throws(() => loadArms(join(dir, 'b.json')), /baseline/);
  rmSync(dir, { recursive: true, force: true });
});

const mkTask = (root, id, taskJson) => {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, 'task.json'), JSON.stringify(taskJson));
};

test('manifests: discoverTasks walks <class>/<id>/task.json and returns sorted entries', () => {
  const dir = tmp();
  mkTask(dir, 'bugfix/t1', { id: 'bugfix/t1', class: 'bugfix', title: 'B1', prompt: 'fix t1' });
  mkTask(dir, 'feature/t2', { id: 'feature/t2', class: 'feature', title: 'F2', prompt: 'add f2' });
  const tasks = discoverTasks(dir);
  assert.deepEqual(tasks.map((t) => t.id), ['bugfix/t1', 'feature/t2']);
  assert.equal(tasks[0].dir, join(dir, 'bugfix/t1'));
  assert.equal(tasks[0].title, 'B1');
  assert.equal(tasks[0].prompt, 'fix t1');
  rmSync(dir, { recursive: true, force: true });
});

test('manifests: task.json missing prompt rejected', () => {
  const dir = tmp();
  mkTask(dir, 'bugfix/t1', { id: 'bugfix/t1', class: 'bugfix', title: 'B1' });
  assert.throws(() => discoverTasks(dir), /prompt/);
  rmSync(dir, { recursive: true, force: true });
});

test('manifests: task id/path mismatch rejected', () => {
  const dir = tmp();
  mkTask(dir, 'bugfix/t1', { id: 'bugfix/t9', class: 'bugfix', title: 'B', prompt: 'p' });
  assert.throws(() => discoverTasks(dir), /id mismatch/);
  rmSync(dir, { recursive: true, force: true });
});

test('manifests: getTask unknown id rejected; traversal rejected', () => {
  const dir = tmp();
  mkTask(dir, 'bugfix/t1', { id: 'bugfix/t1', class: 'bugfix', title: 'B', prompt: 'p' });
  assert.equal(getTask(dir, 'bugfix/t1').id, 'bugfix/t1');
  assert.throws(() => getTask(dir, 'bugfix/zz'), /unknown task: bugfix\/zz/);
  assert.throws(() => getTask(dir, '../evil'), /invalid task id/);
  rmSync(dir, { recursive: true, force: true });
});

// Run records are cited from docs/native-tools.md and docs/rust-tools-architecture.md,
// so the directory must stay trackable: gitignoring it breaks every committed link.
test('scaffolding: benchmark/runs stays trackable (docs cite the records)', () => {
  const gi = readFileSync(join(HERE, '..', '..', '.gitignore'), 'utf8');
  assert.ok(!/(^|\n)benchmark\/runs\/(\n|$)/.test(gi), 'benchmark/runs/ must not be gitignored');
});

// ---------------------------------------------------------------- workdir prep (Step 3)

const SYN = join(FIX, 'task-syn');

test('workdir: prepareWorkdir copies fixture, git-inits, and commits (spec §7.1)', () => {
  const runsRoot = tmp();
  const { runId, runDir, workDir } = prepareWorkdir(SYN, runsRoot);
  assert.match(runId, /^\d{8}T\d{6}-bugfix-task-syn$/);
  assert.equal(runDir, join(runsRoot, runId));
  assert.equal(workDir, join(runDir, 'work'));
  assert.ok(existsSync(join(workDir, '.git')));
  assert.equal(readFileSync(join(workDir, 'failing.js'), 'utf8'),
    readFileSync(join(SYN, 'fixture', 'failing.js'), 'utf8'));
  const log = spawnSync('git', ['-C', workDir, 'log', '--oneline'], { encoding: 'utf8' });
  assert.equal(log.status, 0);
  assert.ok(log.stdout.trim().length > 0, 'initial commit exists');
  // source fixture untouched
  assert.ok(!existsSync(join(SYN, 'fixture', '.git')));
  rmSync(runsRoot, { recursive: true, force: true });
});

test('workdir: runId collisions within the same second get a -2 suffix', () => {
  const runsRoot = tmp();
  const a = prepareWorkdir(SYN, runsRoot);
  const b = prepareWorkdir(SYN, runsRoot);
  assert.notEqual(a.runId, b.runId);
  // Only assert the suffix relationship when both landed in the same second.
  // The two calls can straddle a tick, in which case the runIds differ by
  // timestamp alone and there is no shared base to compare against.
  const baseOf = (id) => id.replace(/-(\d+)$/, '');
  if (baseOf(a.runId) === baseOf(b.runId)) {
    assert.equal(baseOf(b.runId), baseOf(a.runId));
    assert.match(b.runId, /-2$/);
  }
  assert.ok(existsSync(join(b.workDir, 'failing.js')));
  rmSync(runsRoot, { recursive: true, force: true });
});

test('workdir: missing fixture dir throws', () => {
  assert.throws(() => prepareWorkdir(join(FIX, 'no-such'), tmp()), /fixture/);
});

/** Copy task-syn into a discoverable <root>/bugfix/task-syn layout. */
const synTasksRoot = () => {
  const root = tmp();
  cpSync(SYN, join(root, 'bugfix', 'task-syn'), { recursive: true });
  return root;
};

// ---------------------------------------------------------------- start (Step 4)

test('start: creates work + run.json stub, prints prompt/config/workdir/hint (spec §7.1)', () => {
  const tasksRoot = synTasksRoot();
  const runsRoot = tmp();
  const r = runCli('start', '--task', 'bugfix/task-syn', '--arm', 'baseline',
    '--tasks-dir', tasksRoot, '--runs-root', runsRoot);
  assert.equal(r.status, 0, r.stderr);
  const ids = readdirSync(runsRoot);
  assert.equal(ids.length, 1);
  const stub = JSON.parse(readFileSync(join(runsRoot, ids[0], 'run.json'), 'utf8'));
  assert.equal(stub.status, 'started');
  assert.equal(stub.task, 'bugfix/task-syn');
  assert.equal(stub.arm, 'baseline');
  assert.equal(stub.runId, ids[0]);
  assert.ok(!Number.isNaN(Date.parse(stub.startedAt)));
  assert.ok(existsSync(join(runsRoot, ids[0], 'work', 'failing.js')));
  const prompt = JSON.parse(readFileSync(join(SYN, 'task.json'), 'utf8')).prompt;
  const config = JSON.parse(readFileSync(join(BENCH, 'arms.json'), 'utf8')).find((a) => a.name === 'baseline').config;
  assert.ok(r.stdout.includes(prompt), 'stdout has task prompt');
  assert.ok(r.stdout.includes(config), 'stdout has arm config');
  assert.ok(r.stdout.includes(join(runsRoot, ids[0], 'work')), 'stdout has workdir path');
  assert.ok(r.stdout.includes(`finish --run ${ids[0]}`), 'stdout has next-step hint');
  rmSync(tasksRoot, { recursive: true, force: true });
  rmSync(runsRoot, { recursive: true, force: true });
});

test('start: unknown task → exit 1, {error} JSON stderr (spec §10)', () => {
  const r = runCli('start', '--task', 'bugfix/nope', '--arm', 'baseline',
    '--tasks-dir', synTasksRoot(), '--runs-root', tmp());
  assert.equal(r.status, 1);
  assert.ok(JSON.parse(r.stderr).error.includes('unknown task'));
});

test('start: unknown arm → exit 1, {error} JSON stderr (spec §10)', () => {
  const r = runCli('start', '--task', 'bugfix/task-syn', '--arm', 'nope',
    '--tasks-dir', synTasksRoot(), '--runs-root', tmp());
  assert.equal(r.status, 1);
  assert.ok(JSON.parse(r.stderr).error.includes('unknown arm'));
});

// ---------------------------------------------------------------- validator runner (Step 5)

/** Prepared workdir for task-syn, optionally with solution.patch applied. */
const synWorkdir = (patched) => {
  const runsRoot = tmp();
  const { workDir } = prepareWorkdir(SYN, runsRoot);
  if (patched) {
    const r = spawnSync('git', ['-C', workDir, 'apply', join(SYN, 'solution.patch')]);
    assert.equal(r.status, 0, 'solution.patch applied');
  }
  return { runsRoot, workDir };
};

test('validator: pristine workdir → parsed {pass:false, checks[]} (spec §5.2)', () => {
  const { runsRoot, workDir } = synWorkdir(false);
  const g = runValidator(SYN, workDir);
  assert.equal(g.pass, false);
  assert.ok(Array.isArray(g.checks) && g.checks.length >= 2);
  assert.ok(g.checks.some((c) => c.name === 'tests-green' && !c.pass));
  rmSync(runsRoot, { recursive: true, force: true });
});

test('validator: patched workdir → pass:true', () => {
  const { runsRoot, workDir } = synWorkdir(true);
  const g = runValidator(SYN, workDir);
  assert.equal(g.pass, true);
  assert.ok(g.checks.every((c) => c.pass));
  rmSync(runsRoot, { recursive: true, force: true });
});

test('validator: crashing validator → synthetic validator-crash check (spec §10)', () => {
  const taskDir = tmp();
  writeFileSync(join(taskDir, 'validate.mjs'), 'console.error("boom"); process.exit(3);\n');
  const { runsRoot, workDir } = synWorkdir(false);
  const g = runValidator(taskDir, workDir);
  assert.equal(g.pass, false);
  const crash = g.checks.find((c) => c.name === 'validator-crash');
  assert.ok(crash && crash.pass === false);
  assert.match(crash.detail, /boom/);
  rmSync(taskDir, { recursive: true, force: true });
  rmSync(runsRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- finish (Step 6)

/** start → (optionally patch workdir) → finish; returns everything for assertions. */
const finishFlow = ({ patched = true, session = 'session-syn', finishArgs = [] } = {}) => {
  const tasksRoot = synTasksRoot();
  const runsRoot = tmp();
  const resultsDir = tmp();
  const s = runCli('start', '--task', 'bugfix/task-syn', '--arm', 'baseline',
    '--tasks-dir', tasksRoot, '--runs-root', runsRoot);
  assert.equal(s.status, 0, s.stderr);
  const runId = readdirSync(runsRoot)[0];
  const workDir = join(runsRoot, runId, 'work');
  if (patched) {
    assert.equal(spawnSync('git', ['-C', workDir, 'apply', join(SYN, 'solution.patch')]).status, 0);
  }
  const f = runCli('finish', '--run', runId, '--session', session,
    '--sessions-dir', FIX, '--tasks-dir', tasksRoot, '--runs-root', runsRoot,
    '--results-dir', resultsDir, ...finishArgs);
  return { f, runId, workDir, tasksRoot, runsRoot, resultsDir };
};

test('finish: patched run → s2-run/1 record with embedded s1-metrics/1 (spec §8)', () => {
  const { f, runId, resultsDir, runsRoot, tasksRoot } = finishFlow({});
  assert.equal(f.status, 0, f.stderr);
  const rec = JSON.parse(readFileSync(join(resultsDir, `${runId}.json`), 'utf8'));
  assert.equal(rec.schema, 's2-run/1');
  assert.equal(rec.runId, runId);
  assert.equal(rec.task, 'bugfix/task-syn');
  assert.equal(rec.arm, 'baseline');
  assert.ok(!Number.isNaN(Date.parse(rec.startedAt)));
  assert.ok(!Number.isNaN(Date.parse(rec.finishedAt)));
  assert.equal(rec.sessionId, 'session-syn');
  assert.equal(rec.grade, 'SUCCESS');
  assert.ok(Array.isArray(rec.checks) && rec.checks.every((c) => c.pass));
  assert.equal(rec.metrics.schema, 's1-metrics/1');
  assert.equal(rec.metrics.sessionId, 'session-syn');
  assert.equal(rec.metricsError, null);
  // stub flipped to done + summary line
  assert.equal(JSON.parse(readFileSync(join(runsRoot, runId, 'run.json'), 'utf8')).status, 'done');
  assert.match(f.stdout, /SUCCESS/);
  rmSync(runsRoot, { recursive: true, force: true });
  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(tasksRoot, { recursive: true, force: true });
});

test('finish: pristine run → grade FAIL, exit 0', () => {
  const { f, runId, resultsDir, runsRoot, tasksRoot } = finishFlow({ patched: false });
  assert.equal(f.status, 0, f.stderr);
  const rec = JSON.parse(readFileSync(join(resultsDir, `${runId}.json`), 'utf8'));
  assert.equal(rec.grade, 'FAIL');
  assert.ok(rec.checks.some((c) => !c.pass));
  rmSync(runsRoot, { recursive: true, force: true });
  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(tasksRoot, { recursive: true, force: true });
});

test('finish: double-finish → exit 1, {error} JSON stderr (spec §10)', () => {
  const { f, runId, resultsDir, runsRoot, tasksRoot } = finishFlow({});
  assert.equal(f.status, 0, f.stderr);
  const again = runCli('finish', '--run', runId, '--session', 'session-syn',
    '--sessions-dir', FIX, '--tasks-dir', tasksRoot, '--runs-root', runsRoot, '--results-dir', resultsDir);
  assert.equal(again.status, 1);
  assert.ok(JSON.parse(again.stderr).error.includes('already finished'));
  rmSync(runsRoot, { recursive: true, force: true });
  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(tasksRoot, { recursive: true, force: true });
});

test('finish: unknown run → exit 1, {error} JSON stderr', () => {
  const r = runCli('finish', '--run', 'nope', '--session', 'x', '--runs-root', tmp(), '--results-dir', tmp());
  assert.equal(r.status, 1);
  assert.ok(JSON.parse(r.stderr).error.includes('unknown run'));
});

test('finish: unknown session → metrics:null + metricsError, grade still recorded (spec §10)', () => {
  const { f, runId, resultsDir, runsRoot, tasksRoot } = finishFlow({ session: 'no-such-session' });
  assert.equal(f.status, 0, f.stderr);
  const rec = JSON.parse(readFileSync(join(resultsDir, `${runId}.json`), 'utf8'));
  assert.equal(rec.grade, 'SUCCESS');
  assert.equal(rec.metrics, null);
  assert.ok(typeof rec.metricsError === 'string' && rec.metricsError.length > 0);
  rmSync(runsRoot, { recursive: true, force: true });
  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(tasksRoot, { recursive: true, force: true });
});

test('finish: schema pin — wrong s1-metrics schema throws loudly (spec §12)', async () => {
  const { runMetrics } = await import('../../benchmark/lib/metrics.mjs');
  const dir = tmp();
  const fake = join(dir, 'fake-metrics.mjs');
  writeFileSync(fake, 'console.log(JSON.stringify({ schema: "s1-metrics/9", sessionId: "x" }));\n');
  assert.throws(() => runMetrics('x', { metricsScript: fake }), /schema mismatch/);
  const failing = join(dir, 'failing-metrics.mjs');
  writeFileSync(failing, 'console.error(JSON.stringify({ error: "boom" })); process.exit(1);\n');
  const r = runMetrics('x', { metricsScript: failing });
  assert.equal(r.metrics, null);
  assert.match(r.metricsError, /boom/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- aggregation (Step 7)

const { median, aggregateCells, metricValues } = await import('../../benchmark/lib/aggregate.mjs');

test('aggregate: median nearest-rank, n=1, null-skipping (spec §9)', () => {
  assert.deepEqual(median([3]), { value: 3, n: 1 });
  assert.deepEqual(median([9, 1, 5]), { value: 5, n: 3 });
  assert.deepEqual(median([5, 9]), { value: 5, n: 2 }); // nearest-rank, consistent with S1
  assert.deepEqual(median([null, 4, null, 2]), { value: 2, n: 2 }); // non-null [2,4] → rank 1 → 2
  assert.deepEqual(median([null, null]), null);
});

/** Synthetic s2-run/1 record for pure aggregation tests. */
const mkMetrics = (over = {}) => ({
  schema: 's1-metrics/1', partial: false,
  durationMs: 1000, apiTurns: 5,
  tokens: { input: 100, output: 50, peakContext: 150 },
  costUsd: 0.01, cacheHitRatio: 0.5,
  tools: { bash: { latencyMs: { p95: 100 } }, read: { latencyMs: { p95: 200 } } },
  edits: { failureRate: 0.1 }, reads: { repeatRate: 0.2 },
  ...over,
});
const mkRec = (over = {}) => ({
  schema: 's2-run/1', runId: 'r', task: 'bugfix/t1', arm: 'baseline',
  grade: 'SUCCESS', metrics: mkMetrics(), metricsError: null, ...over,
});

test('aggregate: cells group by (task,arm) with success rate and medians', () => {
  const cells = aggregateCells([
    mkRec(), mkRec({ grade: 'FAIL' }), mkRec({ metrics: mkMetrics({ durationMs: 3000, costUsd: null }) }),
    mkRec({ arm: 'candidate', metrics: mkMetrics({ durationMs: 2000, apiTurns: 7 }) }),
  ]);
  assert.equal(cells.length, 2);
  const base = cells.find((c) => c.arm === 'baseline');
  assert.equal(base.n, 3);
  assert.equal(base.successRate, 2 / 3);
  assert.deepEqual(base.medians.durationMs, { value: 1000, n: 3 });
  assert.deepEqual(base.medians.costUsd, { value: 0.01, n: 2 }); // null skipped, n = non-null
  assert.deepEqual(base.medians.worstToolP95, { value: 200, n: 3 });
  const cand = cells.find((c) => c.arm === 'candidate');
  assert.deepEqual(cand.medians.durationMs, { value: 2000, n: 1 }); // n=1 → the single value
  assert.deepEqual(cand.medians.apiTurns, { value: 7, n: 1 });
});

test('aggregate: partial records excluded unless includePartial; counted per cell', () => {
  const partial = mkRec({ metrics: mkMetrics({ partial: true, durationMs: 9999 }) });
  const cells = aggregateCells([mkRec(), partial]);
  const base = cells.find((c) => c.arm === 'baseline');
  assert.equal(base.n, 1);
  assert.equal(base.partialExcluded, 1);
  assert.deepEqual(base.medians.durationMs, { value: 1000, n: 1 });
  const incl = aggregateCells([mkRec(), partial], { includePartial: true }).find((c) => c.arm === 'baseline');
  assert.equal(incl.n, 2);
  assert.deepEqual(incl.medians.durationMs, { value: 1000, n: 2 });
});

test('aggregate: metrics-null records mark cell metricsIncomplete and contribute nothing', () => {
  const cells = aggregateCells([mkRec(), mkRec({ metrics: null, metricsError: 'boom' })]);
  const base = cells.find((c) => c.arm === 'baseline');
  assert.equal(base.metricsIncomplete, true);
  assert.equal(base.n, 2); // grade still counted
  assert.deepEqual(base.medians.durationMs, { value: 1000, n: 1 }); // only the metrics-bearing run
});

test('aggregate: empty input → no cells', () => {
  assert.deepEqual(aggregateCells([]), []);
});

test('aggregate: metricValues maps a record to the report metric list', () => {
  const v = metricValues(mkRec().metrics);
  assert.equal(v.durationMs, 1000);
  assert.equal(v.tokensInput, 100);
  assert.equal(v.tokensOutput, 50);
  assert.equal(v.tokensPeak, 150);
  assert.equal(v.costUsd, 0.01);
  assert.equal(v.cacheHitRatio, 0.5);
  assert.equal(v.apiTurns, 5);
  assert.equal(v.worstToolP95, 200);
  assert.equal(v.editFailureRate, 0.1);
  assert.equal(v.readRepeatRate, 0.2);
  assert.deepEqual(metricValues(null), Object.fromEntries(
    ['durationMs', 'tokensInput', 'tokensOutput', 'tokensPeak', 'costUsd', 'cacheHitRatio',
      'apiTurns', 'worstToolP95', 'editFailureRate', 'readRepeatRate'].map((k) => [k, null])));
});

// ---------------------------------------------------------------- report (Step 8)

const reportSetup = (records) => {
  const resultsDir = tmp();
  for (const r of records) {
    writeFileSync(join(resultsDir, `${r.runId}.json`), JSON.stringify({ ...mkRec(), ...r }));
  }
  return { resultsDir, reportsDir: tmp() };
};
const REC_T1A = mkRec({ runId: 'a1', task: 'bugfix/t1', arm: 'baseline' });
const REC_T1B = mkRec({ runId: 'a2', task: 'bugfix/t1', arm: 'baseline', grade: 'FAIL' });
const REC_T2C = mkRec({ runId: 'a3', task: 'feature/t1', arm: 'candidate',
  metrics: mkMetrics({ durationMs: 5000, partial: true }) });

test('report: renders md + json sibling with per-(task,arm) cells (spec §9)', () => {
  const { resultsDir, reportsDir } = reportSetup([REC_T1A, REC_T1B, REC_T2C]);
  const r = runCli('report', '--results-dir', resultsDir, '--reports-dir', reportsDir);
  assert.equal(r.status, 0, r.stderr);
  const mdFile = readdirSync(reportsDir).find((f) => f.endsWith('.md'));
  assert.match(mdFile, /^report-\d{4}-\d{2}-\d{2}\.md$/);
  const md = readFileSync(join(reportsDir, mdFile), 'utf8');
  assert.ok(md.includes('# S2 benchmark report'));
  assert.ok(md.includes('bugfix/t1'));
  assert.ok(md.includes('feature/t1'));
  assert.ok(md.includes('baseline'));
  assert.ok(md.includes('candidate'));
  assert.ok(/\| baseline\*? .*\| 2 \| 1\/2 .*\| 1000 /.test(md), 'n, success, durationMs columns');
  assert.ok(md.includes('≥3'), 'protocol note');
  const jsonFile = mdFile.replace(/\.md$/, '.json');
  const payload = JSON.parse(readFileSync(join(reportsDir, jsonFile), 'utf8'));
  assert.equal(payload.schema, 's2-report/1');
  assert.equal(payload.date, mdFile.match(/^report-(\d{4}-\d{2}-\d{2})\.md$/)[1]);
  assert.deepEqual(payload.arms, ['baseline', 'candidate']);
  assert.deepEqual(payload.tasks, ['bugfix/t1', 'feature/t1']);
  assert.equal(payload.cells.length, 2);
  const t1 = payload.cells.find((c) => c.task === 'bugfix/t1');
  assert.equal(t1.arm, 'baseline');
  assert.equal(t1.n, 2);
  assert.equal(t1.successRate, 0.5);
  assert.deepEqual(t1.medians.durationMs, { value: 1000, n: 2 });
  assert.equal(t1.partialExcluded, 0);
  assert.equal(t1.metricsIncomplete, false);
  // partial excluded by default, counted
  const t2 = payload.cells.find((c) => c.task === 'feature/t1');
  assert.equal(t2.n, 0);
  assert.equal(t2.partialExcluded, 1);
  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(reportsDir, { recursive: true, force: true });
});

test('report: --include-partial folds partial runs into cells', () => {
  const { resultsDir, reportsDir } = reportSetup([REC_T1A, REC_T2C]);
  const r = runCli('report', '--include-partial', '--results-dir', resultsDir, '--reports-dir', reportsDir);
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(readFileSync(join(reportsDir, readdirSync(reportsDir).find((f) => f.endsWith('.json'))), 'utf8'));
  const t2 = payload.cells.find((c) => c.task === 'feature/t1');
  assert.equal(t2.n, 1);
  assert.equal(t2.partialExcluded, 0);
  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(reportsDir, { recursive: true, force: true });
});

test('report: same-day rerun suffixed -2 (md + json, never overwriting)', () => {
  const { resultsDir, reportsDir } = reportSetup([REC_T1A]);
  for (let i = 0; i < 2; i++) {
    assert.equal(runCli('report', '--results-dir', resultsDir, '--reports-dir', reportsDir).status, 0);
  }
  const files = readdirSync(reportsDir).sort();
  assert.equal(files.length, 4);
  assert.ok(files.some((f) => /^report-\d{4}-\d{2}-\d{2}\.md$/.test(f)), 'plain base exists');
  assert.ok(files.some((f) => /^report-\d{4}-\d{2}-\d{2}-2\.md$/.test(f)), '-2 md exists');
  assert.ok(files.some((f) => /^report-\d{4}-\d{2}-\d{2}-2\.json$/.test(f)), '-2 json exists');
  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(reportsDir, { recursive: true, force: true });
});

test('report: --task/--arm filters restrict cells', () => {
  const { resultsDir, reportsDir } = reportSetup([REC_T1A, REC_T2C]);
  const r = runCli('report', '--task', 'feature/t1', '--arm', 'candidate',
    '--results-dir', resultsDir, '--reports-dir', reportsDir);
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(readFileSync(join(reportsDir, readdirSync(reportsDir).find((f) => f.endsWith('.json'))), 'utf8'));
  assert.deepEqual(payload.tasks, ['feature/t1']);
  assert.deepEqual(payload.arms, ['candidate']);
  assert.equal(payload.cells.length, 1);
  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(reportsDir, { recursive: true, force: true });
});

test('report: zero completed runs → message, exit 0, no file (spec §10)', () => {
  const reportsDir = tmp();
  const r = runCli('report', '--results-dir', tmp(), '--reports-dir', reportsDir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no completed runs/i);
  assert.deepEqual(readdirSync(reportsDir), []);
  rmSync(reportsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- list (Step 9)

test('list: tasks, arms, and run counts per task × arm (spec §7.5)', () => {
  const { resultsDir } = reportSetup([
    mkRec({ runId: 's1', task: 'bugfix/task-syn', arm: 'baseline' }),
    mkRec({ runId: 's2', task: 'bugfix/task-syn', arm: 'baseline', grade: 'FAIL' }),
    mkRec({ runId: 's3', task: 'bugfix/task-syn', arm: 'piedit-native' }),
  ]);
  const r = runCli('list', '--tasks-dir', synTasksRoot(), '--results-dir', resultsDir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('bugfix/task-syn'));
  assert.ok(r.stdout.includes('bugfix'));
  assert.ok(r.stdout.includes('Synthetic: fix double() off-by-one'));
  assert.ok(r.stdout.includes('baseline'));
  assert.ok(r.stdout.includes('piedit-native'));
  assert.ok(/bugfix\/task-syn\s*×\s*baseline:\s*2/.test(r.stdout), 'run count per task × arm');
  assert.ok(/bugfix\/task-syn\s*×\s*piedit-native:\s*1/.test(r.stdout));
  rmSync(resultsDir, { recursive: true, force: true });
});

test('list: zero runs → counts render 0, exit 0', () => {
  const r = runCli('list', '--tasks-dir', synTasksRoot(), '--results-dir', tmp());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(/bugfix\/task-syn\s*×\s*baseline:\s*0/.test(r.stdout));
});

// ---------------------------------------------------------------- check-tasks (Step 10)

test('check-tasks: task-syn pristine fails + patched passes → exit 0 (spec §5.4)', () => {
  const r = runCli('check-tasks', '--tasks-dir', synTasksRoot());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK bugfix\/task-syn/);
  assert.ok(!/FAIL/.test(r.stdout));
});

test('check-tasks: already-solved fixture → per-task FAIL line + exit 1 (spec §5.4, §10)', () => {
  const tasksRoot = synTasksRoot();
  // invert: pre-fix the shipped fixture so pristine validation already passes
  const f = join(tasksRoot, 'bugfix', 'task-syn', 'fixture', 'failing.js');
  writeFileSync(f, readFileSync(f, 'utf8').replace('return n * 2 + 1;', 'return n * 2;'));
  const r = runCli('check-tasks', '--tasks-dir', tasksRoot);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL bugfix\/task-syn/);
  rmSync(tasksRoot, { recursive: true, force: true });
});
