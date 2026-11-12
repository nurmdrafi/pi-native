# Subagent Improvement — Implementation Plan

Status: **VALIDATED** — all three validation scouts complete (section 6); findings folded into sections 3–5. No code until this plan is approved.
Source goal: `research/subagent-improvement.md` (same directory).
Rule: no code edits until this plan is approved after validation.

## 1. Goals (from source doc)

1. **Automated file-conflict safety** — the runtime (spawn queue) owns file locks; orchestrators stop hand-planning disjoint file-sets.
2. **Token-consumption reduction** — children in one wave must not independently re-read identical target files.
3. **Cross-agent memory** — hub-and-spoke becomes a context-sharing hierarchy via localized data handoffs.

Engineering tasks: extend the result-inbox schema (`files_changed`, structural outputs); dependency tracking via path parsing of raw task strings; a sequential dependency lock for overlapping runs with parallel lanes for disjoint runs; automatic injection of prior-result snapshots into child task payloads.

Scope confirmed by user feedback: the goals are **reduce token consumption, eliminate redundant same-file lookup/search/read across a wave, automatic conflict resolution, cross-agent memory share**. Dashboard changes are excluded. Subagents must run **inside** the permission gate (ungated children = token cost + missing security checks).

## 2. Verified current-state anchors

| Fact | Anchor |
|---|---|
| `InboxRecord` schema (no files field today) | `extensions/subagents/inbox.ts:21-40` |
| Inbox append / drain (id-dedupe, state file) | `inbox.ts:68`, `inbox.ts:85`; compaction `inbox.ts:120-135` |
| Child self-report (`observedByParent:false`, env-driven) | `extensions/subagents/subagent-done.ts:127-151` |
| Parent + synthesized record writer | `extensions/subagents/index.ts:2367-2388` (`persistResultRecord`); delivery funnel `index.ts:2380+` |
| Slot queue: `SpawnQueue` class, singleton, pendingSpawns FIFO, drain hook | `extensions/subagents/spawn-queue.ts:18`; `index.ts:766-778`; drain `index.ts:824-848` |
| Spawn tool schema / self-spawn guard / tryAcquire-or-queue | `index.ts:116-151`, `index.ts:3111+`, queue push `index.ts:3236-3241` |
| Child env channel (`PI_SUBAGENT_*`) | `index.ts:2090-2099` |
| Task payload assembly + `buildPiPromptArgs` + artifact delivery mode | `index.ts:1956-1957`, `index.ts:1114`, `index.ts:1125` |
| CLI/env task delivery (`cmdParts`, `PI_SUBAGENT_TASK`) | `index.ts:1983`, `index.ts:2099` |
| Budget resolve at launch (not queue time); stopper fields | `index.ts:1901`, `index.ts:728-733` |
| Reconcile sweep (pane_lost/stalled) finalizes via delivery | `extensions/subagents/reconcile.ts:54-70` |
| Pane-loss restart keeps the running entry | `RunningSubagent.restart`, `index.ts:757-759` |
| Name reservation is synchronous before any await (race precedent) | `index.ts:3219-3225` |
| Session-start inbox drain | `index.ts:2927` |
| Dashboard consumer whitelists keys (unknown keys ignored) | `dashboard/scripts/feeds.mjs:195-236` |
| Test surface pattern (`__test__` exports) | `index.ts:1757-1772` |
| Working tree clean for `extensions/`, `dashboard/`, `tests/` at plan time | `git status` |

Corrections to the source doc, verified: `spawn-queue.ts` (79 lines) is a pure slot counter — there is no payload-generation block in it; payload assembly lives at `index.ts:1956-1957`. Locks go in `spawn-queue.ts`; injection goes in `index.ts`.

## 3. Design (amendable by section 6)

### 3.1 Scope derivation — new `extensions/subagents/scope.ts`

Evidence verdict (see section 6) + user review amendment: **the declared param is the ONLY lock-forming source; parsed scope is context-only** (injection matching + display) and never locks — parsing noise can never serialize a wave, and read-only agents (which declare nothing) always stay parallel. Measured on 40 recent real tasks: 93.3% yield ≥1 valid parsed path, but median 5 valid from 17.5 candidates, 4/30 create-tasks name not-yet-existing deliverables (invisible to existence-validated parsing, yet the highest edit-conflict class), ~7% implied-only.

`deriveScope(task, cwd, declaredFiles?) -> { paths: string[]; origin: "declared" | "parsed" | "none" }`

