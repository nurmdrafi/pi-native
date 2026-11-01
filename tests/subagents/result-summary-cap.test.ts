/**
 * Cap on the child's final message embedded in a delivered result.
 *
 * Defect: the delivered result carried the child's entire final assistant
 * message verbatim with no length cap — the largest uncontrollable
 * parent-token cost in a wave of children (the durable history caps its
 * summary field, delivery did not).
 *
 * Contract under test:
 * - a summary within the limit passes through unchanged, no marker;
 * - an oversized summary is cut at a line boundary near the limit and ends
 *   with a truncation marker naming the shown and total sizes;
 * - every delivery branch (success, non-zero exit, pane lost, cancelled)
 *   embeds the capped summary.
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test__ } = await import("../../extensions/subagents/index.ts");

const { resolveResultPresentation, capResultSummary } = __test__;

const LONG = Array.from({ length: 400 }, (_, i) => `line-${i} ${"x".repeat(40)}`).join("\n");

describe("capResultSummary", () => {
  it("passes a short summary through unchanged", () => {
    assert.equal(capResultSummary("did the thing"), "did the thing");
  });

  it("caps an oversized summary at a line boundary with a truncation marker", () => {
    const out = capResultSummary(LONG);
    assert.ok(out.length < LONG.length);
    assert.ok(out.length < 2400);
    assert.match(out, /truncated: first \d+ of \d+ chars/);
    // The kept head is a prefix of the original, cut at a line boundary.
    const markerAt = out.indexOf("\n\n… [summary truncated");
    assert.ok(markerAt > 0);
    const head = out.slice(0, markerAt);
    assert.ok(LONG.startsWith(head));
    assert.ok(!head.endsWith("\n"));
  });
});

describe("resolveResultPresentation caps the embedded summary", () => {
  const base = { exitCode: 0, elapsed: 1000, sessionFile: "/tmp/s.jsonl", sessionId: "s1" };

  it("success branch", () => {
    const out = resolveResultPresentation({ ...base, summary: LONG }, "w1");
    assert.ok(out.length < 2800);
    assert.match(out, /truncated: first \d+ of \d+ chars/);
  });

  it("non-zero exit branch", () => {
    const out = resolveResultPresentation({ ...base, exitCode: 3, summary: LONG }, "w1");
    assert.match(out, /truncated: first \d+ of \d+ chars/);
  });

  it("pane_lost branch", () => {
    const out = resolveResultPresentation({ ...base, error: "pane_lost", summary: LONG }, "w1");
    assert.match(out, /truncated: first \d+ of \d+ chars/);
  });

  it("cancelled_by_parent branch", () => {
    const out = resolveResultPresentation(
      { ...base, error: "cancelled_by_parent", summary: LONG },
      "w1",
    );
    assert.match(out, /truncated: first \d+ of \d+ chars/);
  });

  it("keeps a short summary verbatim with no marker", () => {
    const out = resolveResultPresentation({ ...base, summary: "all good" }, "w1");
    assert.ok(out.includes("all good"));
    assert.ok(!out.includes("truncated"));
  });
});
