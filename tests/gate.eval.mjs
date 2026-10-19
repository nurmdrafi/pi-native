#!/usr/bin/env node
/**
 * Fixture-driven gate evaluation (brief §4 items 1–2 + §5 seed fixtures).
 *
 * Runs every allow fixture (must NOT block) and every block fixture (must
 * block with the expected family prefix) through the real permission-gate
 * extension via the stubbed ExtensionAPI. Known-bug fixtures (leading `?`)
 * encode DESIRED behavior; their failures are the B8–B21 backlog, not noise.
 *
 * Prints compact per-fixture PASS/FAIL, then ONE final JSON summary line:
 *   { fixture_pass, fixture_total, allow_fail, block_fail, known_bug_fail, new_fail }
 *
 * Run: node tests/gate.eval.mjs   (exit 0 always — this is measurement, not CI)
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshGate, runBash, bashProbe, familyOfReason } from './lib/gate-stub.mjs';

const HERE = import.meta.dirname;

// ---- scratch cwd: the fixture commands reference these files by name ----
const scratch = mkdtempSync(join(tmpdir(), 'gate-eval-'));
const files = {
  f: Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n'),
  'big.log': `${'x'.repeat(120)}\n`.repeat(3000),
  'big.txt': `${'y'.repeat(120)}\n`.repeat(3000),
  'big.json': JSON.stringify({ items: Array.from({ length: 5000 }, (_, i) => ({ id: i })) }),
  'big.js': 'console.log(1);\n'.repeat(5000),
  log: 'server started\n',
  // exactly 49 bytes — the tiny-file exemption case from the 49 B watermark audit
  tiny: '{ "auditedThrough": "2026-10-07" }', // 28 chars… pad below
};
writeFileSync(join(scratch, 'tiny'), '{ "auditedThrough": "2026-10-07" }\n'.padEnd(49, ' '));
for (const [name, body] of Object.entries(files)) if (name !== 'tiny') writeFileSync(join(scratch, name), body);
mkdirSync(join(scratch, 'src'));
writeFileSync(join(scratch, 'src', 'do.ts'), 'export const done = true;\n');

// The fixtures exercise the BUILT-IN bash/read mechanics, so the native
// P2/P1 first-rules must be opted out or every bash fixture would be blocked
// by "Pibash-first" before its real family is measured (same reason
// tests/permission-gate.test.mjs sets PI_NATIVE_BASH=0). The dedicated P2
// coverage lives in that suite, which toggles the env per case.
process.env.PI_NATIVE_BASH = '0';
process.env.PI_NATIVE_READ = '0';
process.chdir(scratch); // fixture commands reference the scratch files by name

// ---- fixture parsing ----
const prep = (line) => line
  .replaceAll('<49-byte file>', 'tiny')
  .replaceAll('\\n', '\n'); // heredoc fixtures carry literal \n

function* loadFixtures(name) {
  for (const raw of readFileSync(join(HERE, 'fixtures', name), 'utf8').split('\n')) {
    const line = raw; // trailing `# …` notes only in the block file, where they land
                      // in a separate tab column and are ignored below; stripping
                      // textually would eat the ` ## ` step separator
    if (!line.trim() || /^\s*#/.test(raw)) continue;
    const cols = line.split('\t').map((c) => c.trim()).filter(Boolean); // trailing `# …` notes ride in their own tab column (block file)
    const knownBug = cols[0] === '?';
    if (knownBug) cols.shift();
    yield { knownBug, cols: cols.map(prep) };
  }
}

// ---- run ----
const out = [];
let allowFail = 0, blockFail = 0, knownBugFail = 0, newFail = 0, total = 0;

for (const { knownBug, cols } of loadFixtures('bash-allow.txt')) {
  total++;
  const pi = freshGate();
  let blockedAt = null;
  for (const step of cols.join(' ## ').split(' ## ')) {
    const r = await runBash(pi, step);
    if (r.blocked) { blockedAt = { step, family: familyOfReason(r.reason) }; break; }
  }
  const ok = !blockedAt;
  if (!ok) { allowFail++; knownBug ? knownBugFail++ : newFail++; }
  out.push(`${ok ? 'PASS' : 'FAIL'}${knownBug && !ok ? '(known-bug)' : '  '}  A  ${cols.join(' ## ').slice(0, 70)}` +
    (blockedAt ? `  → blocked by ${blockedAt.family}` : ''));
}

for (const { knownBug, cols } of loadFixtures('bash-block.txt')) {
  total++;
  const [cmd, family] = cols;
  const pi = freshGate();
  const steps = cmd.split(' ## ');
  // S4 (2026-10-15): destructive-family fixtures assert the H2 BLOCK — the
  // default stub ctx auto-approves the confirm dialog, so run those headless
  const ctx = family === 'Permission Gate (Destructive)' ? { hasUI: false } : undefined;
  let failed = false, note = '';
  for (let i = 0; i < steps.length; i++) {
    const last = i === steps.length - 1;
    const r = await runBash(pi, steps[i], { ctx });
    if (!last) {
      if (r.blocked) { failed = true; note = `→ early block on step ${i + 1} by ${familyOfReason(r.reason)}`; break; }
    } else if (!r.blocked) { failed = true; note = '→ not blocked'; break; }
    else if (!r.reason.startsWith(family)) { failed = true; note = `→ family ${familyOfReason(r.reason)} != ${family}`; break; }
  }
  if (failed) { blockFail++; knownBug ? knownBugFail++ : newFail++; }
  out.push(`${failed ? 'FAIL' : 'PASS'}${knownBug && failed ? '(known-bug)' : '  '}  B  ${cmd.slice(0, 70)}  ${failed ? note : `(${family})`}`);
}

for (const l of out) console.log(l);
const summary = {
  fixture_pass: total - allowFail - blockFail,
  fixture_total: total,
  allow_fail: allowFail,
  block_fail: blockFail,
  known_bug_fail: knownBugFail,
  new_fail: newFail,
};
console.log(JSON.stringify(summary));
