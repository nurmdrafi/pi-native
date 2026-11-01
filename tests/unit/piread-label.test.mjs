// piread's call label must not echo the JSON-null filler some providers send
// in the `hits` parameter. A paged read arrives as
// {path, offset, limit, hits: "null"} — the filler word is not a search
// needle (execute already treats it as absent); the label must show the
// window range instead of `hits:'null'`.
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true });
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}

const theme = { fg: (_color, s) => s, bold: (s) => s };

const mod = await import("../../extensions/piread/index.ts?label");
let def = null;
mod.default({ registerTool: (d) => (def = d), on: () => () => {} });
assert.ok(def?.renderCall, "piread tool registered with renderCall");

const labelOf = (args) => def.renderCall(args, theme, undefined).text;

test("paged read shows the window range, never the null filler", () => {
  const label = labelOf({
    path: "/tmp/code-review.diff",
    offset: 251,
    limit: 250,
    hits: "null",
  });
  assert.match(label, /\/tmp\/code-review\.diff:251-500/);
  assert.doesNotMatch(label, /hits/, "filler word must not render");
});

test("JSON null and case/whitespace filler variants render as absent", () => {
  for (const hits of [null, "NULL", " undefined "]) {
    const label = labelOf({ path: "/tmp/a.ts", offset: null, limit: null, hits });
    assert.doesNotMatch(label, /hits/, `hits=${JSON.stringify(hits)}`);
    assert.match(label, /\/tmp\/a\.ts:1$/);
  }
});

test("a real needle still renders as hits:'…'", () => {
  const label = labelOf({ path: "/tmp/a.ts", hits: "requestAnimationFrame" });
  assert.match(label, /\/tmp\/a\.ts hits:'requestAnimationFrame'$/);
});
