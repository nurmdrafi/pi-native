import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');

const HARNESS_PIPED = `
. scripts/lib/progress.sh
ui_total 3
ui_run "npm deps" sh -c 'sleep 0.2; echo installed' && echo RC1=0
ui_step "quick note"
ui_run "cargo build" sh -c 'echo boom >&2; exit 3' || echo RC2=$?
ui_finish "after-pull"
`;

function runPiped(code) {
  return spawnSync('sh', ['-c', code], { encoding: 'utf8', cwd: REPO });
}

test('progress lib renders plain lines when piped (no TTY)', () => {
  const r = runPiped(HARNESS_PIPED);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /\[1\/3\] npm deps — ok \(0\.\d+s\)/);
  assert.match(out, /\[3\/3\] cargo build — FAILED \(0\.\d+s\)/);
  assert.match(out, /boom/);
  assert.match(out, /RC1=0/);
  assert.match(out, /RC2=3/);
  assert.match(out, /quick note/);
  assert.match(out, /!! after-pull: 1\/3 failed — 0\.\d+s total/);
  assert.ok(!out.includes('\r'), 'piped mode must not emit CR redraws');
});

test('progress lib animates with CR redraws under a TTY', { skip: process.platform === 'win32' }, () => {
  const log = join(tmpdir(), `progress-ui-tty-${process.pid}.log`);
  const r = spawnSync(
    'script',
    ['-qec', `sh -c '${HARNESS_PIPED.replace(/'/g, `'\\''`)}'`, log],
    { encoding: 'utf8', cwd: REPO },
  );
  if (r.error || r.status !== 0) return; // no `script` util → skip silently
  const out = readFileSync(log, 'utf8');
  assert.ok((out.match(/\r/g) || []).length >= 2, 'expected live redraw frames');
  assert.match(out, /\[1\/3\] npm deps — ok/);
  assert.match(out, /\[3\/3\] cargo build — FAILED/);
  assert.match(out, /boom/);
});
