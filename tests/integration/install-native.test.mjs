import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');

test('install_native replaces a busy (running) binary via staged rename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-native-'));
  const sleeper = join(dir, 'sleeper');
  const sleepPath = spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' });
  assert.equal(sleepPath.status, 0, sleepPath.stderr);
  const sleepBinary = sleepPath.stdout.trim();
  assert.ok(sleepBinary, 'sleep must be available on PATH');
  copyFileSync(sleepBinary, sleeper);
  // sleeper must stay executing inside the SAME shell that installs,
  // otherwise the daemon reaps the whole process group between spawns.
  const r = spawnSync('sh', ['-c', `
    "$2" 5 &
    BG=$!
    . scripts/lib/install-native.sh
    install_native "$1" "$2"
    echo "RC=$?"
    kill "$BG" 2>/dev/null
    VERSION=$("$2" --version) || exit 1
    [ "$VERSION" = "$3" ] && echo CONTENT=ok
  `, 'sh', process.execPath, sleeper, process.version], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RC=0/);
  assert.match(r.stdout, /CONTENT=ok/);
});
