// pidoc portability — the health check must be host-agnostic.
// Regression: `which()` hardcoded `/bin/sh`, which does not exist on every
// supported host (and would abort the whole run before any row printed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pidoc = join(repoRoot, 'skills', 'pidoc', 'scripts', 'pidoc.mjs');

test('pidoc resolves binaries without hardcoding /bin/sh', () => {
  const src = readFileSync(pidoc, 'utf8');
  assert.equal(
    /spawnSync\('\/bin\/sh'/.test(src),
    false,
    'pidoc must not spawn a hardcoded /bin/sh',
  );
  assert.match(src, /process\.platform !== 'win32' && existsSync\('\/bin\/sh'\)/);
});

test('pidoc runs to completion on this host (JSON contract intact)', () => {
  const home = mkdtempSync(join(repoRoot, '.pidoc-test-'));
  try {
    const r = spawnSync(process.execPath, [pidoc, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
      timeout: 120000,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.ok(existsSync(pidoc));
    // Exit 1 is legal (a FAIL row exists); a crash is not — the JSON payload
    // must still parse and carry rows.
    const rows = JSON.parse((r.stdout || '').trim());
    assert.ok(Array.isArray(rows) && rows.length > 0, out);
    assert.ok(rows.some((row) => String(row.check).startsWith('node')), out);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
