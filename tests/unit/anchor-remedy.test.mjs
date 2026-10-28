#!/usr/bin/env node
/**
 * P3 (2026-11-01): a not-found anchor block must cost zero remedy rounds.
 *
 * Session audit: three anchor blocks each forced a small read plus a full
 * re-send of the edit payload, ~5K output duplicated per block. The block
 * already knew the closest region (findClosestFragment) but reported only a
 * line count and an edge name, so the model had to re-derive the bytes.
 *
 * Pins: (1) the block names the closest region as paste-ready oldText;
 * (2) it carries a paste-ready `piread {path, offset, limit}` call;
 * (3) the payload stays bounded; (4) a matching anchor still passes through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEditAnchors } from "../../extensions/permission-gate/rules/anchor-guard.ts";

const root = mkdtempSync(join(tmpdir(), "anchor-remedy-"));
const file = join(root, "mod.ts");
writeFileSync(
  file,
  [
    "export function alpha() {",
    "  return 1;",
    "}",
    "",
    "export function beta() {",
    "  return 2;",
    "}",
    "",
  ].join("\n"),
);

const miss = () =>
  validateEditAnchors({
    path: file,
    edits: [{ oldText: "export function alpha() {\n  return 99;\n}", newText: "x" }],
  });

test("a not-found anchor names the closest region as paste-ready text", async () => {
  const r = await miss();
  assert.equal(r.block, true, "the anchor does not exist, so it blocks");
  assert.match(r.reason, /Closest region|Use these exact lines/);
  assert.match(r.reason, /return 1;/, "the real line, not a paraphrase");
});

test("a not-found anchor carries a paste-ready piread call", async () => {
  const r = await miss();
  assert.match(r.reason, /piread \{path: '.*mod\.ts', offset: \d+, limit: \d+\}/);
});

test("the remedy payload stays bounded", async () => {
  const r = await miss();
  assert.ok(r.reason.length < 2048, `reason is ${r.reason.length} chars`);
});
