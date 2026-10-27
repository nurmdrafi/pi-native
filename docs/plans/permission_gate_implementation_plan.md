# Permission Gate — Validated Implementation Plan

Supersedes the design in `docs/plans/permission_gate_architecture_plan.md` (kept for the
record). Same goal — make the gate context-aware — different mechanism, because the original
assumes an architecture this repo does not have.

**Status (2026-10-27): implemented.** R11 (failure-loop escalation) and PH1 (phase label)
shipped; LG1's 3-error note was verified as already live; the Rust/mmap/telemetry design is
rejected on evidence. Verification: typecheck clean, `npm run gate:eval` 92/92 fixtures
(recovery 93%), `npm test` 235/235.

### Progress tracker

| Item | Source | Status |
|---|---|---|
| Rust core (`src/state.rs`, `gate.rs`, `hooks.rs`) | original §3 | rejected (V2, V3, V5) |
| mmap shared state | original §3A | rejected (V4, V5) |
| R11 failure-loop escalation | review §3A | **shipped** |
| LG1 3-error note | review §3B | verified pre-existing |
| PH1 phase label | original §3C | **shipped** |
| Telemetry sidecar + dashboard | original §5 | rejected (V11) |
| Cargo workspace consolidation | original §4 | rejected (V10, V14) |
| Binary/compressed context injection | follow-up | rejected (research, §8) |
| Test suite split by rule key | follow-up | **done** (one ~5,000-line file → runner + 17 modules) |
| Turn-state extraction (`rules/turn-state.ts`) | follow-up | **done** (§10) |

---

## 1. Verdict

**Reject the Rust core + mmap state + Axum dashboard. One TypeScript rule was worth building,
and it is now built on top of state the gate already tracks.**

Two of the three ideas in the original plan are unbuildable against the real harness, and the
third (telemetry) has no stated requirement. Its founding premise is also factually wrong: the
gate is **already stateful and context-aware**. `index.ts:178` holds per-session coverage,
alongside the pending read/edit/bash and search-hit maps; `index.ts:228` is the `TurnState`
value the temporal rules share; `index.ts:1298` and `:1329` reset them per compaction and
session start. Rules R1 (re-read), R1b (big read), R10 (re-run
within 10 min, `index.ts:157`), LG1 (loop guard, `config.ts:59`), and AG (anchor
certification) are all temporal. "Stateless, mechanic-only checker" describes no code here.

---

## 2. Validation findings

