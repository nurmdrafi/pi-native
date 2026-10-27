/** R9: commitlint — conventional-commit validation of every -m message of a
 * 'git commit' segment (type(scope?): subject, header <= 100 chars, subject
 * case rules, body line length), including heredoc-delivered bodies. Runs
 * before the destructive confirm so permission is never asked for a message
 * the hook would reject anyway. */
const COMMIT_TYPES =
  "feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert";
// 2026-10-11: scope is [^)]+ — [\\w\\-.]+ rejected feat(api/auth) and fix(a,b)
const CONVENTIONAL_HEADER = new RegExp(
  `^(${COMMIT_TYPES})(\\([^)]+\\))?!?: .+`,
);

/** S-1 (2026-10-09): body of a `<<'EOF' … EOF` heredoc embedded in a -m
 * value, else undefined */
function extractHeredoc(val: string): string | undefined {
  const m = /<<-?\s*(['"]?)(\w+)\1\s*\n([\s\S]*?)\n[ \t]*\2(?:\s|$)/.exec(val);
  return m ? m[3] : undefined;
}

/**
 * Validates every -m message of a 'git commit' segment against the commitlint
 * conventional pattern (type(scope?): subject, header <= 100 chars, subject
 * not capitalized / not ending in '.'). Returns a block reason or undefined.
 */
export function validateCommitMessages(seg: string): string | undefined {
  // 2026-10-08 (B12): -m\s+ missed -m"x", -am "x" (m inside a combined short
  // flag cluster) and --message=x; 2026-10-08 (B21): unescape mapped \n to a
  // literal 'n' — a real newline keeps the header the first line, as the
  // shell would deliver it. Unquoted values (--message=y, -m foo) captured too.
  const flags = [
    ...seg.matchAll(
      /(?:^|\s)(?:--[a-zA-Z-]*message|-[a-zA-Z]*m)\s*(?:=\s*)?(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s"'][^\s]*))/g,
    ),
  ];
  if (flags.length === 0) return; // -F / editor message: not inspectable
  for (let i = 0; i < flags.length; i++) {
    let msg = (flags[i][1] ?? flags[i][2] ?? flags[i][3] ?? "")
      .replace(/\\n/g, "\n")
      .replace(/\\(["'\\])/g, "$1");
    if (!msg) continue;
    // S-1: `-m "$(cat <<'EOF' … EOF)"` delivers the message via heredoc —
    // lint the BODY, not the shell literal
    const heredoc = extractHeredoc(msg);
    if (heredoc !== undefined) msg = heredoc;
    const lines = msg.split("\n");
    if (i === 0) {
      const header = lines[0];
      if (!CONVENTIONAL_HEADER.test(header)) {
        return `Commitlint: ${JSON.stringify(header)} must match 'type(scope?): subject' — e.g. 'fix(auth): cap git log'.`;
      }
      if (header.length > 100) {
        return `Commitlint: header is ${header.length} chars (max 100) — shorten the subject.`;
      }
      const subject = header.replace(/^\S+\s*/, ""); // strip type/scope for subject rules
      {
        // 2026-10-08 (B13): mirror config-conventional's subject-case — ban
        // sentence-case ("Fix the…"), start-case ("Fix The Thing") and all-caps
        // subjects, but allow acronym-led subjects ("API timeout", "JSON
        // parse") that the old /^[A-Z]/ wrongly rejected; hooks backstop leaks.
        if (
          /^[A-Z][a-z]/.test(subject) ||
          /^([A-Z][a-z]*\s)+[A-Z][a-z]*$/.test(subject) ||
          /^[A-Z\s]+$/.test(subject)
        ) {
          return `Commitlint: subject must not start with a capital ('${subject.slice(0, 30)}…') — lowercase it.`;
        }
        if (/[.]$/.test(header)) {
          return `Commitlint: header must not end with '.'.`;
        }
      }
    }
    // S-1: body-max-line-length (100, config-conventional) on every -m part —
    // until now the git hook enforced it alone (two rejects in one /ship)
    const bodyLines = i === 0 ? lines.slice(1) : lines;
    for (let j = 0; j < bodyLines.length; j++) {
      if (bodyLines[j].length > 100) {
        return `Commitlint: body line ${j + 1} of message part ${i + 1} is ${bodyLines[j].length} chars (max 100) — wrap it.`;
      }
    }
  }
  return;
}
