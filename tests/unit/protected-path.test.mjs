import test from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

import { PROTECTED_PREFIX_RE } from "../../extensions/permission-gate/rules/destructive.ts";

// The gate realpaths the write target before judging it, so it must compare
// against a realpathed home too. On macOS /tmp and /var are symlinks to
// /private/..., which made an unresolved home never match a resolved target.
test("a realpathed home matches a realpathed ~/.ssh target", () => {
  const realHome = realpathSync(homedir());
  assert.equal(
    PROTECTED_PREFIX_RE.test(join(realHome, ".ssh", "authorized_keys")),
    true,
    `resolved home ${realHome} must be recognized`,
  );
});

test("a realpathed home matches a realpathed ~/.gnupg target", () => {
  const realHome = realpathSync(homedir());
  assert.equal(PROTECTED_PREFIX_RE.test(join(realHome, ".gnupg", "pubring.kbx")), true);
});

test("a realpathed home matches a realpathed rc file", () => {
  const realHome = realpathSync(homedir());
  assert.equal(PROTECTED_PREFIX_RE.test(join(realHome, ".zshrc")), true);
});

test("system trees are protected regardless of home", () => {
  for (const p of ["/etc/passwd", "/usr/bin/x", "/var/db/x", "/boot/x", "/root/x"]) {
    assert.equal(PROTECTED_PREFIX_RE.test(p), true, `${p} must be protected`);
  }
});

test("a realpathed home under a symlinked tmp is still recognized", () => {
  // macOS: /tmp -> /private/tmp, /var -> /private/var. A gate that realpaths
  // the target but not the home misses every protected write routed through
  // a symlinked temp dir. Compare in realpath space on both sides.
  const realTmp = realpathSync(tmpdir());
  const fakeHome = join(realTmp, "s4-fake-home");
  const prev = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    assert.equal(
      PROTECTED_PREFIX_RE.test(join(fakeHome, ".ssh", "authorized_keys")),
      true,
      `home ${homedir()} under a symlinked tmp must be recognized`,
    );
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
});

test("an unrelated file under home is not protected", () => {
  const realHome = realpathSync(homedir());
  assert.equal(PROTECTED_PREFIX_RE.test(join(realHome, "notes.txt")), false);
});

test("a lookalike sibling directory is not protected", () => {
  const realHome = realpathSync(homedir());
  assert.equal(
    PROTECTED_PREFIX_RE.test(join(realHome, ".ssh-backup", "id_rsa")),
    false,
    ".ssh-backup must not match .ssh",
  );
});
