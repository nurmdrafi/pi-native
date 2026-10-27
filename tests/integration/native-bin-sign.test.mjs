/**
 * Native binaries are copied into bin/ by bootstrap.sh and after-pull.sh.
 *
 * On macOS a plain `cp` over an existing adhoc-signed binary invalidates the
 * code signature: the kernel then refuses to exec it ("load code signature
 * error 2", "Security policy would not allow process") and the process dies
 * with SIGKILL (exit 137) before main() runs. The failure is invisible to the
 * extension, which just sees a dead binary and falls back — so it presents as
 * "piread fallback" churn rather than as a build problem.
 *
 * These tests pin the installer contract: every copy of a native binary into
 * bin/ is followed by a macOS-only re-sign.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** Lines that install a native binary into bin/ (direct `cp`, or the shared helper). */
function installLines(src) {
  return src
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(
      ({ line }) =>
        /^cp\b.*\bbin\//.test(line) ||
        /\bcp\s+"?\$?[A-Z_]*TARGET"?\s+bin\//.test(line) ||
        /(^|[;&|]\s*)(if\s.*?&&\s*)?install_native\b/.test(line),
    );
}

test("bootstrap.sh routes every native binary through the signing installer", () => {
  const src = read("scripts/bootstrap.sh");
  const installs = installLines(src);
  assert.ok(installs.length >= 4, `expected pidx/piread/piedit/pibash installs, got ${installs.length}`);
  for (const { line, n } of installs) {
    assert.match(line, /^install_native\b/, `bootstrap.sh:${n} must use install_native: ${line}`);
  }
});

test("after-pull.sh routes every native binary through the signing installer", () => {
  const src = read("scripts/after-pull.sh");
  const installs = installLines(src);
  assert.ok(installs.length >= 3, `expected piread/piedit/pibash installs, got ${installs.length}`);
  for (const { line, n } of installs) {
    assert.match(line, /install_native\b/, `after-pull.sh:${n} must use install_native: ${line}`);
  }
  assert.doesNotMatch(src, /(^|[;&|]\s*)cp\s+"?\$?[A-Z_]*TARGET"?\s+bin\//, "no bare cp installs");
});

test("the guard is shared, so a third installer cannot silently skip it", () => {
  // A shared helper keeps the rule in one place; two ad-hoc copies drift.
  const shared = ["scripts/lib/install-native.sh"].filter((p) => {
    try {
      read(p);
      return true;
    } catch {
      return false;
    }
  });
  assert.equal(shared.length, 1, "expected scripts/lib/install-native.sh");
  const helper = read(shared[0]);
  assert.match(helper, /codesign\s+--force\s+--sign\s+-/);
  // Guarded so Linux (no codesign) is untouched.
  assert.match(helper, /(uname -s|command -v codesign)/, "codesign call must be platform/availability guarded");
  assert.match(helper, /chmod \+x/, "a copied binary must stay executable");
  for (const script of ["scripts/bootstrap.sh", "scripts/after-pull.sh"]) {
    assert.match(read(script), /install-native\.sh/, `${script} must source the shared installer`);
  }
});
