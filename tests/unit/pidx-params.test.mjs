#!/usr/bin/env node
/**
 * pidx unknown-parameter hardening tests.
 *
 * Regression: session 01a14440 (2026-10-16) called
 *   pidx({ pattern: "Native tool performance", path: "README.md" })
 * `pattern`/`path` are not pidx parameters. They were silently dropped, every
 * guard in execute() fell through, and the tool ran its default behaviour —
 * returning the whole session index (~40KB into context, 3.5M raw tokens before
 * truncation) with isError === false. This pins the fix: unknown params must
 * hard-fail before any work happens.
 *
 * Run: node --test tests/pidx-params.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// PI_NATIVE_PIDX=0 would make the factory a no-op; force it on for the loader.
delete process.env.PI_NATIVE_PIDX;

const mod = await import('../../extensions/pidx/index.ts');

/** Capture the tool the extension registers, via a stub ExtensionAPI. */
function loadTool() {
  let tool;
  mod.default({ registerTool: (t) => { tool = t; } });
  assert.ok(tool, 'extension must register a tool');
  return tool;
}

const tool = loadTool();

// ----------------------------------------------------------- schema surface

test('schema declares exactly the documented parameters', () => {
  const props = Object.keys(tool.parameters.properties ?? {}).sort();
  assert.deepEqual(props, ['force', 'max', 'out', 'sessionsDir', 'state', 'stdout']);
});

test('schema closes the object so unknown props are invalid', () => {
  assert.equal(tool.parameters.additionalProperties, false);
});

// ------------------------------------------------- the actual regression

test('REGRESSION: pidx({ pattern, path }) throws instead of silently running', async () => {
  await assert.rejects(
    () => tool.execute('call-1', { pattern: 'Native tool performance', path: 'README.md' }),
    (err) => {
      assert.match(err.message, /unknown parameter/i);
      assert.match(err.message, /pattern/);
      assert.match(err.message, /path/);
      return true;
    },
  );
});

test('the error names the accepted parameters', async () => {
  await assert.rejects(
    () => tool.execute('call-2', { nope: 1 }),
    (err) => {
      for (const k of ['sessionsDir', 'state', 'out', 'max', 'force', 'stdout']) {
        assert.match(err.message, new RegExp(k));
      }
      assert.match(err.message, /rg|piread/);
      return true;
    },
  );
});

test('a single unknown param is enough to fail', async () => {
  await assert.rejects(() => tool.execute('call-3', { limit: 5 }), /unknown parameter/i);
});

test('unknown params fail BEFORE the binary is invoked', async () => {
  // If the guard ran after spawn, this would attempt real indexing and may
  // resolve. Any resolution at all is a failure of the invariant.
  let settled = 'pending';
  try {
    await tool.execute('call-4', { pattern: 'x' });
    settled = 'resolved';
  } catch {
    settled = 'threw';
  }
  assert.equal(settled, 'threw');
});

// --------------------------------------------------------- happy paths kept

test('no arguments is accepted (defaults to writing extracts to a file)', async () => {
  let threw = false;
  try {
    const r = await tool.execute('call-5', {});
    assert.ok(Array.isArray(r.content) && r.content.length > 0);
    // Default path must NOT inline the index.
    assert.match(r.content[0].text, /written to|No sessions/);
    assert.ok(r.content[0].text.length < 2000, 'default output must stay small');
  } catch (e) {
    // A missing bin/pidx is an environment issue, not a guard failure.
    if (/unknown parameter/i.test(e.message)) threw = true;
  }
  assert.equal(threw, false, 'valid empty params must not trip the guard');
});

test('every documented param passes the guard', async () => {
  for (const key of ['sessionsDir', 'state', 'out', 'max', 'force', 'stdout']) {
    let guardTripped = false;
    try {
      await tool.execute('call-' + key, { [key]: key === 'max' ? 1 : key === 'force' || key === 'stdout' ? true : '/tmp/x' });
    } catch (e) {
      if (/unknown parameter/i.test(e.message)) guardTripped = true;
    }
    assert.equal(guardTripped, false, `param ${key} must be accepted by the guard`);
  }
});

// ------------------------------------------- X2: path containment (audit §10)
// `out`/`state`/`sessionsDir` were passed straight to the binary, so a caller
// could point them anywhere. Containment requires each to resolve inside the
// state dir (or the repo root) before the spawn happens.

test('X2: out/state/sessionsDir outside the sandbox are rejected', async () => {
  for (const key of ['out', 'state', 'sessionsDir']) {
    await assert.rejects(
      () => tool.execute('x2-' + key, { [key]: '/etc/shadow' }),
      /outside|containment|not permitted/i,
      `${key} outside the sandbox must be rejected`,
    );
  }
});

test('X2: traversal via .. cannot escape the sandbox', async () => {
  await assert.rejects(
    () => tool.execute('x2-dotdot', { out: '../../../tmp/escape.jsonl' }),
    /outside|containment|not permitted/i,
    'traversal must not escape',
  );
});

test('X2: force requires an explicit confirm', async () => {
  await assert.rejects(
    () => tool.execute('x2-force', { force: true, out: './.pidx/x.jsonl' }),
    /confirm/i,
    'force must demand confirmation',
  );
});
