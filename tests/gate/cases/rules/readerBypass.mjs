// Permission-gate cases for rules.readerBypass (SE2) at its teaching tier.
// Read windows belong to piread; the reason names the equivalent call
// (offset/limit for a range, hits for a search with context, outline --show
// for a unit). Shell views print lines that still certify (VC /
// bashViewCredit), so the note points at the tool rather than denying the
// credit; the fail-closed tier is pinned in reader-bypass-error.test.mjs.
// Pipeline stages are untouched: a `sed -n`/`head`/`tail` filtering output a
// command already produced reads no file.
import { bash, runBash, noteOf } from "../../harness/helpers.mjs";

/** passes with the SE2 note naming the piread call; a miss reports as blocked */
const notedBy = (r, needle) =>
  !r.blocked && noteOf(r).includes("Reader-bypass") && noteOf(r).includes(needle)
    ? r
    : { blocked: true, reason: `note: ${noteOf(r) || "(none)"}` };

export const cases = [
  [
    "SE2: 'sed -n' as reader rides a note naming piread",
    "pass",
    async (pi) => notedBy(await runBash(pi, "sed -n '52,58p' ~/.pi/agent/AGENTS.md"), "piread"),
  ],
  [
    "SE2: 'cat file' rides a note naming piread",
    "pass",
    async (pi) => notedBy(await runBash(pi, "cat ~/.pi/agent/package.json"), "piread"),
  ],
  [
    "SE2: 'head -n K file' rides a note naming piread",
    "pass",
    async (pi) => notedBy(await runBash(pi, "head -n 5 ~/.pi/agent/package.json"), "piread"),
  ],
  [
    "SE2: 'head file' (short form) rides a note",
    "pass",
    async (pi) => notedBy(await runBash(pi, "head ~/.pi/agent/package.json"), "piread"),
  ],
  [
    "SE2: 'tail -n K file' rides a note naming piread",
    "pass",
    async (pi) => notedBy(await runBash(pi, "tail -n 5 ~/.pi/agent/package.json"), "piread"),
  ],
  [
    "SE2: a read-position reader after && rides a note",
    "pass",
    async (pi) => notedBy(await runBash(pi, "cd /tmp && head -3 ~/.pi/agent/package.json"), "piread"),
  ],
  [
    "SE2: pipeline-stage sed (substitution, no -n) is not flagged",
    "pass",
    async (pi) => bash(pi, "rg -n foo src/ | sed 's/foo/bar/' | head -5"),
  ],
  [
    "SE2: pipeline-stage sed -n filtering produced output is not flagged",
    "pass",
    async (pi) => bash(pi, "rg -n foo src/ | sed -n '1,5p'"),
  ],
  [
    "SE2: 'cmd | head' filters a command's output and is not flagged",
    "pass",
    async (pi) => bash(pi, "rg -n foo src/ | head -5"),
  ],
  [
    "SE2: 'cmd | tail' filters a command's output and is not flagged",
    "pass",
    async (pi) => bash(pi, "du -sh src/ | tail -1"),
  ],
  [
    "SE2: tail -f follows a log instead of reading a window",
    "pass",
    async (pi) => bash(pi, "tail -f /tmp/scratch.log"),
  ],
  [
    "SE2: cat used as a writer reads no window and is not flagged",
    "pass",
    async (pi) => bash(pi, "printf 'x\\n' | cat > /tmp/scratch.txt"),
  ],
  [
    "SE2: a heredoc write through cat is not flagged",
    "pass",
    async (pi) => bash(pi, "cat <<'EOF' > /tmp/scratch.md\nnotes\nEOF"),
  ],
  [
    "SE2: jq reading a file is not flagged",
    "pass",
    async (pi) => bash(pi, "jq -r '.name' ~/.pi/agent/package.json"),
  ],
];
