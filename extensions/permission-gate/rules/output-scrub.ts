/** Output scrub for bash tool results (2026-10-13, adopted from
 * pi-rtk-optimizer compaction principles): lossless-or-labeled compaction
 * that runs BEFORE the H1 cap. Three stages, each independently skippable:
 *  1. ANSI stripping — terminal escape codes never reach the model.
 *  2. Test aggregation — long runs of passing test lines collapse to a
 *     counted summary; failure/error lines are ALWAYS kept verbatim.
 *  3. Build filtering — large outputs keep only error/warning lines plus
 *     head/tail anchors, with an explicit elision note.
 * Never applied to: read results, gate block messages, structuredContent.
 * The H1 cap/spill still runs afterwards and remains the safety net — its
 * spill file holds the full post-scrub text (elided pass lines stay gone,
 * failure lines were already kept). */

/** ESC [ … letter, plus OSC sequences and a few common one-shot codes. */
const ANSI_RE =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\r(?=\n)|\r/g;

export function stripAnsi(s: string): string {
  return ANSI_RE.test(s) ? s.replace(ANSI_RE, "") : s;
}

/** passing-result markers: vitest/jest ✓/✗/PASS/FAIL, go test ok/FAIL,
 * pytest dots, plain "N passed". Failures use a separate set — anything
 * not in PASS_RE and not pure noise is kept by default. */
const PASS_RE =
  /^\s*(?:[✓✔]|ok|PASS|passed)(?=\s|$)|^\s*\d+\s+pass(?:ing|ed)?\b|^\s*[.·]+\s*$/i;
const FAIL_RE =
  /✗|✘|×|FAIL|failed|failure|error|warn|panic|assert|expected|actually|diff\b/i;
/** pure-noise lines dropped even in kept output when test-shaped */
const NOISE_RE = /^\s*(?:·|-+|={2,}|$)/;

/** Summarize a passing-test flood. Returns undefined when the output is not
 * test-shaped (no PASS markers) or small enough not to matter. */
export function aggregateTests(full: string, minLines = 12): string | undefined {
  const lines = full.split("\n");
  if (lines.length < minLines) return undefined;
  let pass = 0;
  for (const l of lines) {
    if (PASS_RE.test(l)) {
      pass++;
      continue; // passing line — count, drop
    }
  }
  // only test-shaped output: at least half the lines were pass markers
  if (pass * 2 < lines.length) return undefined;
  const kept = lines.filter((l) => !PASS_RE.test(l) && !NOISE_RE.test(l));
  return [
    `[tests: ${pass} passing line(s) elided by permission-gate; failures below kept verbatim]`,
    ...kept,
  ].join("\n");
}

/** Keep errors/warnings + head/tail anchors from large non-test output.
 * Returns undefined for small outputs (cap handles those). */
export function filterBuild(full: string, minLines = 30): string | undefined {
  const lines = full.split("\n");
  if (lines.length < minLines) return undefined;
  const keep = lines.filter((l) => FAIL_RE.test(l));
  if (keep.length === 0) return undefined; // nothing actionable — let the cap head-cut do it
  const head = lines.slice(0, 3);
  const tail = lines.slice(-3);
  return [
    ...head,
    `[build: ${lines.length - head.length - tail.length} line(s) elided; ${keep.length} error/warning line(s) kept]`,
    ...keep,
    ...tail,
  ].join("\n");
}

/** Apply the scrub pipeline in place to a text-block content array.
 * Returns true when any text block was rewritten. */
export function scrubBashText(blocks: unknown[]): boolean {
  const orig = blocks
    .filter((b) => (b as { type?: unknown })?.type === "text")
    .map((b) => String((b as { text?: unknown })?.text ?? ""))
    .join("\n");
  if (orig === "") return false;
  let full = stripAnsi(orig);
  full = aggregateTests(full) ?? full;
  full = filterBuild(full) ?? full;
  if (full === orig) return false;
  const first = blocks.findIndex(
    (b) => (b as { type?: unknown })?.type === "text",
  );
  blocks.splice(
    first,
    blocks.filter((b) => (b as { type?: unknown })?.type === "text").length,
    { type: "text", text: full },
  );
  return true;
}
