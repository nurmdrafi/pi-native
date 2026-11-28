import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/check-portable-diff.mjs', import.meta.url));
const hunk = '@@ -1 +1 @@\n';
const machinePath = ['','home','example-user','.pi','agent'].join('/');
const check = input => spawnSync(process.execPath, [script], { input, encoding: 'utf8' });

test('rejects machine-specific homes on added lines without echoing them', () => {
  const result = check(hunk + `-old\n+path=${machinePath}/docs\n`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rules\/portability\.md/);
  assert.ok(!result.stderr.includes(machinePath));
});

test('accepts portable additions and ignores deleted lines', () => {
  const result = check(hunk + `-${machinePath}\n+~/.pi/agent/docs $HOME/.pi/agent rules/portability.md\n`);
  assert.equal(result.status, 0);
});
