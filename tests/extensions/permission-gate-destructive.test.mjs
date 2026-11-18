import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  splitSegments,
  normalizeSegment,
  segmentDestructive,
  segmentDestructiveExceptGit,
  tmpWriteTargetsOf,
  executesRecordedTmpTarget,
  protectedWrittenTargetOf,
  protectedCopyTargetOf,
  copyTargetOf,
  approvalIn,
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

// ---- Phase 2 (2026-11-18 audit, A6): inline-body judging — an inline
// interpreter confirms on its BODY's destructive vocabulary, never on where
// a benign payload's stdout lands (the `node -e` arithmetic false positive
// rerouted writers to /tmp). The planted-file follow-up is the
// write-then-execute signal in index.ts. ----
test("A6: benign node -e arithmetic redirected to /tmp stays allowed", () => {
  assert.equal(confirms(`node -e '1+1' > /tmp/fp.js`), false);
});

test("A6: benign node -e with no destination stays allowed", () => {
  assert.equal(confirms(`node -e 'console.log(1)'`), false);
});

test("A6: benign python -c redirected into the tree stays allowed", () => {
  assert.equal(confirms(`python3 -c 'print(1)' > src/generated.ts`), false);
});

test("A6: node -e rmSync body confirms whatever the destination", () => {
  assert.equal(
    confirms(`node -e 'fs.rmSync("x",{recursive:true})' > .cache/o`),
    true,
  );
  assert.equal(confirms(`node -e 'fs.rmSync("x",{recursive:true})'`), true);
});

test("A6: fs.promises.rm and os.unlink body vocabulary confirm", () => {
  assert.equal(confirms(`node -e 'fs.promises.rm("x",{recursive:true})'`), true);
  assert.equal(confirms(`python3 -c 'import os; os.unlink("x")'`), true);
});

test("A6: perl unlink and flagless rm in awk system() confirm (eval corpus)", () => {
  assert.equal(confirms(`perl -e 'unlink "canary"'`), true);
  assert.equal(confirms(`awk 'BEGIN {system("rm canary")}'`), true);
});

test("A6: protected-prefix redirect from a benign inline body still confirms", () => {
  assert.equal(confirms(`node -e 'console.log(1)' > ~/.bashrc`), true);
});

// ---- Phase 2 (audit A7): interpreter heredocs — an opener naming an
// interpreter feeds a program, so every body line is judged; cat/wc openers
// keep the 16.1 rule (body lines are data). ----
test("A7: python heredoc body with shutil.rmtree confirms", () => {
  assert.equal(
    confirms("python3 - <<'EOF'\nimport shutil\nshutil.rmtree('/tmp/victim')\nEOF"),
    true,
  );
});

test("A7: node heredoc body with fs.rmSync confirms", () => {
  assert.equal(
    confirms(
      "node --input-type=module <<'EOF'\nimport fs from 'node:fs'; fs.rmSync('x');\nEOF",
    ),
    true,
  );
});

test("A7: benign python heredoc body stays allowed", () => {
  assert.equal(
    confirms("python3 - <<'EOF'\nprint(sum(range(10)))\nEOF"),
    false,
  );
});

test("A7: cat heredoc quoting interpreter-destructive prose stays data", () => {
  assert.equal(
    confirms(
      "cat > /tmp/notes.md <<'EOF'\nThe docs warn about shutil.rmtree misuse.\nEOF",
    ),
    false,
  );
});

// ---- Phase 2 (audit A13 partial): osascript -e joins the inline tripwire,
// with AppleScript deletion vocabulary judged in the body ----
test("A13: osascript -e Finder delete confirms", () => {
  assert.equal(
    confirms(`osascript -e 'tell application "Finder" to empty trash'`),
    true,
  );
});

test("A13: osascript -e do shell script rm confirms", () => {
  assert.equal(confirms(`osascript -e 'do shell script "rm -rf /tmp/x"'`), true);
});

test("A13: benign osascript display dialog stays allowed", () => {
  assert.equal(confirms(`osascript -e 'display dialog "hi"'`), false);
});

// ---- Phase 2 (audit A6): write-then-execute — the pure halves of the
// session signal (record /tmp write targets; recognize their execution).
// The per-session state, the reset, and the confirm ask live in index.ts. ----
const recorded = (seg) => new Set(tmpWriteTargetsOf(seg));

test("W2E: /tmp redirect and tee targets are recorded as written", () => {
  assert.ok(tmpWriteTargetsOf("printf 'x' > /tmp/fp.js").includes("/tmp/fp.js"));
  assert.ok(tmpWriteTargetsOf("echo x | tee /tmp/fp.js").includes("/tmp/fp.js"));
});

