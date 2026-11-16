import test from "node:test";
import assert from "node:assert/strict";
import {
  splitSegments,
  normalizeSegment,
  segmentDestructive,
  segmentDestructiveExceptGit,
} from "../../extensions/permission-gate/rules/destructive.ts";

/** H2 destructive-confirm predicate exactly as the gate applies it to a
 * bash command: any normalized segment judged destructive → confirm. */
const confirms = (cmd) =>
  splitSegments(cmd).map(normalizeSegment).some(segmentDestructive);

test("T1: node -e rmSync payload redirected to .cache must confirm", () => {
  assert.equal(
    confirms(
      `node -e "require('fs').rmSync('/tmp/victim',{recursive:true})" > .cache/o`,
    ),
    true,
  );
});

test("T2: node -e rmSync payload tee'd to .cache must confirm", () => {
  assert.equal(
    confirms(
      `node -e "require('fs').rmSync('/tmp/victim',{recursive:true})" | tee .cache/o`,
    ),
    true,
  );
});

test("T3: heredoc body with rm -rf must confirm", () => {
  assert.equal(confirms("sh <<'EOF'\nrm -rf /tmp/victim\nEOF"), true);
});

test("T4: base64 payload piped to node must confirm", () => {
  assert.equal(confirms("echo cm0gLXJmIHZpY3RpbQ== | base64 -d | node"), true);
});

test("T5: benign node -e scratch write stays allowed (no confirm)", () => {
  assert.equal(confirms(`node -e "console.log(1)" > .cache/o`), false);
});

// 16.1 corpus pins the heredoc fix must preserve: bodies quoting destructive
// or interpreter-escape PROSE stay data, not commands.
test("heredoc prose quoting interpreter escapes stays allowed", () => {
  assert.equal(
    confirms(
      "cat > /tmp/progress.md <<'EOF'\n## Review notes\nThe docs mention `node --eval` and `python3 -c` as escape routes.\nEOF",
    ),
    false,
  );
});

test("heredoc prose with mid-line rm mention stays allowed", () => {
  assert.equal(
    confirms(
      "cat > /tmp/cost.txt <<'EOF'\ncost = \\$5 || none; rm -rf / is quoted prose\nEOF",
    ),
    false,
  );
});

// /yolo git-family exemption (2026-11-12, user direction): the bypass
// silences the git confirm entries (git push/history asks auto-approve);
// every other destructive signal — non-git entries, sudo, protected
// redirects — still confirms. git commit's gate is commitMessageLint, not
// this set; it stays enforced in yolo via YOLO_FLOOR.

const seg0 = (cmd) => normalizeSegment(splitSegments(cmd)[0]);

test("git-family confirm segments pass the except-git judge but stay destructive", () => {
  for (const cmd of ["git reset --hard", "git clean -fdx", "git checkout -- src/", "git restore ."]) {
    const s = seg0(cmd);
    assert.equal(segmentDestructive(s), true, `${cmd} must stay destructive`);
    assert.equal(segmentDestructiveExceptGit(s), false, `${cmd} must pass except-git`);
  }
});

test("non-git signals still confirm under except-git, and plain push/commit never did", () => {
  for (const cmd of ["rm -rf /tmp/x", "sudo git reset --hard", "echo x > /etc/passwd"]) {
    assert.equal(
      splitSegments(cmd).map(normalizeSegment).some(segmentDestructiveExceptGit),
      true,
      `${cmd} must still confirm`,
    );
  }
  assert.equal(segmentDestructive(seg0("git push origin main")), false);
  assert.equal(segmentDestructive(seg0("git commit -m 'x'")), false);
});
