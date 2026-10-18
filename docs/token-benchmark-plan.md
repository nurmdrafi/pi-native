# Token Usage Benchmark Plan — Tool-Path Comparison

Goal: measure real LLM token overhead of each execution path (direct Rust tools vs codemode orchestration vs permission-gate behavior) on an identical task, in a fully isolated environment.

## Hypotheses under test
- H1: codemode reduces conversational tokens (bulk tool output stays in sandbox) but adds fixed schema/prompt overhead.
- H2: direct tool calls spend more conversation tokens on tool results re-entering context.
- H3: permission-gate blocks cause retry loops (blocked result → re-plan → new call) that inflate turns and tokens more than the gate's static cost.

## Variants (4)
All variants run the same task, same model, same seed workspace. Only tool policy and loaded extensions differ.

| ID | Path | codemode | Rust exts | permission-gate |
|----|------|----------|-----------|-----------------|
| V1 `direct` | direct Rust tool calls only | excluded (`--tools -codemode`) | piread, piedit, pibash, pidx | not loaded |
| V2 `codemode` | multi-step work routed through codemode | available, mandated by AGENTS.md | same as V1 (codemode needs callable tools) | not loaded |
| V3 `gate-on` | direct calls, gate active, run stays compliant | excluded | same as V1 | loaded, default rules |
| V4 `gate-block` | direct calls, gate blocks one planned call | excluded | same as V1 | loaded; one rule (e.g. `commitlint` or `outputCap`) intentionally triggers on the task's hook step |

Note: gate rule evaluation itself is host-side; its token cost appears only via injected messages and forced retries. V3 vs V4 separates "gate present" from "gate blocking".

## Isolation (verified mechanisms)
- Per-variant agent home: `bench/pi-homes/<variant>/` selected via `PI_CODING_AGENT_DIR`. Each home gets its own `settings.json` (model, `defaultTools`), `AGENTS.md` (tool policy — byte-identical except one policy line), and `sessions/` so token logs never mix with daily sessions. `auth.json` copied in once.
- Fresh workspace per run: `bench/runs/<variant>-r<k>/` seeded from `bench/task-template/` by the runner script. No state carries over.
- Headless: `pi --print "<prompt>"` with fixed model and thinking level.
- Confound control: turn-1 input tokens are reported separately (system prompt + tool schemas + AGENTS.md) so fixed overhead is visible apart from conversational overhead from the differing policy line.

## Shared task (identical prompt for all variants)
Seed: ~8-file mini TypeScript project with one planted bug and a failing scoped test. Prompt: "In this repo, find and fix the failing check in src/auth.ts, add a regression test, run the scoped test, fix the commit message lint failure by committing with a valid message, and write REPORT.md summarizing the root cause."

Exercises: ≥3 reads, ≥2 edits, ≥1 write, ≥2 bash calls, 1 commit (the gate hook for V4). Grading: `bench/grade.sh` (plain script, no LLM) checks tests pass, expected diff applied, REPORT.md exists. Failed runs are discarded and re-run, and failures are logged.

## Run matrix
- 4 variants × 3 runs = 12 sessions. Fresh session each run. First run of V1/V2 doubles as the pilot (grade-checked before continuing); no extra pilot runs.
- Fixed model `deepseek-flash`, thinking level `off`, non-interactive.

## Metrics (parsed from session JSONL by `bench/report.mjs` — no LLM involved)
Per run: total input, output, cacheRead, cacheWrite, cost; turn count; tool-call count by tool name; blocked-call count; wall time. Turn-1 input tokens reported separately. Per variant: mean / median / min–max and delta vs V1 baseline. Output: `bench/report.md` comparison table.

## Implementation steps
1. Scaffold `bench/`: task-template, grade.sh, runner.sh, report.mjs, 4 pi-homes.
2. Verify each pi-home loads exactly the intended tools (`pi --print` + a probe prompt).
3. Pilot (V1, V2 ×1), check grade passes and cost is acceptable.
4. Full matrix 4×5.
5. Aggregate, write report.md, conclude per hypothesis.

## Open questions
- V3 (gate-on) included, or is 3 variants enough (direct / codemode / gate-block)?
- 5 runs per variant and the daily model OK for budget?


