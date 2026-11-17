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
 * through ruleEnabled/ruleSeverity/ruleBlocks. destructiveConfirm left both
 * floors 2026-11-17 by user direction (global allow-all): it is an ordinary
 * configurable rule now — shipped "off" in config.json, so no confirm arms,
 * yolo or not; re-arm via config.json H2 or PGATE_H2=error. commitMessageLint
 * keeps its industry floor: the bypass cannot silence it. */

test("yolo is off by default and the safety floor blocks", () => {
  assert.equal(yoloActive(), false);
  assert.equal(ruleBlocks("commitMessageLint"), true);
  assert.equal(ruleEnabled("commitMessageLint"), true);
});

test("yolo floor is a subset of HARD_RULES and names the kept gates", () => {
  assert.deepEqual([...YOLO_FLOOR], ["commitMessageLint"]);
  for (const key of YOLO_FLOOR) assert.ok(HARD_RULES.has(key), `${key} must be a HARD_RULE`);
  // destructiveConfirm is no longer floored (2026-11-17): with the shipped
  // config at "off" it never arms; re-armed to error it reads like any rule
  assert.equal(HARD_RULES.has("destructiveConfirm"), false);
});

test("setYolo(true) silences every non-floor rule; floor still blocks", () => {
  const before = { ...config.severity };
  assert.equal(setYolo(true), true);
  assert.equal(yoloActive(), true);
  // floor: the commit message gate stays enforced under yolo
  assert.equal(ruleBlocks("commitMessageLint"), true);
  // destructiveConfirm: shipped off — silent with or without yolo
  assert.equal(ruleBlocks("destructiveConfirm"), false);
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