| # | Plan claim | Evidence | Outcome |
|---|---|---|---|
| V1 | Gate is stateless / mechanic-only | `index.ts:178` (coverage), `:228` (`TurnState`), `1298`/`1329` (resets), rules R1/R1b/R10/LG1/AG | **Invalid premise** |
| V2 | Implement `src/state.rs`, `src/gate.rs`, `src/hooks.rs` | no root `Cargo.toml`, no root `src/`; Rust lives in `custom-tools/Cargo.toml:13` (`pidx,piread,piedit,pibash`) | **Wrong path**; a second root workspace conflicts with `custom-tools` |
| V3 | Rust `ContextualGate::evaluate_intent` intercepts tool calls | interception is a TS hook, `index.ts:462`, returning `{block:true,reason}` (`index.ts:279`); the harness calls handlers, not binaries | **Unreachable** — `gate.rs` would be dead code without an addon/IPC bridge |
| V4 | 0 ms latency, "near memory bandwidth" | any bridge = per-call subprocess or N-API; JS cannot mmap without an addon, so the TS side pays `readFileSync` per call | **Slower** than the in-memory `Map`s it replaces |
| V5 | `#[repr(C)]` shared struct across processes | read via `&*(mmap.as_ptr() as *const SharedHarnessState)` with no atomics/volatile | **UB / data race** as specified |
| V6 | Byte-window failure inference | plan:149 `windows(10).any(|w| w == b"error[E0")` — the literal is 9 bytes against a 10-byte window | **Dead comparison** — it compiles and can never match; neighbours (`b"compiling "`, `b"running 0 "`, `b"FAILED"`) have correct lengths |
| V7 | `consecutive_failures` logic | plan:161 resets to 0 on the unconditional fall-through at the tail; increments per chunk, not per build | **Logic bug** — one failed build emits many matching chunks |
| V8 | Rule `target_path.contains("cargo test")` | plan:131 hardcodes one toolchain in a repo-agnostic harness | **Violates portability rule** (`AGENTS.md`), no-op for JS/Python |
| V9 | Block edits during "codebase discovery" | plan:126-127 blocks mutation in `AnalyzingCodebase` | **Fights the mandated locate→read→edit workflow**; high false-positive |
| V10 | New root Cargo workspace + `tools/env_check` | `custom-tools/Cargo.toml` already sets `panic="abort"`, LTO, `strip` | **Duplicate**; a member crate under `custom-tools/` is the fit |
| V11 | `axum` + `tokio` + dashboard on :9990 | every crate uses only `serde`/`serde_json` (+`sha1`, `unicode-normalization`) | **Dependency blow-up, no requirement** |
| V13 | "94% token savings", trailing medical disclaimer | plan:260, `263` | **Unsupported claim + pasted model boilerplate** |
| V14 | Consolidate helper scripts into Cargo | `scripts/` holds 3 shell scripts (`after-pull.sh`, `bootstrap.sh`, `progress-demo.sh`), 3 Node scripts (`agents-lint.mjs`, `doc-check.mjs`, `link-pi.mjs`), and `lib/` — native build/install is already `scripts/lib/install-native.sh` | **YAGNI** — and a Cargo workspace cannot host the Node half |
| V15 | `config.ts:36` "keep in sync with the README rule table" | `extensions/README.md` holds the catalog, and `tests/gate/config.test.mjs:399` fails any config key whose ID is absent from it | **Reference is valid** — correct as-is |
| V16 | Hooking inference into the pibash chunk loop informs the gate | gate runs pre-call; it sees tool output only as `tool_result` | **Wrong seam** — derive state in TS from `tool_result`, zero IPC |

Numbering: there is no V12 row — the table jumps V11 → V13. Fifteen findings are recorded,
so "V1–V16" overstates the count by one; the V12 slot is unaccounted for.

Note on V15: an earlier draft of this document claimed the README was missing. It is not —
the catalog lives at `extensions/README.md`, not inside `extensions/permission-gate/`, and a
test enforces the link. No documentation debt existed there.

---

## 3. What actually shipped

### A. R11 — failure-loop escalation (new)

Enforces the circling rule in `AGENTS.md`: when the same failure keeps recurring without a
landed change, the gate stops the retry and sends the model back to the user.

- `rules/turn-state.ts:24`: `FAILURE_LOOP_AT = 5`, plus the `lg1ErrMutSeq` snapshot taken
  when a streak begins. `index.ts:258` holds `failureLoopGate()`, called from the bash branch
  of the `tool_call` handler after malformed-input validation.
- It **shares LG1's counter** rather than adding a parallel one (one rule, one home), so the
  3-error note and the 5-error block cannot disagree.
- The escalation is disarmed by a mutation: if `mutationSeq` moved since the streak began, a
  fix landed and the call proceeds. That is what keeps red-green-refactor — edit, fail, edit,
  fail — from ever tripping it.
- Severity is a normal config key (`rules.failureLoopGuard`, default `error`), demotable to
  `warn`/`off` like every preference rule.
- Documented in the `index.ts` header table and the `extensions/README.md` rule catalog R11 row.

Tests, added to `tests/gate/runner.test.mjs`:

| Case | Expectation |
|---|---|
| 5 consecutive failures with no landed fix block the next shell call | blocked |
| TDD failures interleaved with landed edits never block | pass |
| 4 consecutive failures stay below the threshold | pass |

### B. LG1's 3-error note — verified pre-existing

`rules/turn-state.ts:130` counts consecutive tool errors and notes once at 3, resetting on success and
per turn. Verified empirically against the live panel, not just by reading: with `pibash`, the
note fires on the 3rd consecutive failing result and not before. No change was needed; R11 now
reuses its counter.

### C. PH1 — phase label (new, advisory)

`extensions/permission-gate/rules/phase.ts` holds a pure `nextPhase()` plus a toolchain-agnostic
`isVerifyCommand()`; `index.ts` feeds it from edit results and bash results, resets it per user
turn, and emits at most one note on entry into `recovering`.

