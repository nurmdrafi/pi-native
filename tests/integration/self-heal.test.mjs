import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DAEMON_BINS,
  daemonKillPattern,
  generationChanged,
  scanBinGeneration,
} from "../../extensions/self-heal/bins.ts";

test("scanBinGeneration returns the newest daemon-binary mtime in ms", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfheal-"));
  const older = join(dir, "pibash");
  const newer = join(dir, "piread");
  writeFileSync(older, "");
  writeFileSync(newer, "");
  utimesSync(older, 1000, 1000);
  utimesSync(newer, 2000, 2000);
  assert.equal(scanBinGeneration(dir), 2000 * 1000);
});

test("scanBinGeneration skips missing binaries and is 0 with none present", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfheal-"));
  assert.equal(scanBinGeneration(dir), 0);
  writeFileSync(join(dir, "piedit"), "");
  assert.ok(scanBinGeneration(dir) > 0);
});

test("generationChanged is false on first run and when unchanged", () => {
  assert.equal(generationChanged(null, 5), false);
  assert.equal(generationChanged(5, 5), false);
  assert.equal(generationChanged(5, 6), true);
});

test("daemonKillPattern targets only this repo's daemon processes", () => {
  const p = daemonKillPattern("/home/x/.pi/agent/bin");
  assert.match(p, /\/home\/x\/\.pi\/agent\/bin\/\(pibash\|piread\|piedit\) --serve$/);
  assert.deepEqual([...DAEMON_BINS], ["pibash", "piread", "piedit"]);
});
