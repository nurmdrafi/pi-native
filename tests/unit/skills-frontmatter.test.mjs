import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS = join(ROOT, "skills");
// The package's export map forbids the deep subpath, so resolve the loader by
// file URL the way the bench drivers resolve the built-in tools.
const { loadSkillsFromDir } = await import(
  pathToFileURL(join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js")).href
);

/**
 * A skill whose frontmatter fails to parse is dropped silently: no
 * `/skill:<name>` entry, no error at session start. That is how a malformed
 * `sources` line in `rust-skills` stayed invisible until someone typed the
 * slash command. Loader diagnostics are therefore a test failure, and every
 * directory with a SKILL.md must come back as a loaded skill.
 */
test("every skill directory loads and the loader reports no diagnostics", () => {
  const expected = readdirSync(SKILLS)
    .filter((name) => {
      try {
        return statSync(join(SKILLS, name, "SKILL.md")).isFile();
      } catch {
        return false;
      }
    })
    .sort();

  const { skills, diagnostics } = loadSkillsFromDir({ dir: SKILLS, source: "repo" });

  assert.deepEqual(
    diagnostics.map((d) => `${d.type}: ${d.message} (${d.path})`),
    [],
    "frontmatter diagnostics",
  );

  const loaded = skills.map((s) => s.name).sort();
  assert.deepEqual(loaded, expected, "loaded skill names must match the directories on disk");
});