- **Never blocks.** V9 still stands: phase-based blocking fights locate→read→edit, so severity
  only decides whether the note is emitted (`ruleEnabled`), never whether a call runs.
- **Does not displace the output cap.** Handlers compose last-wins, so a note returned for an
  oversized result would have replaced H1's truncation. The note is skipped whenever the result
  is already at H1's 40-line / 2 KB budget.
- Default `warn` (`rules.phaseNudge`), `off` disables it; documented in the `index.ts` header
  table and the `extensions/README.md` catalog.

Tests, added to `tests/gate/runner.test.mjs`:

| Case | Expectation |
|---|---|
| verify failure after an edit notes the phase once, never blocks | pass |
| a new user turn re-arms the phase note | pass |

---

## 4. Why the naive escalation stays rejected

"Block at N consecutive failures" without the mutation snapshot would fight the workflow
`AGENTS.md` mandates: red-green-refactor fails by design, and a large refactor can fail a suite
several times in a row. The shipped version narrows the trigger to *repeated failures with
nothing landed in between*, which is the observed circling pattern rather than ordinary
iteration. Threshold 5 sits above any healthy cycle.

---

## 5. Verification (measured 2026-10-27)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run gate:eval` | 92/92 fixtures, recovery 93% |
| `npm test` | 235/235 pass |
| New R11 cases | 3/3 pass, red before the implementation |
| New PH1 cases | 2/2 pass; caught a real regression — the note initially replaced H1's cap for oversized results, fixed by the budget guard |
| Test layout split | runner 59 lines + `tests/gate/cases-<ruleKey>.mjs`; 307/307 cases run, count unchanged, suite 235/235 |

Nothing outside `extensions/permission-gate/`, its test file, and the `extensions/README.md`
catalog row was touched. No dependency added, no binary built, no new process.

---

## 6. Estimates (planned vs actual)

| Work | Planned | Actual |
|---|---|---|
| Review + validation | ~1.5 h | ~1.5 h |
| R11 implementation + tests | 45-60 min | ~55 min |
| PH1 phase label + tests | 45 min | ~50 min |
| Docs (catalog rows, header table, plan) | ~15 min | ~20 min |
| Rust gate (rejected) | 4.5-8 h | not attempted |

## 7. Decisions

- **D1 closed.** TypeScript path; nothing to install.
- **D2 resolved.** Escalation built with the mutation gate (§3A); naive version rejected (§4).
- **D3 closed.** No telemetry sidecar — no requirement.
- **D4 closed.** No binary/compressed injection (§8).
- **D5 closed.** Implementation done; demote via `rules.failureLoopGuard` if it ever misfires.

---

## 8. Appendix — what the model actually consumes (research)

Question raised against the original plan's "binary/zero-allocation" framing: if the harness
moves bytes, why not inject only locally compressed binary into context? Traced the full
path, hop by hop.

| Hop | Format | Evidence |
|---|---|---|
| native tool → extension | one-line JSON envelope on stdout | `extensions/pibash/index.ts:294`, `custom-tools/piedit/src/envelope.rs:17` |
| extension → harness | `content: [{type:"text", text}]` | `extensions/pibash/index.ts:409,486` |
| harness → LLM message | `TextContent {type:"text", text}` / `ImageContent {type:"image", data, mimeType}` | `pi-ai/dist/types.d.ts:252-270`, `convertToLlm` in `pi-coding-agent/dist/core/messages.d.ts` |
| message → provider | JSON over HTTP; images base64 in the body | `pi-ai/dist/api/anthropic-messages.js:81-83` |
| provider transport | optional zstd of the whole JSON body | `pi-ai/dist/api/openai-codex-responses.js:122-135` |
| token accounting | computed from decoded text | `pi-ai/dist/utils/estimate.d.ts` (`estimateTextTokens`) |

**Conclusion.** The model consumes UTF-8 text tokens, plus base64 images that the server
decodes first. The precise claim is that there is no channel for **compressed text**: anything
the model must read is decoded and tokenized before it is billed, so a compressed payload either
arrives as unreadable bytes-turned-tokens or must be decompressed first. Binary media inputs do
exist (base64 images, PDFs, audio), but the server decodes them into model-side representations —
they are not a way to ship fewer tokens of text. None of the JSON hops above is on the model's
side of the wire, and compression is a transport optimisation the receiver reverses before
tokenisation: it changes bytes on the wire, never tokens in context.

