/**
 * Phase inference (PH1) — a read-only label for the current turn.
 *
 * The gate already blocks mechanical loops (R10 identical re-runs, R11 failure
 * streaks, LG1 edit churn). This module adds the missing *descriptive* signal:
 * which stage of the work the turn is in, so the model can name its own
 * situation instead of being told only what it did wrong.
 *
 * Rules that make a label safe to ship:
 * 1. It never blocks. Phase-based blocking fights the locate -> read -> edit
 *    workflow the harness mandates, so severity only decides whether the note
 *    is emitted (`ruleEnabled`), never whether a call runs.
 * 2. At most one note per turn, on entry into `recovering`.
 * 3. Toolchain-agnostic: `isVerifyCommand` matches command families, not one
 *    project's runner, so a Rust repo and an npm repo classify alike.
 */
export type Phase = "idle" | "exploring" | "editing" | "verifying" | "recovering";

export type ActionKind = "read" | "edit" | "verify" | "other";

/**
 * Command families that *verify* existing work rather than produce it. Broad on
 * purpose: a false positive costs one note, never a block.
 */
const VERIFY_RE =
  /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|lint|typecheck|build|check)\b|\b(?:cargo\s+(?:test|build|check|clippy)|pytest|vitest|jest|mocha|tsc|go\s+(?:test|build|vet)|make|gradle|mvn|rspec|phpunit)\b/;

/** True when `cmd` is a verify-family command (test/build/lint/typecheck). */
export function isVerifyCommand(cmd: string): boolean {
  return VERIFY_RE.test(cmd);
}

/**
 * Next phase given the previous one and the action just completed. Verify
 * failures land in `recovering`; everything else is a forward step. `other`
 * actions leave the phase untouched — an unrelated command is not a stage.
 */
export function nextPhase(
  prev: Phase,
  action: { kind: ActionKind; failed: boolean },
): Phase {
  switch (action.kind) {
    case "read":
      return "exploring";
    case "edit":
      return "editing";
    case "verify":
      return action.failed ? "recovering" : "verifying";
    default:
      return prev;
  }
}
