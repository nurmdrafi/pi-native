import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function fixture(t, hashMatches = false) {
  const root = mkdtempSync(join(tmpdir(), 'pi-install-bx-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mocks = join(root, 'mocks');
  const scripts = join(root, 'scripts');
  mkdirSync(mocks);
  mkdirSync(scripts);
  const script = join(scripts, 'install-bx.sh');
  copyFileSync(new URL('../../scripts/install-bx.sh', import.meta.url), script);
  const bin = join(root, 'bin', 'bx');
  const mock = (name, body) => {
    const path = join(mocks, name);
    writeFileSync(path, `#!/usr/bin/env sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  mock('uname', 'case "$1" in -s) echo Linux;; -m) echo x86_64;; esac');
  mock('curl', 'while [ "$1" != -o ]; do shift; done\nprintf payload > "$2"');
  if (hashMatches) mock('shasum', 'echo "d45dd826436b95dac750e80e10e497a3feca3f8841fe51f940c0703f14cf0d39  -"');
  const env = { ...process.env, PATH: `${mocks}:${process.env.PATH}` };
  return { bin, mock, script, env };
}

test('rejects a corrupted download without installing it', (t) => {
  const { bin, script, env } = fixture(t);
  const result = spawnSync('sh', [script], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum/i);
  assert.equal(existsSync(bin), false);
});

test('installs a verified download and skips network when already present', (t) => {
  const { bin, mock, script, env } = fixture(t, true);
  execFileSync('sh', [script], { env });
  assert.equal(existsSync(bin), true);
  mock('curl', 'exit 99');
  execFileSync('sh', [script], { env });
});
