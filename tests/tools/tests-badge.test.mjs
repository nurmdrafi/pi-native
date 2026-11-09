import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTapCounts, mergeCounts } from '../../scripts/tests-badge.mjs';

test('parseTapCounts reads the TAP summary lines', () => {
  const tap = ['1..611', '# tests 984', '# suites 147', '# pass 967', '# fail 12', '# cancelled 5'].join('\n');
  assert.deepEqual(parseTapCounts(tap), { tests: 984, pass: 967, fail: 12 });
});

test('parseTapCounts throws when the summary is missing', () => {
  assert.throws(() => parseTapCounts('1..3\nok 1 - something'), /summary/);
});

test('mergeCounts sums suite counts for the badge total', () => {
  const main = parseTapCounts('# tests 578\n# pass 578\n# fail 0');
  const ext = parseTapCounts('# tests 40\n# pass 39\n# fail 1');
  assert.deepEqual(mergeCounts([main, ext]), { tests: 618, pass: 617, fail: 1 });
});