Consequences:

1. Injecting compressed binary into context cannot reduce token cost. The text still has to
   be decompressed into readable tokens; if it is not, the model cannot use it at all. Binary
   media bill the same way — a letter-size PDF page prices as an image (~2.4K tokens), never
   as its byte count (OpenAI community answer, checked 2026-10-28).
2. Shaping the text is the only lever on **content** cost — which is what the gate already
   does: 40 lines / 2 KB output cap, head+tail read compaction with omission spans, pidx
   extract caps. What the prompt-compression literature calls "compression" is this same
   lever (drop or rewrite tokens), not byte-level packing: LLMLingua-style tools cut tokens by
   rewriting text, so they compete with the gate's caps rather than with zstd.
3. A second, independent lever is **prompt caching**: a cache hit bills at 10% of the standard
   input price, a 5-minute write at 1.25x (`docs.anthropic.com` pricing, checked 2026-10-28),
   so a stable reused prefix can beat a shorter one that keeps changing. The gate is
   compatible — notes ride `tool_result` and never rewrite earlier content — but a future rule
   that did rewrite the prefix would trade cache hits for tokens and has to measure both.
4. Local Rust→TS byte cost is already minimised (`accumulator.rs`, spill-to-file) and sits
   orders of magnitude below model latency; a compression round-trip there adds a
   decompression step to save microseconds.
4. This is why the Rust/mmap/binary layer stays out of scope: it optimises a hop that is
   neither the bottleneck nor able to influence what the model sees.

## 9. Appendix — toolchain cost and where Rust actually pays (measured 2026-10-27)

### What is already installed

| Piece | State |
|---|---|
| Node | v24.21.0, pinned by `.nvmrc` (`24`) |
| Rust | `cargo`/`rustc` 1.96.0 at `~/.cargo/bin`, warm `custom-tools/target` (922 MB) |
| `memmap2` | cached (`~/.cargo/registry/cache/.../memmap2-0.9.11.crate`) |
| `axum`, `tokio`, `hyper`, `tower` | **not cached** — telemetry would pull ~40 crates over the network |
| `napi-rs` / `node-gyp` | **not installed** — a Rust↔Node addon needs a new JS dependency chain |

The TS path installs nothing. The Rust path needs nothing for a subprocess bridge, an addon
toolchain for an in-process bridge, and a large crate download for the telemetry sidecar.

### Measured inner loops

| Loop | Command | Time |
|---|---|---|
| gate rules test | `node --test tests/gate/runner.test.mjs` | 2.99 s |
| full suite | `npm test` | ~22 s (235 tests) |
| typecheck | `npm run typecheck` | 5.07 s |
| Rust check | `cargo check -p piread --offline` (warm) | 1.12 s |

Both toolchains iterate in seconds, so neither language is the bottleneck — the work is
specifying behaviour and tuning false positives, not compute.

### Which path costs more time

| Path | Install | Build work | Total | Confidence |
|---|---|---|---|---|
| TS rules (shipped) | none | 2 phases, existing stub harness | 2-2.5 h | medium |
| Rust gate, subprocess bridge | none | bridge + serialization + port rules + parity | 4.5-6 h | medium-low |
| Rust gate, N-API addon | `napi-rs`/`node-gyp` | addon build, per-platform binary, ABI pinning | 6-8 h | low |

Rust is 2-3x slower here for one structural reason: the gate's entry point is a TypeScript
hook (`index.ts:462`). Rust cannot move that seam, so a bridge is paid *in addition* to the
rules, not instead of them.

### Where Rust does pay, if a byte-heavy need appears

One hybrid, and the only one that respects the seam: let an **existing** `custom-tools/`
crate compute a small result and hand it back as a few bytes of text in the envelope's
`details` field, which the extension already reads. No addon, no IPC protocol, no second
workspace, warm `cargo check` at 1.1 s. Example: if failure fingerprints ever need to scan
large stdout, `pibash` can classify it in Rust and emit `details.build = {failed: true}`.
That is a ~1.5 h change and still slower than the TS equivalent — a fallback for scale, not
a speed-up for this task.

