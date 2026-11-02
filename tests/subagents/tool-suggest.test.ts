import test from "node:test";
import assert from "node:assert/strict";

import { closestToolName } from "../../extensions/subagents/index.ts";

// The spawn-time guard warns when an allowlisted tool resolves to no extension
// path. A warning that names only the unknown string leaves the reader guessing
// which tool was meant; these assertions pin the suggestion that rides along.
test("closestToolName finds a one-edit typo in a known name", () => {
  const known = ["ask_question", "piread", "pibash", "piedit"];
  assert.equal(closestToolName("ans_question", known), "ask_question");
  assert.equal(closestToolName("pi", known), undefined);
});

test("closestToolName refuses a name further than two edits away", () => {
  const known = ["ask_question", "pibash"];
  assert.equal(closestToolName("completely_different", known), undefined);
  assert.equal(closestToolName("ask", known), undefined);
});

test("closestToolName prefers the nearest candidate and skips the exact name", () => {
  const known = ["ask_question", "ask_questions", "piread"];
  assert.equal(closestToolName("ask_questionn", known), "ask_question");
  assert.equal(closestToolName("piread", known), undefined);
});
