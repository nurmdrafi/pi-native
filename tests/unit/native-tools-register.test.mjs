// Every native tool registers unconditionally: Rust is the only executor, so
// there is no env switch that turns a tool off and hands the job to a built-in.
// Choosing pi's built-in read/bash/edit is a configuration decision (do not load
// the extension, or flip the permission-gate P1/P2 rules off), never a silent
// runtime fallback triggered by an env var.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
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

/** Stub ExtensionAPI: every native tool only ever calls registerTool. */
function makePi() {
  const tools = new Map();
  return {
    tools,
    registerTool: (def) => tools.set(def.name, def),
    on: () => () => {},
  };
}

/** Load one extension with its legacy opt-out pinned, returning the stub pi. */
async function loadWith(extension, envKey, envValue) {
  const before = process.env[envKey];
  if (envValue === undefined) delete process.env[envKey];
  else process.env[envKey] = envValue;
  try {
    // Cache-bust so each arm re-runs module-level registration.
    const mod = await import(`../../extensions/${extension}/index.ts?arm=${envValue ?? "unset"}`);
    const pi = makePi();
    mod.default(pi);
    return pi;
  } finally {
    if (before === undefined) delete process.env[envKey];
    else process.env[envKey] = before;
  }
}

const tools = [
  ["piread", "piread", "PI_NATIVE_READ"],
  ["pibash", "pibash", "PI_NATIVE_BASH"],
  ["piedit", "piedit", "PI_NATIVE_EDIT"],
  ["pidx", "pidx", "PI_NATIVE_PIDX"],
];

for (const [extension, name, envKey] of tools) {
  test(`${name} imports no built-in executor`, () => {
    // Rust is the only executor: an extension may pin the schema from the
    // built-in definition, never import the thing that runs it.
    const src = readFileSync(
      new URL(`../../extensions/${extension}/index.ts`, import.meta.url),
      "utf8",
    );
    const hit = src.match(/\b(create(?:Read|Bash|Edit)Tool)\b(?!Definition)/);
    assert.equal(
      hit,
      null,
      `${name} must not import a built-in executor (found ${hit?.[1]})`,
    );
  });

  test(`${name} registers with ${envKey}=0 (no env opt-out)`, async () => {
    // Keep the native binaries out of the way: this test is about registration.
    const bin = mkdtempSync(join(tmpdir(), "native-register-"));
    const before = process.env[`${envKey.replace("PI_NATIVE_", "PI_")}_BIN`];
    process.env[`${envKey.replace("PI_NATIVE_", "PI_")}_BIN`] = join(bin, "missing");
    try {
      const pi = await loadWith(extension, envKey, "0");
      assert.ok(
        pi.tools.has(name),
        `${name} must register even with ${envKey}=0 — built-ins are chosen by configuration, not by an env fallback`,
      );
    } finally {
      if (before === undefined) delete process.env[`${envKey.replace("PI_NATIVE_", "PI_")}_BIN`];
      else process.env[`${envKey.replace("PI_NATIVE_", "PI_")}_BIN`] = before;
      rmSync(bin, { recursive: true, force: true });
    }
  });
}