---

## 10. Loop-state extraction (2026-10-28)

`index.ts` held the temporal rules as closures over ~13 `let`/`Map` bindings scattered through
one factory, and `mutationSeq` was declared *below* the helper that read it. R10, EB, LG1, R11,
PH1 and CN now share one `TurnState` value (`rules/turn-state.ts`): every transition is a
function of that value, so a new temporal rule reads what it needs from an argument instead of
from the enclosing scope. `mutationSeq` is the shared clock — R10, EB and R11 all ask "did
anything land", so one counter answers all three and they cannot disagree.

- `index.ts` 1570 → 1501 lines. Rule bodies and their message strings moved verbatim; the only
textual change is `${lg1ErrStreak}` → `${turn.lg1ErrStreak}`, identical when rendered.
- `lg1Reset` stays in `index.ts` as a 4-line wrapper: it also clears the AG miss ledger, which
is not turn state.
- The remaining ~23 bindings (coverage, pending reads/edits/bash, search hits, destructive
approval) are untouched — they belong to rules that are not turn-scoped, and each would need
its own seam.
- Verified: 307/307 gate cases, `npm test` 235/235, `gate:eval` 92/92 (recovery 93%, commands
6427), typecheck clean, `doc:check` unchanged (1 pre-existing `rg --max-age` finding). Gate
suite 1.80 s vs 1.86 s before — within noise; the refactor buys legibility, not speed.

### Measured cost (2026-10-28, Node 24.21.0, stub harness, 20k calls)

| Path | mean | p50 | p95 | p99 | retained |
|---|---|---|---|---|---|
| `pibash` pass path | 96 µs | 81 µs | 161 µs | 212 µs | 140 B/call |
| `pibash` pass, 8 distinct commands | 88 µs | 77 µs | — | 183 µs | 10.7 B/call |
| `piread` pass path | 87 µs | 73 µs | 119 µs | 328 µs | 43 B/call |

Two readings matter. Memory follows **distinct commands**, not call count: the 140 B/call in
the first row is `lastBashRun` (`rules/turn-state.ts:44`) holding one entry per unique base
command, not a per-call leak — the same 20k calls over 8 commands retain ~11 B. And the spawn
baseline for the rejected bridge: 100 invocations of the existing `piread` binary took 0.136 s,
i.e. **1.36 ms per spawn**, 14x the whole in-process pass before any JSON serialisation or rule
evaluation.

Behaviour was verified by driving the gate directly, not only by the suite: 5 failures with
nothing landed block the next call (R11); the same streak with one landed mutation in between
passes; a verify failure after an edit notes `recovering` (PH1); 3 consecutive errors note once
(LG1). The gate's share of `gate:eval` wall is 6427 × 96 µs ≈ 0.62 s of 5.0 s (~12%) — an upper
bound, since the fixtures are deliberately block-heavy.

---

## 11. Where the gap actually is (session-log measurement, 2026-10-27)

Goal under test: does a stateful gate reduce the wasted calls between tool calls, and is the
remaining friction a session-understanding problem or a per-call one? Method: every session log
in this repo (223 sessions, 16,408 completed tool calls), walked in order, with blocks detected
by the family prefix of the result text. Read-only; no gate change.

