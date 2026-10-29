import test from "node:test";
import assert from "node:assert/strict";

import {
  countTurns,
  DEFAULT_TURN_LIMIT,
  handoffCommandText,
  resolveTurnLimit,
  shouldPromptForHandoff,
  suggestGoal,
} from "../../extensions/handoff/turn-limit.ts";
import { CADENCE_TURNS } from "../../extensions/permission-gate/cadence.ts";

const userEntry = (text) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});
const assistantEntry = (text) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const toolResultEntry = () => ({
  type: "message",
  message: { role: "toolResult", content: [{ type: "toolResult" }] },
});
const compactionEntry = () => ({ type: "compaction", firstKeptEntryId: null });
const otherEntry = (type) => ({ type });

test("the handoff limit defaults to the cadence definition", () => {
  assert.equal(DEFAULT_TURN_LIMIT, CADENCE_TURNS);
});

test("countTurns counts user message entries", () => {
  const entries = [userEntry("first"), assistantEntry("hi"), userEntry("second")];
  assert.equal(countTurns(entries), 2);
});

test("countTurns ignores non-user and non-message entries", () => {
  const entries = [
    assistantEntry("hi"),
    toolResultEntry(),
    otherEntry("compaction"),
    otherEntry("usage"),
    otherEntry("custom"),
  ];
  assert.equal(countTurns(entries), 0);
});

test("countTurns reads user content given as a plain string", () => {
  const entries = [{ type: "message", message: { role: "user", content: "plain" } }];
  assert.equal(countTurns(entries), 1);
});

test("countTurns returns 0 for an empty branch", () => {
  assert.equal(countTurns([]), 0);
});

test("countTurns resets at the last compaction entry", () => {
  const entries = [
    userEntry("first"),
    userEntry("second"),
    compactionEntry(),
    userEntry("third"),
    assistantEntry("hi"),
  ];
  assert.equal(countTurns(entries), 1);
});

test("countTurns uses only entries after the newest of several compactions", () => {
  const entries = [
    userEntry("first"),
    compactionEntry(),
    userEntry("second"),
    userEntry("third"),
    compactionEntry(),
    userEntry("fourth"),
  ];
  assert.equal(countTurns(entries), 1);
});

test("a trailing compaction leaves an empty budget", () => {
  const entries = [userEntry("first"), userEntry("second"), compactionEntry()];
  assert.equal(countTurns(entries), 0);
});

test("resolveTurnLimit returns the default when the env var is unset", () => {
  assert.equal(resolveTurnLimit({}), DEFAULT_TURN_LIMIT);
  assert.equal(resolveTurnLimit({ HANDOFF_TURN_LIMIT: undefined }), DEFAULT_TURN_LIMIT);
});

test("resolveTurnLimit accepts a positive integer override", () => {
  assert.equal(resolveTurnLimit({ HANDOFF_TURN_LIMIT: "10" }), 10);
});

test("resolveTurnLimit falls back to the default for invalid overrides", () => {
  for (const value of ["0", "-3", "abc", "2.5", ""]) {
    assert.equal(resolveTurnLimit({ HANDOFF_TURN_LIMIT: value }), DEFAULT_TURN_LIMIT, value);
  }
});

test("suggestGoal prefers the last user message with enough words", () => {
  const entries = [
    userEntry("refactor the extension loader first"),
    assistantEntry("done"),
    userEntry("yes"),
    userEntry("now fix the failing tests"),
  ];
  assert.equal(suggestGoal(entries), "now fix the failing tests");
});

test("suggestGoal falls back to the last user message when all are short", () => {
  const entries = [userEntry("ok"), userEntry("go")];
  assert.equal(suggestGoal(entries), "go");
});

test("suggestGoal trims the goal to five words", () => {
  const entries = [userEntry("please continue implementing the payment flow next")];
  assert.equal(suggestGoal(entries), "please continue implementing the payment");
});

test("suggestGoal skips entries without usable text", () => {
  const entries = [
    userEntry("start the migration"),
    { type: "message", message: { role: "user", content: [{ type: "image", data: "x" }] } },
  ];
  assert.equal(suggestGoal(entries), "start the migration");
});

test("suggestGoal returns an empty string with no user messages", () => {
  assert.equal(suggestGoal([assistantEntry("hi"), otherEntry("usage")]), "");
  assert.equal(suggestGoal([]), "");
});

test("handoffCommandText joins the goal onto the command", () => {
  assert.equal(handoffCommandText("fix the remaining tests"), "/handoff fix the remaining tests");
});

test("handoffCommandText emits the bare command for an empty goal", () => {
  assert.equal(handoffCommandText(""), "/handoff");
});

test("shouldPromptForHandoff fires once the limit is reached and not before", () => {
  assert.equal(shouldPromptForHandoff(39, 40, false), false);
  assert.equal(shouldPromptForHandoff(40, 40, false), true);
  assert.equal(shouldPromptForHandoff(41, 40, false), true);
});

test("shouldPromptForHandoff stays silent after the user was already asked", () => {
  assert.equal(shouldPromptForHandoff(40, 40, true), false);
  assert.equal(shouldPromptForHandoff(50, 40, true), false);
});
