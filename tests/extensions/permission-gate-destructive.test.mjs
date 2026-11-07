import test from "node:test";
import assert from "node:assert/strict";
import {
  splitSegments,
  normalizeSegment,
  segmentDestructive,
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