| Measure | Value |
|---|---|
| Repeat call, identical params, nothing landed since | 70 (0.4%) |
| Calls issued while a failure streak is open | 1,054 (6.4%) |
| …of those, inside a streak of 5+ (R11's trigger) | **4** (0.02%) |
| Calls between a failure and the next landed change | p50 1, p90 2, max 6 |
| Gate blocks | 609 (3.7%) |

Blocks split: Anchor Guard 344, Token Economy 185, Search 56, Permission Gate 20. Repeats are
counted on pidx's exact param hash (`ph`), so only identical parameters qualify: 70 calls, 0.4%.
An earlier draft of this section reported 399 (2.4%) from a lossy signature (tool + path + edit
count) that conflated different edits to the same file; the hash-based count supersedes it.

Both figures are now reproducible rather than thrown away: `pidx` emits `results[].blk` (gate
family) and `tests/tools/audit/gate-metrics.mjs` prints this table from its extract. Parsing all
507 sessions takes 675 ms.

Anchor Guard blocks audited individually (346 blocks): 189 (55%) are **unread** anchors — the
model edited lines the session had never read; 98 (28%) are byte mismatches (exact + fuzzy both
failed); 3 overlap; 56 other phrasings. Recovery: 280 (81%) fixed on the very next attempt, 43
on the second, 16 needed three or more, 7 never within five. **Zero verbatim re-sends**, so the
hint is being read rather than retried blindly. Cost: 1.21 extra calls per block, ~419 calls,
~2.6% of all calls.

Conclusions, in the order the data forces them:

1. **R11 is a backstop, not a gap closer.** Its threshold was reached by 4 calls in 16,408. It
   costs one counter and cannot regress anything, so it stays — but no further investment in
   failure-chain inference is justified by this data.
2. **Failure chains are short.** p90 is 2 calls between a failure and the next landed change,
   worst case 6 — there is no long chain for a chain model to reason over.
3. **The dominant friction is read-before-edit, not session comprehension.** 55% of Anchor
   Guard blocks are edits to never-read lines. The gate already names that contract and the
   session state already answers it (`coverage`, `index.ts:178`); the missing piece is on the
   model's side, not the gate's.
4. **The stateful layer does fire in real use** — LG1 tripped during this analysis on a file
   edited four times in one turn, which is the intended within-session behaviour.

Caveats: logs span several months and gate versions, `codemode` repeats come from experiment
runs, and block detection is a prefix heuristic rather than a harness signal.

### What the gate itself costs (same corpus, 261 sessions)

| Measure | Value |
|---|---|
| Billed input tokens | 1.26 B (~$204 at the blended rate) |
| Gate-injected text: 611 blocks + 82 notes | 180 K chars ≈ 45 K tokens |
| Share of billed input | **0.0036%** |
| Per block, reason text | ~74 tokens (260 chars average) |
| Handler cost, in-process | 96 µs mean, 81 µs p50 per call |
| Extra calls caused per block | 1.21 |

So the reason text is free in token terms, and the handler is free in wall-clock terms: 96 µs
against ~82 K billed input tokens and seconds of model latency per turn. The real price of a
block is the retry turn it causes. At 1.21 extra calls per block that is ~61 M tokens, ~4.8%
of billed input, **if** every block replaced an otherwise-successful call — which is not the
case: 98 of the 346 Anchor Guard blocks were byte mismatches the edit tool would have rejected
anyway. The attributable share is the 144 unread-but-exact blocks, ~12 M tokens, **~0.9%**.

The gate adds no I/O: it runs in-process on event objects the handler already holds, and the
only filesystem touches on the hot path are the anchor checks that the edit tool performs
regardless. There is no mmap file, no subprocess and no shared-memory hop to measure.

---

## 12. AG2 relaxation — decided: observe first (2026-10-27)

Decision: **do not flip the `editRegionGuard` default yet.** Watch real sessions on the current
gate for a few days, then decide on the criteria below.

What this leaves in the tree today (all behaviour-neutral at `error`):

- AG2 now honours its configured severity. It previously blocked at `warn` too, because the
decision bypassed `enforce` — a contract bug, not a design choice.
- `validateEditAnchors` tags each block with the rule that owns it (`editAnchorGuard` hard vs
  `editRegionGuard` relaxable), so severity is applied per rule rather than to the whole family.
- `tests/gate/region-warn.test.mjs` proves the relaxed rung: outside-window anchor passes at
  `warn`, never-read path still blocks, non-matching anchor still blocks. 3/3 green.
- Default in `config.json` is unchanged: `editRegionGuard: "error"`.

Why relax at all (from §11): AG2 owned 144 of 346 anchor blocks (42%), about 0.9% of billed
input, and the removed property is the weakest of the set — the bytes still have to match the
file exactly, so an AG2 pass cannot apply an edit the file does not contain. It also matches
the Claude-Code parity rung already documented for `off`.

Why wait: §11 measured **old** sessions, recorded across many gate versions and before the
stateful rules shipped. Sessions from 2026-10-27 onward are the first to contain R11, PH1 and
the extraction. Relaxing a safety rule on a retrospective corpus is a guess.

Watch criteria — flip only if all three hold over at least three days of post-2026-10-27
sessions:

1. AG2 still owns ≥30% of anchor blocks (if R11/PH1 changed the mix, the premise is gone).
2. The edit-apply error rate does not rise: the share of `piedit`/`edit` results with
   `isError` stays within one point of the §11 baseline.
3. Three randomly sampled AG2 blocks are reviewed by hand and every one has anchor bytes that
   exist in the file at that line — i.e. the block was about context, never about content.

Flip procedure: `PGATE_EDIT_REGION_GUARD=warn` for a single trial session (no file change), or
`"editRegionGuard": "warn"` in `config.json` to make it the default. Revert is the same line.

Measurement tooling: the three analyses behind §11 (§gap, AG audit, token cost) live in `/tmp`
and should not. Per the reusable-script rule, the right home is the existing Rust `pidx` crate —
it already parses these session files — emitting a metrics summary, with a thin caller in
`tests/tools/audit/`. That keeps one parser, not three.

---

## 13. doc-check → Rust: approved conversion plan (2026-10-27)

Scope: `scripts/doc-check.mjs` (556 lines, four families) becomes `custom-tools/docheck`, called
by `npm run doc:check`.

Recorded as an **owner decision**, not a precedent: measured 3.4 s over 688 markdown files, it
clears the "byte-heavy per call" bar but fails the other two (not hot, does not need to run
without Node). The rule in `AGENTS.md` still says such a script belongs in `tests/tools/`.

Staging — each stage keeps the tree green because the npm script stays on Node until parity:

1. **Families 3, 4, 2** — extensions-inventory (`402-461`), env-vars (`462-513`),
   skills-inventory (`352-401`). Directory walks plus README/`SKILL.md` regex; no process spawns.
   ~160 JS lines total, the mechanical third.
2. **Family 1 — md-commands** (`77-351`), the bulk: `sh -n` syntax probes, binary existence on
   `PATH`, script-path checks, and `--help` parsing including subcommand form
   (`[sub, '--help']`), plus the curated false-positive allowlist at `284-323` (curl's
   `--help all`, `git reset --hard` in prose, the universal `--help` skip). 275 JS lines and the
   only part where parity will need iteration.
3. **Aggregation** (`514-556`): identical stdout, including the four `(info, N)` groups and the
   `summary: N/4 families failed, M finding(s)` line, identical exit code.

Acceptance: `node scripts/doc-check.mjs > a.txt`, `docheck > b.txt`, `diff` clean on the same
working tree, over all 688 files; runtime under 0.5 s.

Wiring: `install_native custom-tools/target/release/docheck ~/.pi/agent/bin/docheck`, then switch
`npm run doc:check` to the binary **in the same change** that deletes `scripts/doc-check.mjs` —
one implementation, per the tooling rule. No new dependencies: output is text, and the walker and
spawn patterns already exist in the workspace.

Status (2026-10-27): **stage 1 done**. `custom-tools/docheck` implements families 2, 3 and 4
std-only (no dependencies), with unit tests for the two hand-rolled parsers (`table_cells`,
`scan_env_vars`). Parity verified byte-for-byte against the JS on this tree:

```
node scripts/doc-check.mjs | rg -A999 "^SKILLS INVENTORY" | rg -v "^summary:" > /tmp/n3.txt
custom-tools/target/release/docheck . | rg -v "^summary:" > /tmp/r3.txt
diff /tmp/n3.txt /tmp/r3.txt   # clean
```

Runtime for the three families: 20 ms. The npm script still runs the JS, so nothing is
half-wired. Stage 2 (family 1, md-commands: markdown shell validation and `--help` probing) and
stage 3 (aggregation parity, then the npm switch plus deleting the JS) remain.

### Stage 2 porting inventory (family 1, JS 77-351)

Collected while reading the JS, so the port starts from a map instead of a re-read. Every item
below changes observable output and must be reproduced exactly:

- **Sets:** `SHELL_LANGS` (sh/bash/shell/console/zsh), `BUILTINS` (~55 shell builtins),
  `INTERPRETERS` (node/npm/npx/python/python3/bash/sh/env/deno/bun — their flags belong to the
  script, not the binary), `MAC_ONLY` (pbcopy, open, brew, xcodebuild, …), `SOURCED` (nvm),
  plus the optional-toolchain and artifact-exception lists at `97-117` and `284-323`.
- **`binExists`:** PATH walk, `statSync().isFile()` then `accessSync(X_OK)`, memoised in
  `binCache`. A non-executable file on PATH does not count.
- **`helpFlags`:** key is `"bin"` or `"bin sub"`; args are `[sub, '--help']` when a subcommand is
  present. Probe with `15000`, retry once at `45000`; **`null` result means unresolved** and the
  caller must report a probe failure, never `FLAG NOT IN HELP` (that bug is in `docs/backlog.md`).
  Strip man-page overstrike (`.\x08` pairs) before extracting `--flag` tokens with
  `/--?[a-zA-Z][a-zA-Z0-9-]*/`.
- **`splitSegments`:** quote-aware split on `||`, `&&`, `|`, `;` (two-char operators first).
- **`stripAssignments`:** leading `VAR=value` with quote and paren depth counting; returns null on
  an unterminated `$(` so the caller can bail instead of mis-parsing.
- **`headTok`:** strip a leading `$`/`#`/`>`, reject shell punctuation and `key=value` shapes,
  drop `BUILTINS`, trim trailing `;'"`.
- **`subCmd`:** second whitespace token, must match `^[a-z][a-z0-9-]*$` and not start with `-`.
- **Fenced blocks:** `/```([a-zA-Z0-9]*)\n([\s\S]*?)```/g`; only shell langs are analysed.
  `<placeholder>` tokens are quoted before `bash -n` (documented waiver). A syntax failure records
  `<relpath> :: <first non-blank line, 60 chars>`.
- **Line preparation:** strip comments outside quotes, join backslash continuations.
- **Buckets → output:** `syntaxFail`, `binFail`, `macOnlyRefs`, `scriptMissing`, `flagFail`,
  `onDemandRefs`, `optionalToolchainRefs`, `artifactRefs`, `unresolvedProbes`; the latter three
  become the `(info, N)` groups and must preserve first-seen order.
- **Stats line:** `md files scanned: <N>` and `binaries OK: <space-joined, sorted>` (the JS
  sorts `binSeen`; only the four info buckets keep first-seen order).

Stage 3 then needs `renderHuman`'s exact spacing: label line, two-space stats, two-space
`(info, N)` headers, four-space items, two-space findings, one blank line per family, and the
`summary:` line.

**Status (2026-10-27): stages 2 and 3 done.** `custom-tools/docheck` implements all four
families; `npm run doc:check` runs `~/.pi/agent/bin/docheck` (installed via `install_native`),
and `scripts/doc-check.mjs` is deleted — one implementation. Parity was proven before the
switch: `node scripts/doc-check.mjs` vs `docheck` diffed byte-clean on human output and on
`--json` over all 688 files, exit codes included; `tests/unit/doc-check.test.mjs` now spawns the
installed binary (`DOCHECK_BIN` overrides) against the same fixtures.

What the parity iterations revealed:

- **libuv sorts `readdirSync`** (`uv__fs_scandir` qsorts dirents); Rust `read_dir` yields raw
  OS order. All docheck walkers sort entries by name bytes; without this the optional-toolchain
  bucket held the same 96 entries in a different sequence (`skills/rust-skills/references/`).
  Stage 1 carried this latent — its parity passed only because those families' findings were
  order-insensitive on the real tree.
- **Stage 1 had a missing FAIL path**: the skills derived-side loop ("skills/X/ has SKILL.md but
  the table has no row") was never ported; repo parity never saw it because the real table is
  complete. The fixture tests caught it; the fix restores the loop ahead of the row-side
  findings, in JS order.
- **Probe quirks**: none survived — overstrike stripping, the subcommand `[sub, '--help']` form,
  and the 15 s → 45 s retry behaved identically. Runtime is probe-bound: 3.1 s Rust vs 3.4 s
  JS over the same tree; the 0.5 s acceptance above was optimistic (`--help` spawns dominate).
- Two dead scripts left with the swap: `scripts/session-audit.py` (superseded by the
  session-audit skill's own `scripts/`) and `scripts/progress-demo.sh` (unwired demo).
