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
 * through ruleEnabled/ruleSeverity/ruleBlocks. Industry floor (Claude Code
 * bypassPermissions keeps protected-path write confirms + deny rules even in
 * bypass mode; Gemini/Codex full-auto only inside a sandbox): the bypass
 * silences preference/hygiene rules and per-action asks, but the
 * destructiveConfirm ladder — catastrophic commands, protected trees
 * (/etc /usr /var /boot /root, ~/.ssh, ~/.gnupg, rc files), out-of-cwd
 * write confinement — must keep blocking while yolo is on. */

test("yolo is off by default and the safety floor blocks", () => {
  assert.equal(yoloActive(), false);
  assert.equal(ruleBlocks("destructiveConfirm"), true);
  assert.equal(ruleEnabled("commitMessageLint"), true);
});

test("yolo floor is a subset of HARD_RULES and names the kept gates", () => {
  assert.deepEqual([...YOLO_FLOOR], ["destructiveConfirm", "commitMessageLint"]);
  for (const key of YOLO_FLOOR) assert.ok(HARD_RULES.has(key), `${key} must be a HARD_RULE`);
});

test("setYolo(true) silences every non-floor rule; floor still blocks", () => {
  const before = { ...config.severity };
  assert.equal(setYolo(true), true);
  assert.equal(yoloActive(), true);
  // floor: destructive confirm keeps its bite in yolo, except its
  // git-family entries (auto-approve under the bypass); the commit
  // message gate stays enforced too (user direction 2026-11-12)
  assert.equal(ruleBlocks("destructiveConfirm"), true);
  assert.equal(ruleEnabled("destructiveConfirm"), true);
  assert.equal(ruleSeverity("destructiveConfirm"), "error");
  assert.equal(ruleBlocks("commitMessageLint"), true);
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
  assert.equal(ruleBlocks("destructiveConfirm"), true);
  assert.equal(ruleEnabled("commitMessageLint"), true);
  assert.equal(ruleSeverity("editAnchorGuard"), config.severity.editAnchorGuard);
});
