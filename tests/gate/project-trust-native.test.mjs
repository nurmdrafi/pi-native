import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { freshGate } from "./harness/stub.mjs";

/** Project trust is pi-core native (v1.5.2): the startup ask, the
 * `<agentDir>/trust.json` store, and the `defaultProjectTrust` setting
 * ("ask" | "always" | "never") all live in the vendor binary — nothing in
 * this repo owns them. "always" resolves every project trusted before the
 * prompt runs and never writes the store. So the repo's job is exactly two
 * pins: ship the native setting, and keep custom trust code out of the
 * permission-gate (the earlier project_trust auto-answer handler was
 * removed in favor of the vendor setting). */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("global settings ship defaultProjectTrust always — pi never asks at startup", () => {
  const settings = JSON.parse(readFileSync(join(ROOT, "settings.json"), "utf8"));
  assert.equal(settings.defaultProjectTrust, "always");
});

test("the permission-gate owns no project_trust handler — the native setting decides", async () => {
  const pi = freshGate();
  const answer = await pi.invoke("project_trust", { type: "project_trust", cwd: "/tmp/anywhere" }, {});
  assert.equal(answer, undefined);
});
