#!/usr/bin/env node
// Regenerates .github/badges/tests.json from a real `node --test` run (TAP).
// Honest by construction: the count comes from executing the suite, and the
// badge turns orange with the failure count while any test fails.
// Manual regen (runs the full suite, ~minutes): npm run tests:badge

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, '.github/badges/tests.json');

export function parseTapCounts(tap) {
  const pick = (k) => Number((tap.match(new RegExp(`^# ${k} (\\d+)$`, 'm')) || [])[1]);
  const tests = pick('tests');
  const pass = pick('pass');
  const fail = pick('fail');
  if (![tests, pass, fail].every(Number.isInteger)) {
    throw new Error('TAP summary lines not found (# tests / # pass / # fail)');
  }
  return { tests, pass, fail };
}

export function mergeCounts(list) {
  return list.reduce((a, c) => ({ tests: a.tests + c.tests, pass: a.pass + c.pass, fail: a.fail + c.fail }));
}

function runSuite(args) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return parseTapCounts(`${r.stdout}\n${r.stderr || ''}`);
}

function main() {
  // Two suites, mirroring `npm test` and `npm run test:subagents` exactly:
  // the main .mjs globs and the subagents extension's TS suite (runner import).
  const counts = mergeCounts([
    runSuite(['tests/**/*.test.mjs', 'dashboard/tests/**/*.test.mjs']),
    runSuite(['--import', './tests/subagents/runner.ts', 'tests/subagents/*.test.ts']),
  ]);
  const message = counts.fail > 0 ? `${counts.tests} · ${counts.fail} fail` : `${counts.tests}`;
  const color = counts.fail > 0 ? 'd29922' : '2ea44f';
  const badge = { schemaVersion: 1, label: 'tests', message, color, labelColor: '24292f', cacheSeconds: 3600 };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(badge, null, 2)}\n`);
  console.log(`tests badge: ${message} (${color}) -> ${OUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