1. **Declared** (primary): new optional `files?: string[]` on `SubagentParams` (`index.ts:116`). Repo-relative paths/dirs; **not existence-validated** (create-task deliverables must lock). When present, this is the whole scope.
2. **Parsed** (fallback only, `origin:"parsed"`): regex over `params.task` for path-shaped tokens (chars `[A-Za-z0-9._@/-]`, containing `/` or a known extension); resolved against `params.cwd`; only tokens matching an existing file/dir are kept. Hygiene required by evidence: drop the bare `/` token (resolves to repo root → would own the whole tree; seen in 15/40 tasks), trim trailing punctuation before the existence check, split URLs at `:` before tokenizing.
3. Normalized to absolute, segment-prefix form (a dir owns its subtree). Empty result → unscoped → runs parallel (today's behavior; never worse).
4. Stored as `scope?: { paths: string[]; origin }` on `RunningSubagent` (`index.ts:706-764`). Reservation is synchronous in tool execute before any await (mirrors `index.ts:3219-3225`).

### 3.2 Sequential dependency lock — `spawn-queue.ts`

Add beside slots: `declareScope(id, {name, paths, state:"queued"|"running"})`, `releaseScope(id)` (idempotent), `findConflicts(paths) -> [{id, name, hits}]`. Conflict = segment-prefix overlap of absolute paths (file↔file exact, dir↔descendant, nested dirs). **Locks are write-only and declared-only** (user amendment): only `files[]`-declared scopes participate in conflict checks — read-read overlap and undeclared spawns never queue. Same relative path under different cwds = no conflict.

| declared write overlap (both sides) | `off` | `warn` | `queue` (default) |
|---|---|---|---|
| exact file or nested dir | no tracking | run; ack warns | join `pendingSpawns` FIFO, scope reserved `queued`, ack says "queued behind `<name>` (owns `<hits>`)" |
| either side unscoped | never blocks | ack lists current owners | same |

- `drainPendingSpawns` (`index.ts:824-848`) integration — ordering is a validated **blocker**: `release()` re-fires the drain hook synchronously (`spawn-queue.ts:50-52`), so parking a conflicting entry must mirror the existing no-`pi` pattern: `release()` FIRST, re-queue second, then stop the pass (re-queue-before-release recurses unboundedly). Drain policy — **skip-scan** (user amendment, supersedes head-of-line `break`): scan the queue in FIFO order, launch every non-conflicting entry while slots last, splice conflicting entries back at their ORIGINAL index so disjoint tasks keep their parallel lanes and parked order is preserved.
- Release point: **exactly one** — `deliverSubagentResult` after `runningSubagents.delete` (`index.ts:2404`), the single funnel for watcher exit, reconcile sweep, budget kill, and adoption. Delete sites inside `watchSubagent` (`index.ts:2779/2823/2857/2884/2898`) run before delivery and must NOT release. Queued spawns have no drop path (queue is module-local; process loss is wholesale and pre-existing). **Restart mutates the entry in place** (`index.ts:2553-2562`) — scope on the interface survives automatically; never store scope in budget fields (restart clears them). Resume path (`index.ts:1564-1584`) delivers inline and stays **unscoped** — documented, consistent with "unscoped never blocks".
- No deadlock: owners always terminate (budget stopper, pane reap → sweep, stall sweep); a queued child is never waited on by its owner.
- Budget untouched: `resolveBudget` runs at launch (`index.ts:1901`); queued spawns reserve no meter.
- Exposure: `subagents_list` gains `owns: [...]` per running/queued child; widget row shows lock glyph + count; `__test__` hooks.

### 3.3 Inbox schema — git-derived `files_changed`

Additive fields on `InboxRecord` (`inbox.ts:21-40`):

```ts
files_changed?: string[];                    // sorted, cap 200
files_changed_source?: "git_status_delta";   // provenance marker
outputs?: string[];                          // top-level files under artifacts/<id>/
```

- **No migration**: optional field; old JSONL lines simply lack it; drain keys on `id`; compaction rewrites empty-only; `feeds.mjs` whitelists keys.
- Spawn-time baseline: in repoRoot, `git status --porcelain=v1 -z --untracked-files=all` → `artifacts/<parentId>/<id>.git-baseline.json`; path to child via `PI_SUBAGENT_BASELINE` (`index.ts:2090` pattern). Durable — survives parent death for the reconcile path.
- Child (`subagent-done.ts:127`) and parent (`index.ts:2367`) both diff end-status vs the same baseline → consistent values modulo seconds of skew. Git runner injectable for tests.
- No git / no baseline / git failure → fields omitted. Over-attribution mitigation (validated risk: whole-repo baseline, siblings in one repo pollute each other — `inbox.ts:49-57`, no per-child isolation today): when the child has a scope, **intersect the git delta with the scope paths**; unscoped children emit the raw delta and the provenance marker keeps it advisory.
- Git runs **exclusively in extension processes** (parent at launch, child via `subagent-done.ts` loaded with `-e`) — never through a child tool call: a ~200-file porcelain output (~8KB) would exceed the 2KB bash-kind gate cap and truncate `files_changed`.
- Display: renderer caps at ≤20 paths + "+N more"; full list stays in `details` only (drain bystander delivery echoes records into every repo session's transcript — token cost, no hard failure).

### 3.4 Fact injection (goals 1+2+3)

In payload assembly (`index.ts:1956-1957`): if the child's scope overlaps a recent record's `files_changed`, append to the task text (max 2 records, 1200 chars total, overlap-only):

```
Prior work on your scope (from <name>, finished <m> min ago):
changed: <up to 10 paths>
read: <files_read overlapping the scope, if any>
<diff excerpt, max 800 chars — what actually changed>
<summary, max 300 chars>
Verify current file state yourself before editing; do not re-read for context this block already gives you.
```

Content spec (user amendment — a summary alone does not replace a re-read): the block carries a **capped diff excerpt** of what the owner changed plus the summary; records match the child's scope via `files_changed` OR `files_read`, so read-only followers also receive prior-reader context.

Read source — **NOT the drain-managed inbox** (validated blocker: it drains at every `turn_start` AND `session_start` of every extension-loading session in the repo, `index.ts:3065/3007`, compacting to empty; reliable only within one parent session's own wave window). Instead: new **append-only** `.pi/subagent-history.jsonl` — the same writers append one compact line `{id, ts, name, files_changed, summary-lite}` per result; never drained, never compacted by the inbox machinery; `readRecentResults(repoRoot, limit)` in `inbox.ts` reads a bounded tail (stat-cached like `feeds.mjs`); rotation keeps the last ~500 records on append when the file exceeds ~1000.

## 4. Test strategy (`tests/subagents/`, `npm run test:subagents`)

- New `scope-locks.test.ts`: token extraction (prose vs real paths, existence validation, bare-`/` and punctuation hygiene); **parsed scope never locks** (parsed-only overlap always launches); declared write-scope conflict matrix (exact/dir-nested/different-cwd); queue-behind-owner then launch on release; **conflict-park ordering — release before re-queue, no drain-hook recursion**; **skip-scan — non-conflicting tail launches past a parked head, parked entries keep their index**; warn/off modes; queued declared scope blocks a third colliding spawn while a slot is free; release on delivery only (delete-site non-release); reconcile-driven release; restart keeps reservation; resume-path entries stay unscoped.
- New `inbox-files.test.ts`: baseline diff → `files_changed` (fake git runner fixture); old lines without the field still drain; history file: append-per-result, survives drain/compaction, bounded-tail read, rotation at cap; renderer path cap (≤20 + "+N more"); injection block only on overlap, caps honored.
- Regression: `reconcile`, `queue-nonblocking`, `budget`, `restart`, `delivery-heal` stay green; `tsc --noEmit`.

## 5. Open challenges / conflict areas — validation targets

1. **Permission-gate output caps** — RESOLVED (favorable): H1 caps bash-kind tool results at 40 lines/2KB and H1b read-kind at 300 lines/8KB (`extensions/permission-gate/index.ts:18-19`, `bounds.gen.ts:16-27`); gates are `tool_result` hooks only, so extension-process `spawnSync`/`execFileSync` is outside every cap by construction (precedent `tmux.ts:16`). Crossing a cap: only child agent shell outputs. Not crossing: both git legs, injected task text (initial message, not a tool result), steer-delivered results (uncapped chain).
2. **Inbox lifetime vs injection**: drain compacts the file to empty once surfaced (`inbox.ts:120-135`) and every session_start drains (`index.ts:2927`) — measured: the inbox is **0 bytes at plan time with no drain-state file**, confirming post-drain empties are the norm, not the exception. Injection therefore needs a durable alternative source (decision pending validate-pipeline: child session files / artifacts are candidates).
3. **Task size limits** — RESOLVED: no size threshold exists; delivery mode is `sessionMode === "fork" ? direct : artifact` (`index.ts:454-459`, `2112-2127`) — artifact (`@file`, read uncapped) is the **normal path** for injected content, not a fallback; tmux command length is constant (`bash <script>`); only bound is kernel argv/env (~128KB/string). +1200 chars is ~1% of budget; plan drops the "artifact as size fallback" framing.
4. **Same-turn parallel spawn race** — RESOLVED SAFE: zero awaits between tool execute entry (`index.ts:3118`) and `tryAcquire` (`index.ts:3236`); every helper on that segment verified synchronous. `declareScope` anywhere in that segment is atomic.
5. **Release coverage** — RESOLVED: six `runningSubagents.delete` sites enumerated; `deliverSubagentResult` (`index.ts:2380+`) is the single funnel except the resume path (inline, stays unscoped); restart mutates in place, never deletes; slot acquire/release audit clean (no leak path).
6. **Regex yield** — MEASURED (271 total calls scanned, 40 most recent analyzed): ≥1 valid path in 93.3% of 30 real tasks (10/40 were ephemeral `/tmp` integration pings, all unscoped); ~87% plausibly fully scoped; ~7% implied-only; median 14 tokens/task (17.5 real), 5 valid. Systematic gaps: bare `/` token, trailing-punctuation gluing, URL splits, create-task deliverables. Residual risk: one resolvable prose pair over-serializes a wave → parsed scope stays fallback-only.
7. **Wall-clock regression**: over-matching serializes previously parallel waves; escape hatch = `PI_SUBAGENTS_SCOPE_MODE=warn|off`.
8. **Double-append consistency**: parent + child records share an id; both must carry the same `files_changed`. Structurally confirmed (inbox empty at plan time, so no live duplicate observed): varying fields are `observedByParent`, `ts`, plus parent-only `agent`/`parentSessionId`/`synthesized`.
9. **Git delta over-attribution** — mitigation chosen (see 3.3): scope-intersected delta when a scope exists; raw delta marked advisory otherwise. Child-side git runs in the child's own extension process (`subagent-done.ts` loaded via `-e`, `index.ts:2525-2528`; `execFileSync` precedent `tmux.ts:16`) — extension code is not tool-gated; document this.
10. **Adjacent pre-existing bug (found by validation)**: the sandbox gate re-enable default points at a nonexistent file (`~/.pi/agent/extensions/permission-gate.ts`; actual layout is a directory) → allowlisted children currently run with `--no-extensions` and no gate (`index.ts:1100`: default `PI_SUBAGENT_EXTRA_EXTENSIONS ?? join(homedir(), ".pi", "agent", "extensions", "permission-gate.ts")`). **In scope — commit 1** (§7): point the default at the directory (loader resolves `dir/index.ts`).
11. **Per-spawn synchronous git** — RESOLVED (user review): baseline capture is async (git + file write off the launch path; env var path still synchronous; child guards on file existence), so spawn latency is unaffected.

## 6. Validation phase (gate before final plan)

Three read-only scouts, disjoint scopes, unbudgeted:

1. **validate-pipeline** — DONE. Verdicts: gate caps touch only child shell outputs (git legs and injection are gate-invisible); no artifact size threshold (mode-based, artifact is the normal path); **blocker** — inbox drains at every turn_start/session_start repo-wide, so injection switches to an append-only `.pi/subagent-history.jsonl`; steer/renderer uncapped (renderer path cap added). Also surfaced the adjacent dead gate re-enable path (5.10).
2. **validate-internals** — DONE. Design holds with amendments (all folded in): (a) blocker — conflict-park must release-before-unshift-then-break (`spawn-queue.ts:50-52` drain-hook re-entry recurses otherwise); (b) explicit FIFO head-of-line `break` policy; (c) `releaseScope` at `index.ts:2404` only, resume path unscoped; (d) git delta scope-intersected to kill sibling over-attribution. Slot-leak audit clean; same-turn race segment verified await-free.
3. **validate-evidence** — DONE. Verdict: `files[]` param must be primary (declared, not existence-validated); parsed scope enrichment-only with `/`-filter and punctuation trim; registries carry no scope data (64 registry files, 254 uniform `{sessionFile, sessionId}` entries); inbox duplicate-id behavior confirmed structurally only. Numbers folded into sections 3.1 and 5.

Findings amend sections 3–5; verdicts feed section 10.

## 7. Commit plan (config-conventional; approval required before any commit)

1. `fix(subagents): re-enable permission gate for sandboxed children` — `index.ts:1100` dead default → gate directory; test asserts the gate lands in the sandboxed child launch command.
2. `feat(subagents): track changed files in subagent results` — `inbox.ts` (schema + `computeFilesChanged` + history file + `readRecentResults` + `buildPriorWorkBlock` helper), `subagent-done.ts` (child population), `index.ts` (spawn-time baseline + env + parent population + result-details threading + renderer path cap), `tests/subagents/inbox-files.test.ts`. No `outputs` field (decision 2); injection wiring deferred to commit 3 (needs scope).
3. `feat(subagents): enforce file-scope locks in spawn queue` — `scope.ts`, `spawn-queue.ts`, `index.ts` (`files` param + synchronous declared-scope reservation + skip-scan queue integration + exposure + injection wiring at payload assembly + parent-side scope-intersect of `files_changed`), `tests/subagents/scope-locks.test.ts`.
   (2b, conditional: if commit 2 landed before the read/diff amendment, `feat(subagents): record reads and diffs in subagent history` carries files_read + capped diff; otherwise folded into commit 2.)
4. `perf(subagents): single-parse delivery and byte-offset budget meter` — worker C wave (the speed the Rust evaluation found, without Rust): (a) thread the already-parsed session entries from `watchSubagent` delivery (`index.ts:2843`) through `deliverSubagentResult` → `persistResultRecord`/`extractFilesRead`, killing the delivery-time double full parse; (b) budget meter reads the child session file by byte offset (`fs.read` from last offset) instead of whole-file `readFileSync` per 1 Hz tick (`budget.ts:156`); (c) stat-gate the `turn_start` inbox drain (O(inbox) per parent turn → skip when the file stat is unchanged; drain wiring + `inbox.ts`). Also carries the deferred review nits (index.ts): merge child/parent `files_changed` at persist instead of superseding; timeout on the delivery-path git exec. Interim: `fix(subagents): append-only history and read-only child records` (fix-history wave — review should-fixes in `inbox.ts`, parallel-safe).

## 8. Execution waves (sequential — both touch `index.ts`)

worker A (commits 1–2) → worker B (commit 3) → worker C (commit 4, perf) → reviewer over combined diff → gate: `npm run test:subagents` + typecheck + build → follow-through (§10).

## 9. Decisions (resolved by user feedback)

1. Default mode: **`queue`** — automatic conflict resolution is the stated goal; `PI_SUBAGENTS_SCOPE_MODE=warn|off` stays as escape hatch.
2. `outputs` field: **follow-up** — not needed for the confirmed goals.
3. Dashboard: **out of scope entirely**.
4. Gate fix (5.10): **in scope — commit 1**.
5. After successful implementation: **follow-through phase (§10)** — update related docs + `prompts/issue-orchestrator.md`.
6. User review amendments (token/speed): locks are **declared-write-only** — read-read and undeclared spawns always parallel; drain uses **skip-scan** so disjoint tasks keep their lanes; **git is async at spawn** (baseline path passed synchronously, file written without blocking; child guards on existence); history carries **files_read + capped diff** so followers see what the owner changed and read-context reaches read-only waves.
7. Default `queue` is **gated by measurement (§11)**: first real overlapping wave is A/B'd via `PI_SUBAGENTS_SCOPE_MODE` + history metrics; regression → flip the default in a follow-up commit.
8. Rust evaluation (§12, user-requested): **no conversion this phase** — speed lands as TS fixes (commit 4); `plugin/` and `tools/` are live-wired and stay; removing them equals dropping the Claude-CLI spawn path / `safe_bash` capability — a separate product decision, not cleanup.
9. Data-format rule (user): logs and temp/intermediate data files are **NDJSON** for future retrieval — the inbox, history, and any §11 measurement captures or scratch digests comply (history is already NDJSON; readers skip malformed lines).
10. Control & measurement plane (user-directed, §13): pull-based inspection, mechanical signals only, measured baselines for time-sense, cancel/restart control verbs, duplicate-spawn warnings — commits 5–6 after commit 4.
11. Task sizing + cache-first (user): every agent task is scope-driven, measurable, ≤~10 min — larger scopes split into waves (C → D0 → D1 → D2). Global dedup cache (§15): cache lookup mandatory before any tool call, file read, or process.

## 10. Follow-through (after implementation passes the verification gate)

- `extensions/subagents/README.md`: `files` param, `PI_SUBAGENTS_SCOPE_MODE` semantics (queue/warn/off), history file `.pi/subagent-history.jsonl`, gate-default fix.
- `docs/subagents.md` (user-facing doc — same behavior changes): scope locks + `files` param + auto-queue semantics, `files_changed` in results and history file, corrected gate re-enable default (directory form; its current text documents the override but not the fixed default).
- `prompts/issue-orchestrator.md` §3 (group + order / pre-spawn check): spawns declare `files[]`; overlapping spawns auto-queue at the runtime layer; grouping by module stays for PR/branch semantics, the hard "no two LIVE groups share files" rule is relaxed to runtime enforcement + declared scopes.
- Related-file sweep (user-directed — all related files): `docs/development.md`, `docs/design-rules.md`, `docs/native-tools.md` — update only sections describing spawn/sandbox/result behavior this effort actually changed. Historical plan records (`docs/plans/subagent_budget_plan.md`, `docs/plans/subagent_architecture_plan.md`) stay untouched.
- Dashboard untouched (decision 3).

## 11. Measurement protocol (gates the `queue` default)

Scripted replay cannot measure LLM token behavior — the savings live in avoided re-reads and failed-edit retries, so the A/B runs on real waves:
- Arms: `PI_SUBAGENTS_SCOPE_MODE=off` vs `queue` on the next two similar-shape real overlapping waves.
- Metrics (from history + child session parsing, no new instrumentation): tokens/child (`InboxRecord.stats`), wall-clock (`elapsed`), same-path re-reads across a wave (`files_read`), failed-edit retries (child session edit sequences), queue wait (ack vs launch timestamps).
- Decision rule: keep `queue` unless tokens/child or wall-clock regress on the locked arm; a regression flips the default in a follow-up commit touching only the default.
- Session-skew note: an orchestrator session loads `extensions/subagents` at startup — a session that predates the commits runs the old parent code (no baseline env, no history rows, no locks) for its own waves, exactly like the dashboard-server skew. Measurement data (this section and §15) starts only with a fresh session or `/reload` after the gate; treat the building session's own waves as old-code.

## 12. Rust-tools evaluation (resolved — user-requested)

Evidence (rust-survey scout):
- **No subagent mechanism moves to Rust this phase.** The only frequency×size hotspot — the budget meter's whole-file `readFileSync` at 1 Hz (`budget.ts:156`) — is fixed cheaper in TS (byte-offset read): a per-call Rust binary adds the ~5 ms spawn floor per tick against the same disk bytes; a daemon adds lifecycle surface for one file read.
- **pidx extract reuse is blocked by design**: `ACTIVE_SESSION_MS` excludes sessions modified < 5 min (`rust-tools/pidx/src/main.rs:32,1080`), so a child session read at delivery (seconds after exit) is never in the extracts; pointing the extension at the dashboard's cache would couple two consumers' state files. A future `pidx --file` one-shot is the only clean Rust route and does not pay after the single-parse fix.
- **`plugin/` stays**: `plugin.json` + `hooks.json` + `on-stop.sh` are the live Claude-CLI spawn path (`index.ts:1972-1981`; sentinel polled at `tmux.ts:568+`; stall-check exemption `reconcile.ts:34-37`).
- **`tools/safe-bash.ts` stays**: wired as `safe_bash` (`index.ts:278`), pinned by tests (`tests/subagents/runner.ts:1287`).
- Neither is documented in the vendored README — both are local additions; removal is a product decision tied to dropping those capabilities, recorded here, not acted on.
- The speed outcome ships as commit 4 (TS perf fixes found by the same audit).

## 13. Control & measurement plane (user-directed — the workflow's value condition)

Principle: inspection is **pull-based** (the orchestrator asks via `subagents_list`; the widget/dashboard show it passively) — zero parent-context tokens until asked. Signals are **mechanical only** (elapsed, turns, tokens, cost, files touched, last-write age); no LLM self-reported "percent done". Time-sense comes from **measured baselines** (history), never fabrication.

Commit 5 — `feat(subagents): expose live child metrics and control verbs`
- `subagents_list` gains per running/queued child: elapsed, phase, turns completed + current-turn duration, tokens/cost so far (from the budget meter — already computed per tick), files-touched count, last-write age. Widget row gains compact elapsed+tokens. Completion: history rows gain `{turns, tokens, costUsd, durationMs}` (mirroring `InboxRecord.stats`).
- New `subagent_control` tool: `cancel <name>` — running child reuses the budget-stop interrupt→grace→kill path, finalizes via `deliverSubagentResult` with a `cancelled_by_parent` synthesized result (scope lock released by the existing funnel); queued child = remove from `pendingSpawns` + release reservation + slot parity. `restart <name>` on demand (reuse the pane-loss restart machinery).

Commit 6 — `feat(subagents): baselines and duplicate-spawn detection from history`
- Baselines: per-agent median/p90 elapsed+cost computed from history (`readRecentResults`); spawn ack includes "typical for `<agent>`: median Xm · p90 Ym · $Z" so the orchestrator gains time-sense at spawn; `subagents_list` flags children past p90.
- Duplicate detection: at spawn, normalized task text matched against running children + recent history (same agent) — exact or near-identical match → ack warning with the prior result reference ("identical task ran 12 min ago — result: <summary head>"); declared-file overlap with a running sibling is already handled by the commit-3 lock. Warn-only: legitimate re-runs stay possible; the orchestrator decides.
- These close the stated gaps: exact time measurement (per-turn durations + elapsed, all from session/activity timestamps), decision support (baselines + p90 flags + duplicate warnings), full control (cancel/restart/steer), waste reduction (duplicate warnings + files_read injection from commits 2-3).
- Known limit (surfaced by the issue-orchestrator doc wave): locks resolve each spawn's declared paths against ITS cwd to absolute paths — spawns in separate worktrees never collide (different absolute paths), so the runtime guarantee bites only for spawns sharing a working tree; cross-worktree overlap still rests on isolation + PR review (§14.1). Documented in the orchestrator prompt §3.

Wave order addition: worker C (commit 4) → worker D0 (single-parse threading + stat-gated drain micro-wave) → worker D1 (commit 5, further splittable: metrics exposure vs control verbs) → worker D2 (commit 6), each wave scoped and measurable, ≤~10 min per the standing sizing rule; reviewer covers the combined diff.

## 14. External-research outcome (arch-research scout — primary sources in its report)

**Validated as-is** (industry-measured, already in this plan): result-digest contract (children return 1–2k summaries, full data to files — Anthropic's biggest measured token lever; our inbox/summary shape); file-based localized handoffs over vector stores for code work (Anthropic memory-tool framing); spawn-time overlap/duplicate checks; baselines from own history with percentile bands (no public ETA algorithm exists — we own the data); hard caps + interrupt→grace→kill (Copilot 59-min, MLE-bench).

**Adapt** (contradictions with mitigations):
1. Shared-tree + locks contradicts the industry default (isolation + human merge — Copilot one-branch/one-PR, Claude-web per-session sandboxes, OpenHands containers). Keep locks for small scopes; **plan a worktree fallback mode** for large/risky write tasks (backlog decision — user call, not in commits 3–6).
2. Digest injection contradicts Cognition's "share full traces" (miscommunication failure mode). Mitigation: injection block carries **artifact references** (history row id + path) so a child can pull full detail on demand — one-line addition to `buildPriorWorkBlock`, fold into worker D's wave.
3. Pull-based orchestrator inspection is fine, but humans should get **push-based** signals: emit OTel GenAI agent-span-shaped events (spawn/invoke/tool/deliver/cancel) as NDJSON rows into the history stream — zero LLM tokens, dashboard-ready (backlog; natural extension of commit 5's metrics rows).
4. Parallel write-capable children are the documented-failure pattern (Cognition) — keep declared write scopes narrow, prefer parallel children for read-heavy work (operational guidance; goes into the §10 doc updates).

**Backlog** (not in commits 1–6; each needs its own decision): worktree fallback mode; OTel event emission (§15 absorbs the read-through cache); prompt-caching-stable shared prefix across a wave; summary length enforcement at delivery (≤2k tokens).

**Standing numbers** (for §11 framing): multi-agent ≈ 15× chat tokens; token usage explains ~80% of performance variance; multi-agent wins mainly on breadth-first parallelizable work — coding flagged as fewer truly parallel parts. Effort-scaling rule (Anthropic): 1 child for simple, 2–4 medium, 10+ complex; prescriptive delegation prompts (objective + output format + boundaries) measurably prevent duplicate work.

## 15. Global dedup cache (user requirement — validation-first)

Rule: every tool call, file read, and spawned process looks up the per-repo cache FIRST; duplicates of in-flight or completed work are reused, not re-executed.

Design sketch (a scout validates before any commit is specced):
- Per-repo NDJSON index `.pi/process-cache.jsonl` (append + rotate like history): entries `{key, kind: read|search|process|spawn, target, fingerprint, status: done|in-flight, owner, ts, ref}` — fingerprint = path+mtime_ns+size for files, argv+cwd hash for processes, task-hash for spawns; `ref` points at bounded derived results (digest, listing, summary) — never full file bodies (token savings live in derived reuse, not raw disk reads).
- Cache-first policy: read/search calls and child processes consult the index; identical in-flight call → second caller waits or receives the first's result ref; completed + fingerprint unchanged → ref reused. Injection (commit 3) consumes refs as content-level reuse across contexts; duplicate-spawn detection (commit 6) is the spawn kind of this cache; files_read metrics (commit 2) measure residual duplication.
- Sequencing: after commits 5–6 — scout first (where do reads actually duplicate per wave-metrics data; which layer pays: native tool vs extension), then a sized commit.
- Gate alignment (pinned rule): cached results replay through the SAME permission-gate caps/truncation as fresh results — store only the already-capped form; the index is touched exclusively by extension-process code (gate-invisible lane, git/tmux precedent); sandboxed children never read the index directly.
- Revalidation (lazy, on lookup — no watchers, no eager sweeps): every hit re-stats the target; `mtime_ns + size` unchanged → guaranteed fresh (class `exact`: single-file reads, single-target processes); changed → miss, entry refreshed/evicted. Multi-input results (dir searches) get class `advisory` + match-set fingerprint + short TTL — consumers see the class and treat staleness accordingly. Coarse-mtime filesystems fall back to size + cheap content hash under a size threshold. In-flight rows whose owner died (session file gone) are swept at rotation cadence. Writes need no proactive purge — a child's `files_changed` breaks fingerprints on next lookup; TTL + rotation (1000→500, history-style) handle hygiene.
- Validation verdict (cache-scout, first live data): **NO-GO on speccing §15 now.** Zero waves recorded through the new machinery (results inbox drained+compacted; history absent — see §11 skew note). Observed duplication (221 reads, 38 paths, 5 sessions via `.pi/read-ledger.jsonl`) is sequential-successor re-reading, not wave-parallel: 0 exact replays; 113 same-fingerprint re-reads wanted different windows (content reuse saves IO, not tokens); 70/183 re-reads had changed fingerprints (38% — lazy stat revalidation is mandatory, as pinned). Layer confirmed: extension layer owns the index (native layer is per-process, cold per spawn); native read ledger needs `parentSessionId` added (one Rust change) before wave attribution works. Go threshold: ≥3 waves × ≥2 enriched children (≥6 history rows), ≥1 same-wave duplicateRead event, ≥1 reader/writer overlap pair.

## 16. Permission-gate gaps (validated separately: gate dig, 2026-11-02)

Two-lane validation (session-audit of six child sessions + source trace). Source anchors: `extensions/permission-gate/index.ts:389-436` (approval ladder + subagent short-circuit), `:281-292` (approval state — in-memory closure, nothing persisted), `:918-940` (bash call site); `extensions/permission-gate/rules/destructive.ts:223-250` (segmentDestructive), `:169-173` (INTERP_INLINE — unanchored), `:254-283` (splitSegments — heredoc-unaware), `:75-81` (tripwire-by-design note). Context: children re-add the gate via `defaultExtraExtensions` (`extensions/subagents/index.ts:1511-1525`); `PI_SUBAGENT_NAME` short-circuits to fail-closed, no dialog.

- **16.1 Heredoc bodies scanned as commands (high).** splitSegments splits on newline/;/&&/|| without heredoc state, so every heredoc body line is tripwire-scanned as a command. Live evidence: three review children blocked on /tmp durability writes solely because their markdown bodies quoted interpreter-escape prose from the agent docs they reviewed. This blocks the durability-file pattern the entire 14-agent roster depends on. Fix direction: track heredoc state in splitSegments; body lines pass as prose (scan only the opener segment). **DONE (2026-11-01, reviewer-approved):** heredoc-aware splitSegments — arms at the next newline (same-line continuations stay scanned), `<<-` tab strip, `<<<` never arms, CRLF delimiter hardening added after review (one `\r` stripped per body line before the exact-tag compare); gate cases 352→364.
- **16.2 Asymmetric decision logging (medium).** Declines surface as isError toolResults; approvals leave no structured record — post-hoc audits cannot reconstruct what was allowed (observed: a main-session approved destructive run is unverifiable). Fix direction: one decision record per verdict (verdict, rule id, command hash) to the session log or a gate NDJSON log. **DONE (2026-11-01, reviewer-approved):** one NDJSON record per confirm-path verdict — `{ts, verdict, rule, commandHash}` (sha256, 16 hex; never raw command text) — appended to `<home>/logs/gate-decisions.ndjson`; all five verdict lanes, non-fatal try/catch, emit at decision time.
- **16.3 Tripwire false-positive tax on doc-reviewing children (low; moot if 16.1 lands).** Unanchored INTERP_INLINE matches quoted prose anywhere in the command string, including rg patterns (reproduced live four times across two child sessions). Fix direction: none required beyond 16.1; optionally scope the regex to unquoted or command-head regions. **SKIPPED — moot** once 16.1 landed (heredoc bodies pass as prose); the residual divergence is fail-safe-only (pure-LF tag vs `TAG\r` body line closes one line early, false-positive direction).

Also noted: a `.ts` suffix on the gate directory in `PI_SUBAGENT_EXTRA_EXTENSIONS` silently drops the gate from children (`subagents/index.ts:1511-1525` comment) — candidate for a load-time assertion. **DONE (2026-11-01):** `resolveExtraExtensions` in `extensions/subagents/index.ts` — loud per-spawn stderr warning on any dropped entry (missing default gate included), `.ts`/`.js`/`.mjs` self-heal to the parent directory when it exists; docstring records the accepted trade-off (parent-dir existence is not proof of a loadable extension).

Follow-ups from review (none blocking): harness-level fake HOME for all confirm-path suites (suites without one append ~350 real hashed records per full runner run); a comment fix in `logDecision` (mkdir runs per write, not on first write — idempotent no-op); pre-existing replay-leg metric pollution in `tests/tools/audit/replay.mjs` (all-"Pibash-first" counts, pre-dates this section).
