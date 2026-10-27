// Sync script tests: upstream path selection + manual-only flag injection.
// Network fetch itself is a side-effecting wrapper — untested here by design.
import { test } from "node:test";
import assert from "node:assert/strict";

import { injectManualFlag, localizeCommandPaths, selectSkillPaths } from "../../scripts/sync-impeccable.mjs";

test("selectSkillPaths keeps only the agent skill subtree, stripped", () => {
  const paths = [
    "README.md",
    ".agent/skills/impeccable/SKILL.md",
    ".agent/skills/impeccable/reference/craft.md",
    ".agent/skills/impeccable/scripts/impeccable",
    ".agents/skills/impeccable/SKILL.md",
    "crates/engine/src/lib.rs",
    ".claude/skills/impeccable/SKILL.md",
  ];
  assert.deepEqual(selectSkillPaths(paths), [
    "SKILL.md",
    "reference/craft.md",
    "scripts/impeccable",
  ]);
});

test("localizeCommandPaths rewrites upstream script paths to harness bare names", () => {
  const text = "```\n.agent/skills/impeccable/scripts/impeccable detect --json [target]\n```\nprose mention of .agent/skills/impeccable/ layout\n";
  const out = localizeCommandPaths(text);
  assert.match(out, /\nimpeccable detect --json \[target\]/);
  assert.doesNotMatch(out, /\.agent\/skills\/impeccable\/scripts\/impeccable/);
});

test("injectManualFlag adds the flag after version when absent", () => {
  const text = `---\nname: impeccable\ndescription: x\nversion: 4.7.1\nlicense: Apache 2.0\n---\n\n# Body\n`;
  const out = injectManualFlag(text);
  assert.match(out, /version: 4\.7\.1\ndisable-model-invocation: true\n/);
  assert.equal(out.match(/disable-model-invocation/g).length, 1);
});

test("injectManualFlag is idempotent when the flag exists", () => {
  const text = `---\nname: impeccable\nversion: 4.7.1\ndisable-model-invocation: true\n---\n\n# Body\n`;
  assert.equal(injectManualFlag(text), text);
});

test("injectManualFlag falls back to before closing delimiter without version", () => {
  const text = `---\nname: impeccable\ndescription: x\n---\n\n# Body\n`;
  const out = injectManualFlag(text);
  assert.match(out, /description: x\ndisable-model-invocation: true\n---/);
});