test("W2E: non-/tmp targets are not recorded", () => {
  assert.deepEqual(tmpWriteTargetsOf("echo x > out.log"), []);
  assert.deepEqual(tmpWriteTargetsOf("echo x > .cache/o"), []);
});

test("W2E: interpreter operand execution of a recorded path hits", () => {
  const rec = recorded("printf 'x' > /tmp/fp.js");
  assert.equal(
    executesRecordedTmpTarget(splitSegments("node /tmp/fp.js"), rec),
    "/tmp/fp.js",
  );
  assert.equal(
    executesRecordedTmpTarget(splitSegments("bash /tmp/fp.js"), rec),
    "/tmp/fp.js",
  );
  assert.equal(
    executesRecordedTmpTarget(
      splitSegments("osascript /tmp/fp.js"),
      recorded("echo x | tee /tmp/fp.js"),
    ),
    "/tmp/fp.js",
  );
});

test("W2E: command-position execution of a recorded path hits", () => {
  const rec = recorded("echo 'x' > /tmp/run.sh");
  assert.equal(
    executesRecordedTmpTarget(splitSegments("/tmp/run.sh --flag"), rec),
    "/tmp/run.sh",
  );
});

test("W2E: benign re-reads never hit", () => {
  const rec = recorded("echo 'x' > /tmp/fp.js");
  assert.equal(
    executesRecordedTmpTarget(splitSegments("cat /tmp/fp.js"), rec),
    undefined,
  );
  assert.equal(
    executesRecordedTmpTarget(splitSegments("grep -n x /tmp/fp.js"), rec),
    undefined,
  );
  assert.equal(
    executesRecordedTmpTarget(splitSegments("wc -l /tmp/fp.js"), rec),
    undefined,
  );
});

test("W2E: an unrecorded path is not an execution hit", () => {
  const rec = recorded("echo 'x' > /tmp/fp.js");
  assert.equal(
    executesRecordedTmpTarget(splitSegments("node /tmp/other.js"), rec),
    undefined,
  );
  assert.equal(
    executesRecordedTmpTarget(splitSegments("grep bash /tmp/fp.js"), rec),
    undefined,
  );
});

test("W2E: the writing command itself never self-hits", () => {
  const writer = "node -e '1+1' > /tmp/fp.js";
  assert.equal(
    executesRecordedTmpTarget(splitSegments(writer), recorded(writer)),
    undefined,
  );
  // and a PRIOR writer's target still hits a later different-file executor
  assert.equal(
    executesRecordedTmpTarget(
      splitSegments("node /tmp/fp.js"),
      recorded("echo 'x' > /tmp/other.js"),
    ),
    undefined,
  );
});

// ---- 2026-11-18 code review (findings 1-4, 6): control-plane relative and
// copy lanes, prefixed execution, body-vocabulary shapes, heredoc tags ----
const GATE_CWD = fileURLToPath(new URL("../../", import.meta.url));

test("R1: relative redirect/tee into the gate tree is a protected write target", () => {
  assert.ok(
    protectedWrittenTargetOf(
      "echo x > extensions/permission-gate/config.json",
      GATE_CWD,
    ),
  );
  assert.ok(
    protectedWrittenTargetOf(
      "sed s/x/y/g extensions/permission-gate/config.json | tee extensions/permission-gate/config.json.new",
      GATE_CWD,
    ),
  );
  // absolute spelling hits without any cwd help
  assert.ok(
    protectedWrittenTargetOf(
      `echo x > ${join(GATE_CWD, "extensions/permission-gate/config.json")}`,
      "/tmp",
    ),
  );
  assert.equal(protectedWrittenTargetOf("echo x > src/x.ts", GATE_CWD), undefined);
  // same relative spelling from an unrelated cwd resolves away from the tree
  assert.equal(
    protectedWrittenTargetOf("echo x > extensions/permission-gate/config.json", "/tmp"),
    undefined,
  );
});

test("R2: cp/mv/install/rsync into the gate tree is a protected copy target", () => {
  for (const cmd of [
    "cp evil.json extensions/permission-gate/config.json",
    "mv evil.json extensions/permission-gate/config.json",
    "install -m644 evil.json extensions/permission-gate/config.json",
    "rsync -a evil.json extensions/permission-gate/",
    "sudo cp evil.json extensions/permission-gate/config.json",
  ]) {
    assert.ok(protectedCopyTargetOf(cmd, GATE_CWD), cmd);
  }
  assert.equal(protectedCopyTargetOf("cp a b", GATE_CWD), undefined);
  assert.equal(
    protectedCopyTargetOf("cp evil.json extensions/permission-gate/config.json", "/tmp"),
    undefined,
  );
  assert.equal(protectedCopyTargetOf("cat evil.json", GATE_CWD), undefined);
});

