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

---

## 1. Verdict

**Reject the Rust core + mmap state + Axum dashboard. One TypeScript rule was worth building,
and it is now built on top of state the gate already tracks.**

Two of the three ideas in the original plan are unbuildable against the real harness, and the
third (telemetry) has no stated requirement. Its founding premise is also factually wrong: the
gate is **already stateful and context-aware**. `extensions/permission-gate/index.ts:166-204`
holds per-session coverage, pending reads/edits/bash, bash run history, and search-hit sets;
`index.ts:1334-1345` resets them per session. Rules R1 (re-read), R1b (big read), R10 (re-run
within 10 min, `index.ts:144-146`), LG1 (loop guard, `config.ts:59`), and AG (anchor
certification) are all temporal. "Stateless, mechanic-only checker" describes no code here.

---

## 2. Validation findings

| # | Plan claim | Evidence | Outcome |
|---|---|---|---|
| V1 | Gate is stateless / mechanic-only | `index.ts:166-204`, `1334-1345`, rules R1/R1b/R10/LG1/AG | **Invalid premise** |
| V2 | Implement `src/state.rs`, `src/gate.rs`, `src/hooks.rs` | no root `Cargo.toml`, no root `src/`; Rust lives in `custom-tools/Cargo.toml:13` (`pidx,piread,piedit,pibash`) | **Wrong path**; a second root workspace conflicts with `custom-tools` |
| V3 | Rust `ContextualGate::evaluate_intent` intercepts tool calls | interception is a TS hook, `index.ts:483`, returning `{block:true,reason}` (`index.ts:303-308`); the harness calls handlers, not binaries | **Unreachable** — `gate.rs` would be dead code without an addon/IPC bridge |
| V4 | 0 ms latency, "near memory bandwidth" | any bridge = per-call subprocess or N-API; JS cannot mmap without an addon, so the TS side pays `readFileSync` per call | **Slower** than the in-memory `Map`s it replaces |
| V5 | `#[repr(C)]` shared struct across processes | read via `&*(mmap.as_ptr() as *const SharedHarnessState)` with no atomics/volatile | **UB / data race** as specified |
| V6 | Byte-window failure inference | plan:143 `windows(10) == b"error[E0"` compares a 10-byte slice to an 8-byte literal | **Does not compile** |
| V7 | `consecutive_failures` logic | plan:155-156 resets to 0 unconditionally at the tail; increments per chunk, not per build | **Logic bug** — one failed build emits many matching chunks |
| V8 | Rule `target_path.contains("cargo test")` | plan:125 hardcodes one toolchain in a repo-agnostic harness | **Violates portability rule** (`AGENTS.md`), no-op for JS/Python |
| V9 | Block edits during "codebase discovery" | plan:120-121 blocks mutation in `AnalyzingCodebase` | **Fights the mandated locate→read→edit workflow**; high false-positive |
| V10 | New root Cargo workspace + `tools/env_check` | `custom-tools/Cargo.toml` already sets `panic="abort"`, LTO, `strip` | **Duplicate**; a member crate under `custom-tools/` is the fit |
| V11 | `axum` + `tokio` + dashboard on :9990 | every crate uses only `serde`/`serde_json` (+`sha1`, `unicode-normalization`) | **Dependency blow-up, no requirement** |
| V13 | "94% token savings", trailing medical disclaimer | plan:254, `257` | **Unsupported claim + pasted model boilerplate** |
| V14 | Consolidate helper scripts into Cargo | `scripts/` holds 2 shell scripts + `lib/install-native.sh`; native build/install already handled by `scripts/lib/install-native.sh` | **YAGNI** |
| V15 | `config.ts:36` "keep in sync with the README rule table" | `extensions/README.md` holds the catalog, and `tests/gate/config.test.mjs:399` fails any config key whose ID is absent from it | **Reference is valid** — correct as-is |
| V16 | Hooking inference into the pibash chunk loop informs the gate | gate runs pre-call; it sees tool output only as `tool_result` | **Wrong seam** — derive state in TS from `tool_result`, zero IPC |

Note on V15: an earlier draft of this document claimed the README was missing. It is not —
the catalog lives at `extensions/README.md`, not inside `extensions/permission-gate/`, and a
test enforces the link. No documentation debt existed there.

---

## 3. What actually shipped

### A. R11 — failure-loop escalation (new)

Enforces the circling rule in `AGENTS.md`: when the same failure keeps recurring without a
landed change, the gate stops the retry and sends the model back to the user.

- `extensions/permission-gate/index.ts`: `FAILURE_LOOP_AT = 5`, a `lg1ErrMutSeq` snapshot taken
  when a streak begins, and `failureLoopGate()`, called from the bash branch of the `tool_call`
  handler after malformed-input validation.
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

`index.ts:277-290` counts consecutive tool errors and notes once at 3, resetting on success and
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
decodes first. There is no binary input channel, and none of the JSON hops above is on the
model's side of the wire. Compression is a transport optimisation that the receiving server
reverses before tokenisation, so it changes bytes on the wire, never tokens in context.

Consequences:

1. Injecting compressed binary into context cannot reduce token cost. The text still has to
   be decompressed into readable tokens; if it is not, the model cannot use it at all.
2. The only lever on token cost is shaping the text before it enters context — which is what
   the gate already does: 40 lines / 2 KB output cap, head+tail read compaction with omission
   spans, pidx extract caps.
3. Local Rust→TS byte cost is already minimised (`accumulator.rs`, spill-to-file) and sits
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
hook (`index.ts:483`). Rust cannot move that seam, so a bridge is paid *in addition* to the
rules, not instead of them.

### Where Rust does pay, if a byte-heavy need appears

One hybrid, and the only one that respects the seam: let an **existing** `custom-tools/`
crate compute a small result and hand it back as a few bytes of text in the envelope's
`details` field, which the extension already reads. No addon, no IPC protocol, no second
workspace, warm `cargo check` at 1.1 s. Example: if failure fingerprints ever need to scan
large stdout, `pibash` can classify it in Rust and emit `details.build = {failed: true}`.
That is a ~1.5 h change and still slower than the TS equivalent — a fallback for scale, not
a speed-up for this task.
