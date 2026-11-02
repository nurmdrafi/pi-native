import test from "node:test";
import assert from "node:assert/strict";

import { __test__, isTransientProviderError } from "../../extensions/subagents/index.ts";

// A transient provider death must keep the child's context: the result text
// has to point at resuming the same session, never at a fresh spawn, because a
// fresh spawn re-pays every token the child had already accumulated.
test("isTransientProviderError matches rate limits and 5xx, not task failures", () => {
  for (const msg of [
    "429 Too Many Requests",
    "provider error: 503 Service Unavailable",
    "Overloaded",
    "read ECONNRESET",
    "socket hang up",
  ])
    assert.equal(isTransientProviderError(msg), true, msg);
  for (const msg of [
    "tsc: 12 errors in src/",
    "the model refused the request",
    "budget exceeded after 900s",
    "",
  ])
    assert.equal(isTransientProviderError(msg), false, msg);
});

test("a transient provider failure tells the reader to resume, not to re-spawn", () => {
  const text = __test__.resolveResultPresentation(
    {
      exitCode: 1,
      elapsed: 12_000,
      summary: "",
      errorMessage: "429 Too Many Requests",
    },
    "worker-a",
  );
  assert.match(text, /resume the same session/);
  assert.match(text, /re-pays the whole/);
  assert.doesNotMatch(text, /spawning a new subagent/);
  assert.match(text, /subagent_message\(\{ name: "worker-a"/);
});

test("a non-transient failure keeps the neutral resume wording", () => {
  const text = __test__.resolveResultPresentation(
    { exitCode: 1, elapsed: 5_000, summary: "", errorMessage: "tsc: 12 errors" },
    "worker-b",
  );
  assert.match(text, /Resume it with subagent_message/);
  assert.doesNotMatch(text, /re-pays the whole/);
});
