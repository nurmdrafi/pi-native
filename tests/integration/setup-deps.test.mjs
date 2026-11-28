import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helper = fileURLToPath(new URL('../../scripts/lib/setup-deps.sh', import.meta.url));

function status(tree) {
  return spawnSync('sh', ['-c', `. "$1"
tree=$2
npm() { printf '%s' "$tree"; return 1; }
npm_deps_present .`, 'sh', helper, tree], { stdio: 'pipe' }).status;
}

test('npm dependency check treats a missing transitive package as repairable', () => {
  assert.equal(status('{"problems":["missing: demo@1, required by parent@1"]}'), 1);
  assert.equal(status('not npm JSON'), 1);
});

test('a deliberately host-linked Pi version does not force repeated installs', () => {
  assert.equal(status('{"problems":["invalid: @earendil-works/pi-ai@1.5.0 node_modules/example"]}'), 0);
});

test('the pull hook repairs missing npm trees and restores host Pi links', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-pull-hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const make = (path, body, executable = false) => {
    const dest = join(root, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
    if (executable) chmodSync(dest, 0o755);
  };
  for (const path of ['.husky/post-merge', 'scripts/after-pull.sh', 'scripts/lib/setup-deps.sh',
    'scripts/lib/install-native.sh', 'scripts/lib/progress.sh']) {
    const dest = join(root, path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(new URL(`../../${path}`, import.meta.url), dest);
  }
  chmodSync(join(root, 'scripts/after-pull.sh'), 0o755);
  mkdirSync(join(root, 'node_modules'));
  make('dashboard/package.json', '{}');
  make('dashboard/dist/index.html', '');
  for (const tool of ['docheck', 'outline']) make(`bin/${tool}`, '', true);
  make('scripts/install-bx.sh', 'echo bx >> "$TRACE"');
  make('scripts/link-pi.mjs', 'import { appendFileSync } from "node:fs"; appendFileSync(process.env.TRACE, "link-pi\\n");');
  make('scripts/sync-agent-bin.mjs', '');
  make('skills/pidoc/scripts/pidoc.mjs', '');
  make('mocks/gIT', '', false);
  make('mocks/git', '#!/usr/bin/env sh\ncase "$*" in "rev-parse --show-toplevel") printf "%s\\n" "$TEST_ROOT";; *) exit 1;; esac', true);
  make('mocks/pkill', '#!/usr/bin/env sh\nexit 1', true);
  make('mocks/npm', `#!/usr/bin/env sh
case "$*" in
  *' ls '*) printf '%s' '{"problems":["missing: test-package"]}'; exit 1;;
  *) printf '%s: %s\\n' "$PWD" "$*" >> "$TRACE";;
esac`, true);
  const trace = join(root, 'trace');
  const result = spawnSync('sh', ['.husky/post-merge'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, TEST_ROOT: root, TRACE: trace, PATH: `${join(root, 'mocks')}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  const actions = readFileSync(trace, 'utf8').split('\n');
  assert.ok(actions.includes('bx'));
  assert.ok(actions.includes(`${root}: install --no-audit --no-fund`));
  assert.ok(actions.includes(`${root}: --prefix skills/browser-tools install --no-audit --no-fund`));
  assert.ok(actions.includes(`${join(root, 'dashboard')}: run build`));
  assert.ok(actions.includes('link-pi'), 'repair must relink packages to the host Pi install');
});