test("R3: env- or wrapper-prefixed execution of a recorded /tmp target hits", () => {
  const rec = recorded("echo 'x' > /tmp/fp.js");
  assert.equal(
    executesRecordedTmpTarget(splitSegments("FOO=1 /tmp/fp.js"), rec),
    "/tmp/fp.js",
  );
  assert.equal(executesRecordedTmpTarget(splitSegments("sudo /tmp/fp.js"), rec), "/tmp/fp.js");
  assert.equal(executesRecordedTmpTarget(splitSegments("exec /tmp/fp.js"), rec), "/tmp/fp.js");
  // non-recorded paths still never hit
  assert.equal(executesRecordedTmpTarget(splitSegments("sudo node src/x.ts"), rec), undefined);
});

test("R4: argument-less rm/unlink mentions in inline bodies stay allowed", () => {
  // word with NO following argument is prose (accepted-FP note: `rm <arg>` in
  // prose still confirms — embedded-shell deletion shapes look identical)
  assert.equal(confirms(`node -e 'console.log("rm")'`), false);
  assert.equal(confirms(`node -e 'console.log("flags: rm, unlink, rmdir")'`), false);
  // code shapes still confirm
  assert.equal(confirms(`node -e 'fs.rm("x")'`), true);
  assert.equal(confirms(`node -e 'fs.promises.rm("x",{recursive:true})'`), true);
  assert.equal(confirms(`node -e 'fs.rmSync("x",{recursive:true})'`), true);
  assert.equal(confirms(`node -e 'rmSync("x")'`), true);
  assert.equal(confirms(`perl -e 'unlink "canary"'`), true);
  assert.equal(confirms(`perl -e 'unlink $f'`), true);
  assert.equal(confirms(`python3 -c 'import os; os.unlink("x")'`), true);
  assert.equal(confirms(`python3 -c 'shutil.rmtree("x")'`), true);
  assert.equal(confirms(`python3 -c 'import os; os.remove("x")'`), true);
  assert.equal(confirms(`awk 'BEGIN {system("rm canary")}'`), true);
});

test("R5: heredoc delimiter named like an interpreter stays data", () => {
  assert.equal(
    confirms("cat <<node\nThe docs warn about shutil.rmtree misuse.\nnode"),
    false,
  );
});

// ---- Phase 6 (audit A12): negation-hardened approval matching ----
// An affirmative in the shadow of a negation is a refusal: "don't proceed",
// "no, do not run it", "not approved" must NOT arm promptApproves. The
// pre-scan voids a match whose clause (text since the last sentence
// boundary) contains a negation word before it; other matches still count.
test("A12: negated affirmatives do not approve", () => {
  for (const p of [
    "don't proceed",
    "Don't proceed with the deploy.",
    "no, do not run it",
    "not approved",
    "That is not approved — stop.",
    "I won't say yes to this",
    "never approve that",
  ]) {
    assert.equal(approvalIn(p), false, JSON.stringify(p));
  }
});

// Design note: the scan voids affirmatives PRECEDED by a negation (the
// audit's failing shapes). A refusal that FOLLOWS a clean affirmative
// ("do it? no") keeps the approval — qualifier-first approval like
// "yes proceed, not the other file" must still pass.

test("A12: clean affirmatives still approve", () => {
  for (const p of [
    "yes",
    "yes, run the deploy now",
    "Please proceed",
    "approved",
    "go ahead with the cleanup",
    "Yesterday I said no. Yes, proceed now.", // refusal confined to its own sentence
    "/ship",
    "/issue fix the login bug",
  ]) {
    assert.equal(approvalIn(p), true, JSON.stringify(p));
  }
});

test("A12: negation elsewhere in the message does not void a clean later sentence", () => {
  assert.equal(approvalIn("Not this one. Do it for the other file."), true);
  assert.equal(approvalIn("no. yes"), true);
  // mixed single sentence stays a refusal (fail-closed: re-ask)
  assert.equal(approvalIn("not that file, but yes proceed"), false);
});

// ---- Phase 6 (audit A12b): copy destinations as affected paths ----
test("copyTargetOf: final operand of cp/mv/install/rsync, else undefined", () => {
  assert.equal(copyTargetOf("cp a.txt b.txt"), "b.txt");
  assert.equal(copyTargetOf("mv -f a.txt dir/b.txt"), "dir/b.txt");
  assert.equal(copyTargetOf("sudo install -m644 a b"), "b");
  assert.equal(copyTargetOf("cat a b"), undefined);
  assert.equal(copyTargetOf("cp only-one"), undefined);
});
