import test from "node:test";
import assert from "node:assert/strict";
import {
  config,
  HARD_RULES,
  ruleBlocks,
  ruleEnabled,
  ruleSeverity,
  setYolo,
  yoloActive,
  YOLO_FLOOR,
} from "../../extensions/permission-gate/loader.ts";

/** /yolo (session-scoped permission bypass): every gate decision flows
 * through ruleEnabled/ruleSeverity/ruleBlocks. destructiveConfirm re-armed
 * 2026-11-18 by owner direction (audit A1): H2 ships "error" in config.json,
 * sits in HARD_RULES (unlowerable) and in YOLO_FLOOR — the bypass cannot
 * silence it. commitMessageLint keeps the same floor. */

test("yolo is off by default and the safety floor blocks", () => {
  assert.equal(yoloActive(), false);
  assert.equal(ruleBlocks("commitMessageLint"), true);
  assert.equal(ruleEnabled("commitMessageLint"), true);
});

test("yolo floor is a subset of HARD_RULES and names the kept gates", () => {
  assert.deepEqual([...YOLO_FLOOR], ["commitMessageLint", "destructiveConfirm"]);
  for (const key of YOLO_FLOOR) assert.ok(HARD_RULES.has(key), `${key} must be a HARD_RULE`);
  // destructiveConfirm re-entered both floors 2026-11-18 (audit A1):
  // unlowerable below error, and yolo cannot silence it
  assert.equal(HARD_RULES.has("destructiveConfirm"), true);
});

test("setYolo(true) silences every non-floor rule; floor still blocks", () => {
  const before = { ...config.severity };
  assert.equal(setYolo(true), true);
  assert.equal(yoloActive(), true);
  // floor: the commit message gate stays enforced under yolo
  assert.equal(ruleBlocks("commitMessageLint"), true);
  // floor: destructiveConfirm (re-armed 2026-11-18, audit A1) stays armed
  // under yolo — shipped "error" in config.json and floored
  assert.equal(ruleBlocks("destructiveConfirm"), true);
  // everything else reads off: preference rules, hygiene
  assert.equal(ruleBlocks("reReadGuard"), false);
  assert.equal(ruleSeverity("editAnchorGuard"), "off");
  // non-destructive toggle: the on-disk/file severities never move
  assert.deepEqual(config.severity, before);
});

test("setYolo(false) restores full behavior exactly", () => {
  setYolo(true);
  assert.equal(setYolo(false), false);
  assert.equal(yoloActive(), false);
  assert.equal(ruleBlocks("commitMessageLint"), true);
  assert.equal(ruleSeverity("editAnchorGuard"), config.severity.editAnchorGuard);
});
