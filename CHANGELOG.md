# Changelog

All notable changes to this project will be documented in this file.
Entries live ONLY in versioned sections below this header — never add freeform
dated entries above it.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.47.0] - 18-10-2026

### Changed

- **`doc:check` is deterministic and 6× faster.** The `--help` probe folded a timeout/ENOENT/empty-stdout into the same empty flag set as a genuinely absent flag, so `npm run doc:check` intermittently reported `FLAG NOT IN HELP: pidx --out` (and `pi --extension`/`--session`) for flags that ARE in `--help`. The `catch` treated a dead probe as a verdict. `helpFlags` now returns an unresolved sentinel, never caches a failed probe, and retries once at 45 s; an unresolved probe is its own finding class (`HELP PROBE UNRESOLVED`), never a missing flag. Separately, the per-token `bash -c command -v` fork (two call sites, hundreds of spawns per run) is replaced by an in-process `$PATH` walk using `statSync` + `accessSync(X_OK)` and `path.delimiter`, so macOS and Linux both work: 45 s → 7.9 s.
- **`doc:check`: a brace group after `||` is no longer a binary.** `cmd || { echo …; exit 1; }` splits on `||` into a segment `}`, which `headTok` did not reject as shell syntax, so it reported `BINARY NOT FOUND: }`. Surfaced only once the flakiness was gone.

### Added

- **permission-gate R1c (locate-first).** A read window of ≥100 lines on a path that no `rg`/`grep`/`fd`/`find` command named this session, and that has no prior coverage, is blocked with the search to run. Deliberately narrow: a first attempt at blocking *every* unsearched window broke 22 legitimate cases (`P1: piread of a text file`, CRLF handling, targeted anchor reads, resume hydration) and was reverted, because the gate cannot tell a blind guess from a correct targeted read. Thresholds at or below 100 re-broke the narrow-window cases; 100 is the first width that leaves them passing. Pinned by four cases in `tests/permission-gate.test.mjs`.

### Fixed

- **`piread`: a document that quotes the omission marker was never compacted.** The already-compacted test was `text.contains(OMISSION_TAG)`, so any file mentioning `[... omitted N chars / M lines ...]` was exempted — including `docs/custom-tools-architecture.md`, which shipped 28,890 chars into context on every read. The marker is the only record that a cut happened, so the check now requires it to be a whole line of its own (`has_omission_marker`); quoting it mid-sentence, as documentation does, no longer exempts. Same file now reads at 1,828 chars (27,107 omitted). Pinned by `a_document_that_merely_quotes_the_marker_is_still_compacted` and `a_marker_inside_a_sentence_is_not_a_cut`; the idempotency test still passes.

- **Anchor Guard's not-found hint printed an edge, not a count.** `findClosestFragment` returns `{lines, end}` where `end` is `"head"|"tail"`, but the reason interpolated `${frag.end} lines`, producing "Its head lines occur at line N" — a dead end in the one message meant to unblock the edit. It now reads "Its first/last N line(s) occur at line M". Logged 3× in a single session.
- **permission-gate R1: a head-tail compacted read certified the elided middle as in-context.** `piread`'s compaction puts only a head and tail window in context and marks the rest with `[... omitted N chars / M lines ...]`, but the coverage certifier keyed on the request (`offset` unset → `win.end === Infinity`) and recorded `{1, Infinity}` for the whole path. The omitted middle therefore stayed unreadable for the rest of the session — `piread` refused the window with "already in context" while the bytes were never there. Certification now inspects `details.compaction` and treats `strategy !== "none" && omittedChars > 0` as not-whole-file, so the elided range stays readable. Pinned by two cases in `tests/permission-gate.test.mjs` (both fail with the `!elided` guard removed).
- **`tests/permission-gate.test.mjs`: `readVia` dropped `details.compaction`.** The helper forwarded only `truncation`, so no test could express a compacted read. It now passes `compaction` through when the case supplies one.
- **`sync-agent-bin`: a stale PATH pin silently shadowed the live one.** The rc block guard (`hasPathPin`) only asked whether the live dir was pinned somewhere; it never asked whether the *earlier* pins still pointed at anything. Bench runs had appended sandbox pins, two for `~/.pi/agent/bench/**` directories that no longer existed, and every one sat above `~/.pi/agent/bin` — so `rg` and `piread` resolved to a sandbox slot instead of the agent build. `pinnedBinDirs` / `missingPinnedDirs` now read the pins back out of the rc and `sync --check` reports each missing dir. The scan is a pure text match (never invokes a shell), handles both quote shapes the block can emit, and is pinned by an OS/shell-agnostic test case.

### Changed

- **AGENTS.md Workflow: locate before read.** `rg -n` first, then a range read on a hit; backed by R1c for wide windows.
- **AGENTS.md Safety + SYSTEM.md: blocks route.** One line: do the named step, retry once. SYSTEM.md adds a 3-step lookup order and a per-family recovery list (R1, Anchor Guard, Toolchain, R10).

## [1.46.0] - 17-10-2026

### Added

- **`piread`: head-tail context compaction, on by default (`custom-tools/piread/src/compress.rs`).** The read tool mirrored the built-in `read`'s plain head truncation, so an oversized read still shipped ~9 KB of raw text into the model context — the tail (final state, summary) was never seen and the head was emitted in full. A new deterministic compactor reduces a body over the model-visible budget (40 lines / 2 KB, matching the permission-gate H1 cap) to a 2/3 head : 1/3 tail window with an explicit `[... omitted N chars / M lines ...]` marker — the same marker string `pibash` already emits, so one grep recognizes a compacted result from either tool. Idempotent (a body already carrying the marker is never re-compacted), UTF-8-boundary safe, and bounded by a marker-reserve so the omission count cannot push the result back over budget. Measured on `npm run bench:model-visible`: a ~1922-line read drops 51,188 B → 2,040 B (−96.0%); suite totals 273,312 B → 15,569 B (−94.3%).
- **`piread`: `PI_READ_COMPRESS` switch.** Compaction is on by default; `0` / `false` / `off` restores byte-for-byte parity with the built-in `read`, which the parity suite and `piedit`'s exact-match binding both rely on. Parsed by a pure `parse_compression_switch()` so tests never mutate process-global env (Rust tests run in parallel and a `set_var` in one races every other).
- **`piread`: `read_text_compacted()`.** `read_text` stays a pure, byte-exact pipeline; the CLI and `--serve` call the compacting wrapper. Keeps the parity suite deterministic and confines env-dependent behaviour to one entry point.
- **Process-group isolation for all three daemons (`custom-tools/*/src/procgroup.rs`).** `--serve` previously inherited the client's process group, so any group-wide signal — `pibash`'s own `kill_tree` signalling `-<pid>` on a command timeout, job control, a CI timeout — took the daemon down with the client, dropping in-flight requests and forcing a reconnect. Each daemon now calls `setpgid(0, 0)` at startup. Deliberately **not** `setsid`: that fails with `EPERM` when the caller is already a process-group leader (how Electron/Node spawn children) and also drops the controlling terminal a stdio daemon never uses. `setpgid` is POSIX.1 (glibc, musl, Apple libSystem) and is declared as a raw `extern "C"` symbol, so no `libc` dependency is added; non-unix compiles to a no-op.
- **`PI_READ_BIN` / `PI_EDIT_BIN` / `PI_BASH_BIN` / `PI_PIDX_BIN` binary-path overrides.** Only `PI_READ_BIN` existed; the others let the parity suites point an extension at a throwaway binary and support non-standard installs.
- **`docs/custom-tools-architecture.md` expanded (214 → 631 lines).** Adds the workspace/release-profile rationale, the daemon wire protocol and ref/unref lifecycle rules, process-group isolation, context-shaping rules, envelope serialization (SWAR escaping, duplicate suppression), per-tool implementation detail (streaming parsers, `FuzzyView`, the `pidx` store byte layout), a shared-techniques table, and a glossary — concrete identifiers throughout so the file indexes the source rather than summarizing it.
- **`docs/backlog.md`** — open work for the next pass, with the `seq 50000` regression analysis (and why it costs zero model tokens), the non-deterministic `doc:check` gate, and the pre-existing S4/S5 protected-path failures.
- **New regression suites:** `tests/daemon-exit.test.mjs` (a host that used a daemon must still exit), `tests/daemon-process-group.test.mjs` (each daemon owns its pgid), `tests/piread-daemon-settle.test.mjs` (a request whose daemon dies mid-flight must settle), `tests/pidoc-portability.test.mjs` (the health check must not assume `/bin/sh`).

### Fixed

- **`piread` / `piedit`: event loop drained mid-await, hanging the host (exit 13).** Both extensions unref the daemon's `proc`/`stdin`/`stdout` so an idle daemon never pins the loop, but `daemonRequest` re-referred only `stdin` and `stdout`. With `proc` unref'd the loop could drain with a request outstanding; Node then exited with an *unsettled top-level await*. `refWhilePending()` now refs all three, restoring the intended invariant. Surfaced as an intermittent `piread-parity` cross-rung failure whose stall point moved between runs; `tests/piread-parity.test.mjs` is now 155/155, three consecutive runs.
- **`piread` / `piedit`: host never exited after a daemon call (`model-visible-baseline.mjs` hung after printing its report).** The inverse of the above: `maybeUnrefStreams()` unref'd the pipes but never the `proc` handle that `refWhilePending` had ref'd, leaving the `ChildProcess` referenced and pinning the host's event loop for the life of the process. Pinned by `tests/daemon-exit.test.mjs`, which fails (20 s timeout) with the one-line fix removed.
- **`piread`: duplicated continuation notice under compaction.** The `[Showing lines A-B of C …]` notice was sliced as body content and then re-appended, so it landed twice and buried the only signal that the file continues. It is now split off before slicing and re-attached exactly once, last.
- **`piread`: single over-budget line exceeded the byte budget.** A line larger than the whole budget produced both a head and a tail slice that together broke the cap. Such a line is now served by the head alone — a head+tail slice of one line is useless to a reader.
- **`skills/pidoc/scripts/pidoc.mjs` hardcoded `/bin/sh`,** so the health check aborted before printing any row on a host without it. The shell is now probed and falls back to `PATH`/`PATHEXT` resolution.
- **`tests/permission-gate.test.mjs`: `sed -i` used the GNU form,** which is a syntax error on BSD/macOS `sed`. Now uses `sed -i ''`, valid on both.
- **`doc:check` flagged native-only env vars.** The scan reads `extensions/**/*.ts`, `scripts/*.mjs`, `skills/*/scripts/**` — not Rust — so documented `PI_READ_COMPRESS`, `PI_READ_LINE_CAP`, and `PI_BASH_SHELL` appeared undocumented. All three are now classified in `ENV_VAR_ALLOWLIST` as native.

### Changed

- **`README.md` performance section re-measured and re-scoped.** The OS/node label is gone (the tables are a built-in-vs-native comparison, not a platform claim); every figure in the block was regenerated on one host, so the section is a single coherent dataset. Two numbers moved materially: `piedit` 1 MiB is `7.0×` (was a host-inflated `9.2×`) and `pibash` `seq 50000` is **+3.57 ms** at p50 (was `+0.12 ms`) — the doubled-envelope regression is real and scales with output size, and the note now says so instead of calling it a rounding error. Removed the daemon-RSS line: that probe reads `/proc`, the benchmarks log `rss daemon(vmhwm)=skipped` off-Linux, and publishing a number that cannot be reproduced here is worse than omitting it. Added a new **Context shaping** section with the model-visible byte table and per-tool strategy breakdown.
- **`tests/piread-parity.test.mjs` pins `PI_READ_COMPRESS=0`.** The suite's entire contract is byte-identity with the built-in `read`, which is exactly what compaction changes; it now states that explicitly instead of depending on the ambient default.
- **`docs/portability.md`** documents the no-hardcoded-`/bin/sh` rule and the daemon process-group requirement.

## [1.45.0] - 17-10-2026

### Added

- **`pibash`: deterministic command-aware Tier-1 output compression (`custom-tools/pibash/src/compress.rs`).** The native shell tool previously forwarded an unbounded stream and let the permission-gate H1 cap cut it blindly from the tail — errors buried in the middle of a large failing run (the "lost in the middle" case) were lost. A new Rust module classifies the command (test/build/git/search/log/generic) and prunes oversized output to the model-visible budget (40 lines / 2 KB, matching the gate's H1 cap) with diagnostic-aware windows: `error_priority` preserves every actionable line verbatim (errors, warnings, failures, panics, assertions, stack traces, `file:line` refs, the final summary) then fills remaining budget with head+tail context; `head_tail` splits 60/40 for success and 30/70 for failure. Deterministic and idempotent — no LLM, no timestamps — with an explicit `[... omitted N chars / M lines ...]` marker and UTF-8-boundary-safe slicing. Also ports ANSI stripping and repeated-line dedup from the gate's `output-scrub.ts` into the same Rust pass, and adds a rough `token_estimate` (chars/4). Output within budget passes through **byte-identical** (parity preserved); only oversized output diverges, by design.
- **Shadow pre-pass over the full stream (Option B).** `compression` runs on the complete output (spill file or in-memory raw) *before* the legacy tail-truncation/parity path, then the pruned text is funneled through a scratch accumulator so the envelope schema and field flags stay intact. New additive envelope fields: `compression` (`strategy`, `originalChars`, `visibleChars`, `omittedChars`, `spillUsed`, `fullOutputPath`) and `token_estimate`; `text`/`truncated`/`truncation`/`fullOutputPath`/`structured_output`/`exit_code`/`wall_time_seconds` are unchanged (`truncated` still mirrors the built-in oracle's original-stream window).
- **Permission-gate H1 pass-through for compressed output.** The pibash extension forwards `compression` into `details`; `bash-cap.ts` gains `isRustCompressed` (compression metadata OR the Rust omission marker in text) and the H1 `tool_result` handler skips scrub + cap for an already-compressed result, so the gate no longer re-cuts the diagnostics the engine rescued. Non-compressed oversized output is still capped (safety net unchanged).
- **`tests/gate-bypass.test.mjs`** — 5 checks pinning the bypass signal and the cap safety net.
- **README performance section** — a native-tool benchmark table (`builtin p50` vs `native p50` vs Δ) with per-tool detail, sourced from `benchmark/runs/`.

### Fixed

- **`pibash` lost the final streamed output for short-lived commands.** In `runner.rs`, the post-exit `flush_pending` did not notify the `RunObserver`, so a fast command whose only output arrived after the loop broke on child exit was accumulated but never streamed (and `observer_receives_the_pid_and_output_updates` failed intermittently). The final flush now fires `observer.update` when it appended anything. Fixed at the root — the two long-standing `runner`/`serve` timing flakes were the same bug; the suite is now deterministic (124/124).

### Changed

- **`tests/pibash-parity.test.mjs` refactored for the intentional display divergence.** Machine-readable fields (`isError`, `exit_code`, `structured_truncated`, `structured_has_path`) keep strict equality with the built-in oracle; display `text` is asserted against the compression contract (budget, omission marker, UTF-8 boundaries) whenever the oracle exceeds 40 lines / 2 KB. 61/61. This runs green end-to-end, alongside 45 `compress` unit tests, `cargo test` 124/124 (release, zero warnings), and `npm run check` 105/105.

## [1.44.0] - 16-10-2026

### Changed

- **`pibash` promoted to first-class: built-in `bash` is now blocked (permission-gate P2, "Pibash-first").** `piread`/`piedit` were mechanically first-class (P1 blocks built-in `read` for text files); `pibash` was registered and documented as the default shell tool but nothing steered calls away from built-in `bash`, so adoption depended on the model's habit. P2 mirrors P1: a built-in `bash` tool_call is blocked when `PI_NATIVE_BASH !== "0"` with "use the pibash tool …" as the corrective reason. pibash runs the full bash-kind rule set (H1 cap, R10, destructive, toolchain) and falls back to the built-in executor itself, so the block is fail-open to correctness; `PI_NATIVE_BASH=0` restores `bash`. Also: pibash's `promptGuidelines` are now pibash-specific (they previously copied the built-in bash's generic `PI_*` hint, so the system-prompt guidance for `bash` and `pibash` was identical), and a "Token Economy (Pibash-first)" violation-memory lesson teaches the rule across sessions. Tests: `tests/permission-gate.test.mjs` 268/268 (+`P2: built-in bash is blocked`, +`P2: built-in bash passes when pibash is opted out`); the suite runs bash-mechanics cases with `PI_NATIVE_BASH=0` so P2 does not preempt rule-specific blocks. `tests/pibash-parity.test.mjs` 61/61, `npm run typecheck` clean.

### Fixed

- **`piread`/`piedit` capability gaps found by cross-checking against the built-in `read`/`edit`.** (1) Both extensions now pre-resolve the tool path with a mirror of the SDK's (unexported) `resolveToCwd` — leading-`@` strip, `~` expansion, `file://` URLs, unicode-space normalization; previously `piedit` failed on `@`-prefixed / `file://` / `~` paths the built-in resolves, and `piread` could read a literal-NBSP sibling instead of the space-normalized file the built-in reads. (2) `piedit` runs the built-in's `validateEditInput` before dispatching, so empty / non-array `edits` throw the exact "Edit tool input is invalid. edits must contain at least one replacement." (the daemon previously emitted an unprefixed message; a non-array produced a JSON protocol error). (3) Rust `check_access` now mirrors Node's `access(R_OK | W_OK)` by opening the target read+write (directories pass and fail later with EISDIR), so a read-only file fails with "Could not edit file: <path>. Error code: EACCES." instead of a raw write error. (4) `piread` guards a non-string `path` and falls back so the built-in raises its own TypeError; Rust `piedit` `serve.rs` empty-edits message aligned. Tests: `tests/piread-parity.test.mjs` 150→152, `tests/piedit-parity.test.mjs` 51→58 (new @/file:///~/NBSP/read-only/validation cases); crate 40/40, clippy `-D warnings` clean, typecheck clean, `doc:check` 4/4.

## [1.43.0] - 16-10-2026

### Removed

- **Ghostty terminal feature reverted.** The recommended-terminal work (`scripts/setup-ghostty.sh`, `scripts/pi-ghostty.sh`, `docs/terminal-setup.md`, `tests/setup-ghostty.test.mjs`) is deleted, along with its README section, `ghostty` in `doc-check.mjs`'s `OPTIONAL_TOOLCHAINS`, and the driving task brief in `feedback.md`. The harness now makes no terminal-emulator recommendation: Pi keeps running in any modern terminal, and the VS Code integrated terminal stays the default here. Nothing in `permission-gate` or the `piread`/`piedit`/`pidx` daemons was ever coupled to it, so no behavior changes beyond the removal.

### Changed

- README doc corrections from the same review: future-dated `2026-10-18` verification/redesign stamps → `2026-10-16`; `piedit` parity count in the Extensions section 40 → 51 (matches the perf section and the release entry); native-tool performance tables now labeled Linux x64 with macOS/Linux parity pinned by the test suites rather than a second benchmark host; the `pidx` cold-run cell labels both hosts explicitly (original 0.22 s, slower 0.80 s); and the 60 KB read note separates measured run variance from the identified structural floor.

## [1.42.0] - 16-10-2026

### Changed

- **`piedit` native diff/patch render — 2.4–9.2× faster than the built-in `edit`** (user-requested speed mandate; supersedes spec D2's TS-render pin — the byte-parity risk D2 guarded against is now covered by a stronger oracle instead of avoidance). New `custom-tools/piedit/src/diff.rs` is a byte-identical Rust port of the bundled jsdiff v8 line tokenizer + greedy Myers walk (exact tie-break, `addToPath` coalescing, diagonal pruning) plus pi's `generateDiffString` and `structuredPatch`/`formatPatch` (`FILE_HEADERS_ONLY`), extracted from the shipped `dist/bundle` source. Protocol: requests carry `renderDiff: true`; success responses return `{diff, patch, firstChangedLine}` — `{baseContent, newContent}` never cross the IPC boundary (the old envelope remains as the mixed-version rung and still renders via the exported TS helpers). One shared Myers pass feeds both renders; equal-part rendering counts lines without materializing 60k-slice vectors (`RawLinesView`). Serve loop: single `serde_json` parse per request (was two) into a reused `read_until` line buffer (no per-line `String`). Also fixes a pre-existing occurrence-count parity bug the new adversarial corpus exposed: a whitespace-only `oldText` (fuzzy-normalizes to empty) counted `chars + 1` where JS counts UTF-16 units − 1 (8 vs 6 occurrences on the blank-lines case). Parity hardened: `tests/piedit-parity.test.mjs` 51/51 (+11 diff-adversarial cases: multi-hunk, 2×context gap boundary, pure insert/delete, no-eof-newline both sides, dropped trailing newline, repeated-block tie-break, blank/whitespace lines, 2k-line multiline block, same-line multi-edit) and new `tests/piedit-diff-fuzz.mjs` (deterministic 2k–3k-case differential fuzz vs the TS helpers, 0 failures); crate 40/40. Measured on this host (`benchmark/runs/piedit-microbench-2026-10-16.md`): disk corpus small 2.1×/mid 2.4–3.0×/multiline 3.2×/large 2.5× (large floored by an ~20 ms ext4 write BOTH arms pay); tmpfs corpus mid 3.8×/multiline 3.4×/large-1MiB **9.2×** (88.2 → 9.6 ms).

## [1.41.0] - 16-10-2026

### Changed

- **`piedit` perf pass: faster than the built-in `edit` on every bench class** — three hot-path fixes close the >1 MiB regression (+30.9 ms → parity) and put small/mid/multiline classes 11–50% below the oracle. (1) `apply_edits` builds one shared `FuzzyView`: JS recomputes `normalizeForFuzzyMatch(content)` per edit (pre-pass, replacement base, every `countOccurrences`), so a 3-edit call on a 590 KB file normalized the whole file 4×; the view is deterministic and idempotent, so one lazy build is observably identical (590 KB × 3 edits: ~60 ms → <10 ms binary self-time). (2) `normalize_for_fuzzy_match` skips NFKC for pure-ASCII input (identity below U+0080) and builds one output buffer with no per-line `String` allocations (clean lines cross as a single `push_str`). (3) `normalize_to_lf`/`restore_line_endings` return `Cow` and the no-BOM write path skips the final concatenation copy. Node side: the daemon and one-shot clients collect raw `Buffer` chunks and decode once per complete line — the old `setEncoding` + string `+=` + per-chunk `indexOf` re-flattened the rope per chunk (O(n²) on MiB-scale envelopes, ~13 ms at 1.2 MB). Parity unchanged: crate 25/25, `tests/piedit-parity.test.mjs` 40/40, clippy `-D warnings` clean. Measured (`benchmark/runs/piedit-microbench-2026-10-16.md`, two runs within noise): small 0.29–0.31 vs 0.47–0.59 ms, mid 0.57–0.67 vs 0.65–0.86 ms, multiline-block 2.11–2.16 vs 2.52–2.74 ms, large-1MiB 88.4–90.0 vs 88.1–88.3 ms — the remaining ~74 ms there is the shared TypeScript diff/patch render (spec D2), which the built-in pays identically; the isolated native round-trip (oneshot arm) is 31–34 ms.

### Added

- **Rust tools consolidated into a `custom-tools/` workspace** — `native/` renamed to `custom-tools/` and turned into a Cargo workspace (`custom-tools/Cargo.toml`, members `pidx`/`piread`/`piedit`): one build/test/lint entry point, one shared tracked `custom-tools/Cargo.lock` (reproducible binaries), one `custom-tools/target/` instead of three. `bootstrap.sh`/`after-pull.sh` build per crate with `-p <name>` (a change to one crate no longer rebuilds the other two); `pidoc --fix` does the same for `pidx`. Removed the three per-crate `.gitignore`/`Cargo.lock` files (superseded) and the dead `/tools/pidx/*` ignore rules. `pidx/Feedback.md` (a repo-wide design review, misfiled) moved to `docs/reviews/harness-review.md`. Each crate has a `README.md` documenting its build history.

- **Native edit tool `piedit` (Rust, default-on)** — registers a first-class tool labeled **`piedit`** alongside the built-in `edit`, following the `piread`/`pidx` individual-registration pattern. New crate `custom-tools/piedit/` (Rust 2024; serde, serde_json, unicode-normalization; no `unsafe`, clippy `-D warnings`) owns read → LF/BOM normalize → exact/fuzzy match → uniqueness/overlap/no-change validation → apply → write, returning `{baseContent, newContent}`; the extension keeps diff/patch rendering on the exported TypeScript `generateDiffString`/`generateUnifiedPatch` helpers, so `details` is byte-identical to the built-in by construction. `extensions/piedit/` spreads `createEditToolDefinition` verbatim (schema, `prepareArguments`, `constrainedSampling`, `renderShell`, renderers) and overrides only name/label/description/promptGuidelines/execute/renderCall. Dispatch is a fail-open ladder — persistent `--serve` daemon (lazy-started, id-matched NDJSON over stdio, restarts on death) → one-shot `bin/piedit` spawn → built-in executor — all native rungs inside the exported `withFileMutationQueue`; terminal failure emits one `piedit: fallback (<reason>)` stderr line and a `Piedit (fallback)` entry in `logs/violation-memory.ndjson`. Six `edit-diff.js` error strings are byte-identical (pinned by the oracle). `permission-gate` treats `piedit` as edit-kind (Anchor Guard, protected-path confirm, M1/M2/M3 chain, read→edit coverage binding) and includes it in the file-path scrape. Opt out with `PI_NATIVE_EDIT=0`. `scripts/bootstrap.sh` / `after-pull.sh` build + install `bin/piedit` (cargo-missing degrades to the built-in). Tests: `tests/piedit-parity.test.mjs` (40 cases — corpus, error paths, unicode/CRLF/BOM, daemon client, gate lock-ins) and `tests/piedit-bench.mjs`; crate unit tests 25/25. Measured (`benchmark/runs/piedit-microbench-2026-10-15.md`, two runs within noise): the daemon closes the ~4.3 ms spawn floor, putting small exact/fuzzy edits **below** the built-in (0.335 vs 0.527 ms; 0.326 vs 0.499 ms) and mid/multiline at parity; the one-shot rung (3.2–4.2 ms) shows why the daemon was needed. The >1 MiB class regresses (+30.9 ms) — `baseContent` + `newContent` cross IPC as JSON and TS diff/patch rendering stays on the shared path (spec D2/R6); size-based routing to the built-in for very large files is the documented follow-up. The S8 spec marked this an abort at the Step 0 gate; it was built anyway per explicit user direction, and the parity-correct tool is latency-neutral-to-positive on the hot path.

### Fixed

- **`piedit` fallback no longer deadlocks** — the extension's own `withFileMutationQueue` released the path before the fallback ran; calling the built-in executor (which takes the same queue) inside the native wrap re-entered the same-path queue and hung. Fallback now runs after the native wrap returns.

## [1.40.0] - 16-10-2026

### Added

- **Fail-closed security hardening for permission-gate (S4)** — adversarial test families per `docs/specs/2026-10-15-s4-failclosed-design.md`: failure-path (every `pi.on` handler body wrapped — tool_call exceptions now block with a generic internal reason instead of failing open, tool_result exceptions pass through with `console.error`), `ui.confirm === true` strictness (a truthy non-boolean never approves), malformed-input guards (missing/non-string bash command, write/edit/read without a path → explicit block reason, never an analyzer throw). Live-shell canary suite in `tests/permission-gate.test.mjs`: mkdtemp sandbox + fake HOME with byte-compared canaries (`~/.ssh/authorized_keys`, `~/.bashrc`, work file), gate-approved commands execute headless, a runner-side hard net (unit-asserted) refuses system paths/sudo/network/push without executing — sabotage smoke (pipe-to-shell fix reverted) goes red and destroys only the sandbox canary. TOCTOU/symlink/spill lock-ins: decision-time re-stat, verbatim approve-window keying, `ln -s canary && rm link`, hostile toolCallId spill sanitization.
- **Destructive-classification evasion lanes closed (fixtures 54 → 92, `new_fail: 0`)** — transparent prefixes (`env|command|exec|nohup|timeout N|nice [-n N] rm …`) stripped in `normalizeSegment` to a fixpoint; `$VAR`/`${VAR}` command words confirm (position-anchored, so `$arg` expansions stay allowed); pipe-to-interpreter (`… | sh|bash|zsh|dash|ksh`) blocks; persistence redirects and tee targets (`> ~/.bashrc`, `>> ~/.ssh/authorized_keys`, `tee -a ~/.profile`) block against a new exported `PROTECTED_PREFIX_RE` (rc files, `~/.ssh/`, `~/.gnupg/`, `~/.config/systemd/`, `/etc`, `/usr`, `/var`, `/boot`, `/root` — rebuilt when `os.homedir()` changes); write/edit into symlink-resolved protected paths runs the same H2 approval ladder (chat approval → dialog → fail closed). Interpreter escapes (`perl -e`/`node -e`/`python3 -c`/awk `system()`), homoglyphs, `eval` of base64 payloads, and alias indirection are encoded as `?` known-bug fixtures — the documented tripwire boundary (`known_bug_fail: 7`).
- **Edit-validation hardening for permission-gate (S5)** — edits and writes now bind to certified reads per `docs/specs/2026-10-16-s5-edit-hardening-design.md`: **M1 stale-bind** (stat drift since the last certified read blocks `Anchor Guard (Stale)` with the targeted re-read fix — catches every external writer at mtime granularity), **M3 content-hash chain** (sha256-16 stored at edit/write tool_result and the inject path, compared at mutation `tool_call` — closes the same-stat tail of fast writes and restored mtimes; hash-blocked calls drop coverage so R1 never blocks the corrective re-read; 1 MiB cap above which files stay stat-only; reads stay hash-free to protect the hot path — residual R2), **M2 region-read requirement** (never-read paths block `Anchor Guard (Unread)` naming the anchor's line range; exact anchors must intersect a certified span; fuzzy anchors need any coverage — R3; write-to-existing requires a prior read, new files pass). Policy order locked in: protected-path H2 confirm fires before binding blocks; binding blocks never skip policy. `tests/permission-gate.test.mjs` 204 → 241 (sabotage smoke per mechanism red/green); `gate:eval` `new_fail: 0`, `fp_rate` 0.0331 → 0.0328.
- **rg-first search posture + pinned PCRE2 rg (SS2)** — `permission-gate` blocks bare `grep`/`egrep`/`fgrep` (segment head or mid-pipe) with the rg fix carried in the reason, firing after PB1/SS1/NM1 and honoring the 2026-10-13 `@earendil-works` pi-docs grep approval; `docs/agent-hygiene.md` gains the rg-default rule. `bin/rg` is now a local build with PCRE2 (`cargo install ripgrep --features pcre2 --root ~/.pi/agent` — `rg -P` no longer errors, so the grep fallback has no trigger), documented in README "Custom tool binaries" together with the shell-rc PATH pin (zsh/bash, macOS+Linux) for terminals. `pidoc` grows `rg-pcre2`, `piread`, and `shell-path` checks; gate suite 243/243.
- **fd-first file-find posture (SS3)** — `permission-gate` blocks bare `find` segment heads with the fd fix carried in the reason (NM1's node_modules approval reason still fires first); `AGENTS.md`/`docs/agent-hygiene.md` gain the fd-default rule (`find` fallback only when fd errored); suite 243 → 246.

### Fixed

- **permission-gate destructive block reason diet-cap overflow** — commands ≥ 35c produced a 220c+ reason; the command slice is now clamped so the reason always fits the 220c budget (surfaced by the new `ln -s canary && rm link` lock-in).
- **`tests/gate.eval.mjs` destructive-family fixtures** now run headless (`{hasUI:false}`) — the auto-approving stub ctx previously masked H2 block assertions in the fixture runner.

### Unchanged

- Replay metrics flat vs. pre-S4 baseline: `tokens_per_task` 297 → 297, `fp_rate` 0.0339 → 0.0335, blocked 294 → 294 (no collateral blocks); `tests/permission-gate.test.mjs` 176 → 204 cases, all green.

## [1.39.1] - 15-10-2026

### Added

- **`npm run doc:check` — doc-consistency validator (S3)** — `skills/harness-engineer/scripts/mdcmdcheck.mjs` promoted to `scripts/doc-check.mjs` (move verified byte-identical: same 526-file scan, same findings, exit 0) and extended with three repo-derived families: skills-inventory (README skills table ↔ `skills/*/SKILL.md`), extensions-inventory (README Extensions section ↔ `extensions/*` dirs with `.ts`), env-vars (`PI_*` in `extensions/**/*.ts`, `scripts/*.mjs`, `skills/*/scripts/**` ↔ README + extensions READMEs, bidirectional, inline allowlist for parent→child plumbing). No hardcoded counts or inventories — adding a skill or env var never edits the validator. Tests: `tests/doc-check.test.mjs` (21 cases, temp-tree fixtures). One-time README pass ships with it: count-free badges/prose (`skills-22`, `extensions-2`, "All 22 skills", "all 20 manual" gone), tree `tools/` → `native/` plus missing tracked dirs, "Zero environment variables" → "zero env vars required for setup", env-var doc ghosts fixed (`PI_AGENT_DIR`/`PI_TEST_MODEL`/`PI_TIMEOUT` documented vars that don't exist in code; real test knob is `PI_TEST_TIMEOUT`, upstream `PI_CODING_AGENT_DIR` now named accurately). Not wired into release CI (user decision — local gate only); env-var doc set includes `extensions/*/README.md` so extension-local knobs count as documented.

### Changed

- **`skills/llm-instruction-formatter` → `skills/llm-format-checker`** — name now reads as a check/fix tool; invocation `/skill:llm-format-checker`; README roster row and the `skill-manager` auto-apply reference updated. Behavior unchanged.
- **`skills/rust-skills` layout conformance** — nonstandard `rules/` renamed `references/` per the harness layout contract, and the 265-rule Quick Reference moved out of `SKILL.md` into `references/quick-reference.md`; `SKILL.md` 500 → 160 lines; one mislabeled `bash` fence (DHAT Rust sample) corrected. `validate-skill.mjs` now passes.

### Fixed

- **`mdcmdcheck.mjs` false positives** — optional toolchains the harness documents but does not require (Rust/profile: `cargo`, `rustc`, `perf`, `valgrind`, …) and reference-doc build/example artifacts (`./target/…`) are now info-only; env-assignment parsing is quote/paren aware (`RUSTFLAGS="-C target-cpu=native" cargo …`, `PGO_DIR=…$(date +%s)`); `~`-relative shim paths expand; `audit-reports/` is treated as history; an inline `a|b|c` alternation is no longer read as a pipeline; three reviewed flags are waived. The gate now exits 0.
- **README test command** — `node --test tests/` (which errors) → `node --test "tests/**/*.test.mjs"`, with `npm run gate:eval` documented as the aggregate; stale "All 20 skills" → 22; mdcmdcheck's info-only behavior noted.
- **permission-gate tests** — four nested/codemode expectations updated to `blocked` after codemode removal, so the suite reflects uniform enforcement (176/176 pass).

## [1.39.0] - 15-10-2026

### Added

- **pidx warm fast path** — state store keeps a small byte-range header plus raw extract bytes; unchanged sessions replay to output without JSON re-parse or re-serialize. Warm run ~0.28s → ~0.01s, cold ~0.45s → ~0.22s, warm peak RSS ~290MB → ~17MB (`tools/pidx/`).
- **Post-pull setup sync** — husky `post-merge`/`post-rewrite` hooks run `scripts/after-pull.sh`: refresh npm deps when the manifest moved, re-link host pi packages, recreate the `pidoc` shim, then `pidoc --fix` to rebuild stale `pidx` and report missing toolchains without installing them.

### Changed

- **README skill/extension roster** — skills 20 → 22 (`pi-doctor`, `rust-skills`); added a Rust badge; corrected `handoff.ts` behavior (no disk artifact); `extensions/README.md` table now lists `handoff.ts`.

## [1.38.0] - 14-10-2026

### Added

- **Output scrub for bash tool results** — ANSI stripping, test-output aggregation (passing lines collapsed to a counted summary, failures kept verbatim), and build-output filtering (errors/warnings plus head/tail anchors), applied before the existing output cap (`extensions/permission-gate/output-scrub.ts`).

### Removed

- **Codemode nested-call exemptions in permission-gate** — rules (big-read, re-read coverage, re-run, re-block, search scope) apply uniformly again after codemode removal.

## [1.37.3] - 14-10-2026

### Changed

- **Token-reduction tuning** — `settings.json` adopts `codemode: {mode: "only", inlineBudget: 0}`, `defaultTools: ["+codemode"]`, `extensions: ["-builtin:mcp"]`; measured probe 2365 → 1872 tok (−21%). Full report: `audit-reports/token-reduction-2026-10-14.md`.
- **permission-gate NM1 policy** — `node_modules/@earendil-works/**` pre-approved; all other `node_modules` reads ask the user (was auto-block).
- **`extensions/permission-gate/search-guard.ts`** — soak-test fix: bare absolute `node_modules` dir path (no trailing slash) escaped NM1; `isNodeModulesToken` regex now `/(^|\/)node_modules(\/|$)/` (regression test added).
- **Skills telegram-style rewrite (final 3 of 20)** — `skills/systematic-debugging/` (SKILL.md + 5 references), `skills/auth/` (SKILL.md + 7 references), `skills/refactoring-ui/` (SKILL.md + 4 references) rewritten to concise LLM-friendly fragments matching the tone of the 17 skills rewritten in a prior (unlogged) session. Prose only — frontmatter, code blocks, commands, thresholds, dot graphs, tables preserved verbatim; no semantic loss. All 19 files shrank (e.g. debugging SKILL.md 9299 → 6962 B, accessibility-depth 11802 → 10129 B, animation-microinteractions 9523 → 8192 B).

### Removed

- `skills/auth/SKILL.md` — checklist's `docs/issue-classes.md` catalog pointer (owner direction).
- `skills/refactoring-ui/SKILL.md` — Wathan & Schoger book attribution (owner direction).

### Added

- **permission-gate tests** — 3 new cases (NM1 earendil exemption, bare `node_modules` path, codemode interception); suite 167 → 170, all pass.

## [1.37.2] - 13-10-2026

### Changed

- **`prompts/ship.md`** — reverted the 1.37.1 `pre-push-review` precondition (user direction: no pre-push-review during ship); ship stays commit-mechanics only. Issue-class prevention rests on the always-on `AGENTS.md` GitHub-issues rule + `docs/issue-classes.md` catalog, invoked at the agent's judgment, not the ship gate.

## [1.37.1] - 13-10-2026

### Changed

- **`prompts/ship.md`** — ships now require the diff to have passed the `pre-push-review` checklist against every `docs/issue-classes.md` class it touches (run the skill first if not); previously the catalog check hung on the always-on rule and manual skill invocation alone, so an unchecked diff could ship.

## [1.37.0] - 13-10-2026

### Added

- **permission-gate TC1/TC2 (toolchain pins)** — `npm`/`npx`/`yarn` blocked in a pnpm repo (`packageManager`/`pnpm-lock.yaml`; `npx pnpm` allowed); node-family binaries blocked under an exact x.y.z Node pin (`.nvmrc`/`engines`) the interpreter misses. Version-manager commands (`nvm use … &&`), explicit binary paths and range pins pass; `PGATE_TOOLCHAIN=0` disables. Audit basis: 7 failed npm-in-pnpm runs, 4× `Unsupported engine` + module-not-found.
- **permission-gate SS1/PB1/NM1 (search scope)** — unscoped recursive grep, `grep -P` on darwin, and read-tool/`grep`/`find`/`rg`/`cat`/`head`/`tail` into `node_modules` blocked (`ls node_modules` allowed; rg passes by design). Audit basis: two 30s grep timeouts, a `node_modules/.pnpm` read, `grep: invalid option -- P`.
- **violation-memory lessons** for the five new families; block-family recognition extended (`Toolchain`/`Search`/`Portability`).
- **tests** — 17 new black-box cases; suite 150 → 167, all pass.
- **`audit-reports/2026-10-13T114943Z-coverage.md`** (local, gitignored like all audit reports) — mistake/issue-class × mechanism × enforcement-status matrix from the 38-session mining; documents the two deliberately advisory classes.

### Changed

- **`AGENTS.md`** — Mechanical checks lists the new gate families (toolchain pins, search scope, node_modules reads); measured 2,933 → 2,986 bytes (~733 → ~739 tokens, under the 800-token floor).
- **`docs/agent-hygiene.md`** / **`docs/portability.md`** — mirror notes: TC1/TC2/SS1/PB1/NM1 enforced by permission-gate.
- **`skills/research/`** — removed: empty orphan dir (no SKILL.md, zero files); it was never a skill and the README count (20) was correct.

## [1.36.0] - 13-10-2026

### Added

- **`docs/issue-classes.md`** — project-agnostic prevention catalog compiled from a repo-wide review audit: secrets/credentials, authorization/auth, HTTP client & data contract, runtime robustness, realtime/maps, CI/container, maintainability/testing. Each class is a pre-ship check; goal is these issues never recur. Zero always-on cost.
- **`AGENTS.md` `GitHub issues` rule** — extended: prevent the known failure classes for the domains a task touches.
- **`docs/issue-classes.md` global error handling** — one owner catches/normalizes/logs/renders the fallback at process, router, subtree, and data-layer levels; every status/kind classified with a recovery action; no swallowed errors, no retry that cannot succeed. Wired into `pre-push-review` and `frontend-design`.
- **Skill wiring** — `pre-push-review` checklist gains runtime-robustness/HTTP/cache/TLS/dependency items + catalog pointer; `auth` gains backend-session-revocation and cross-origin-token rules + pointer; `github-actions` gains `concurrency` and prod quality-gate items + pointer; `map-integration` gains rebuild-perf rule + pointer; `frontend-design` gains error-boundary/loading-state note + pointer.

### Changed

- **`AGENTS.md`** — lists `docs/issue-classes.md` in scoped rule sets. Measured: 2,673 → 2,933 bytes (~668 → ~733 tokens, under the 800-token floor).

## [1.35.0] - 13-10-2026

### Added

- **`docs/agent-hygiene.md`** — scoped rule set (loaded via AGENTS.md link): toolchain (activate the pinned Node/package manager, no `node_modules` reads, scoped `rg`), edit anchors (re-read before edit, no-op edits), issue/commit discipline (read the issue's acceptance criteria and suggested fix, one comment per commit with short SHA, no close on unpushed work, commitlint before commit). Zero always-on cost.
- **`AGENTS.md` `GitHub issues` rule** — always-on: any task in a gh-tracked repo checks for a related issue and covers its acceptance criteria and suggested fix before acting.

### Changed

- **`AGENTS.md`** — toolchain/edit/issue detail kept out of the always-on core (linked to `docs/agent-hygiene.md`); adds the always-on `GitHub issues` rule. Measured: 3,683 → 2,673 bytes (~920 → ~668 tokens, under the 800-token floor).
- **`prompts/ship.md`** — on commit/push failure: read the error once, fix the cause; never re-issue with altered quoting, never retry without a change (audit `01a129ba`, `01a12ffa`).
- **`prompts/issue.md`** — one comment per commit, quoting the short SHA; edit instead of reposting (audit `01a134b4`).
- **`skills/pre-push-review/SKILL.md`** — per-issue ship loop: one comment per commit with short SHA, edit not re-post; closing requires the diff to satisfy the issue's acceptance criteria and the fix to be pushed.
- **`docs/token-economy.md`** — release/changelog/issue-close run as separate short sessions (audit `01a12f56`, 269 turns / 318K prefix).
- **`docs/portability.md`** — no `grep -P`; no single-quoted `python3 -c` with embedded quotes.

## [1.34.0] - 12-10-2026

### Added

- **`skills/markdown-optimizer`** — manual-only skill (`/skill:markdown-optimizer`, model invocation disabled): LLM-optimized Markdown formatting discipline for rule/instruction files only (AGENTS.md/CLAUDE.md, system prompts, prompt templates, SKILL.md bodies, agent rule-set docs) — bold only for critical constraints/entities, strict heading nesting, bullets vs numbered lists, one clause per bullet. Prose docs, READMEs, changelogs out of scope. Skill count 19 → 20; zero per-session cost.

### Changed

- **AGENTS.md restructured for LLM adherence** — bold-label bullets became `###` rule sections with one-clause bullets; bold kept only on the two hard constraints. Wording preserved verbatim; 2,218 → 2,249 bytes (~0.5K tokens, always-on budget unchanged). Prefix bytes changed — fresh session after pull.
- **`docs/` rule sets restructured** — security: comma-blob bullets → `## Ask before` / `## Never` lists; token-economy: 13 flat bullets → five `##` groups; change-discipline/portability/workflow: compound bullets split. Wording verbatim, zero semantic changes (+99/−30 lines across AGENTS.md + docs/).
- **README synced** — badge and skill counts 19 → 20, markdown-optimizer roster row, AGENTS.md byte figure 1,991 → 2,249.
- **`skills/markdown-optimizer` renamed `skills/llm-instruction-formatter`** — name now self-scopes to LLM rule/instruction markdown only; invocation `/skill:llm-instruction-formatter`; README roster row updated, roster table columns realigned. Behavior unchanged.
- **`skills/` + `prompts/` instruction markdown optimized (first llm-instruction-formatter run)** — 59 files audited (19 SKILL.md bodies, 37 skill references, 3 prompt templates), 45 changed, 14 already compliant: label/aesthetic bolds stripped (constraint/entity bolds kept), bold pseudo-headers converted to real headings at correct levels, non-sequential numbered lists converted to bullets, compound and comma-blob bullets split. Wording verbatim — verified per-file by word-diff and globally by alpha-stream equality; frontmatter, code fences, tables, URLs untouched.

## [1.33.0] - 12-10-2026

### Removed

- **`skills/domain-modeling` deleted** — README roster row, badge, and skill counts updated (20 → 19); no prompts/, extensions/, or docs/ references existed.

## [1.32.0] - 09-10-2026

### Changed

- **Ten skills restructured for progressive disclosure** — SKILL.md bodies slimmed to workflow + routing; long material moved to `references/` (skill-manager, browser-tools, systematic-debugging, playwright-tester, github-actions, sdk-development, pre-push-review, session-audit, map-integration, ponytail). Descriptions and invocations unchanged.
- **skill-manager gains an authoring-time anti-pattern gate** — the six prompt anti-patterns plus a security checklist (distilled from the harness audit) are swept on every create/modify before validation; spec, writing guide, and anti-pattern rules split into `references/`.
- **pre-push-review scope narrowed to diff review** — changelog/version-hygiene context removed, matching the actual review prompt; severity ladder unchanged.
- **Tool-selection cleanup across skills** — agent-facing commands and instructions use `rg` instead of `grep`; CI-embedded snippets keep portable `grep`.

## [1.31.0] - 10-09-2026

### Changed

- **`skills/grilling` renamed to `skills/grill-me`** — same body, `/skill:grill-me` invocation; only README row and frontmatter `name` touched.
- **`agents/researcher.md` absorbs `skills/research`**: primary-sources-only rule + findings-file persistence step (single Markdown file, each claim cited, saved per repo convention) moved in; `write` added to its tools.

- **Emoji purge (repo-wide)**: emoji glyphs removed from all tracked files except `CHANGELOG.md` (historical; changelogen token map is functional data) and `audit-reports/` (immutable evidence). Plain chars kept: ✓/✗; mapped: ✅→✓, ❌→✗, ⚠️→`WARNING:`, ➡️→→, 🔥→`!!`, ❓/🔍/🎯/🧪 dropped. Syntax checks pass: py_compile, bash -n, node --check.

### Removed

- **Skill count 23 → 20**: `wayfinder` (map-of-decision-tickets planning), `prototype` (throwaway UI/logic artifact), `research` (delegated reading legwork — content now lives in the researcher agent). No other references existed outside wayfinder itself.

## [1.30.0] - 10-09-2026

### Changed

- **Skill auto-invocation off**: `ponytail` and `systematic-debugging` no longer auto-load on task match — `/skill:<name>` only; always-on prefix drops ~1.7K → ~0.7K tokens.
- **`/issue` root-cause discipline**: the issue prompt now loads the `systematic-debugging` skill phases before analyzing cause or proposing a fix.

## [1.29.0] - 10-08-2026

### Changed

- **AGENTS.md rules tightened after behavior audit**: subagents rule reduced to a routing hint (extension gates activation; `/subagents on` = session authorization); ask-first now approves reads/searches directly implied by the named action; caveman mode hardened — ~5-line reply cap unless detail requested.
- **`/update-changelog` token fix**: reads CHANGELOG.md head only (15 lines, newest section) instead of the full ~199KB file — ~50K → ~0.5K tokens per run; full-file reads stay permission-gate blocked.

## [1.28.0] - 10-08-2026

### Added

- **`/issue` delegation + guard guideline block** (autoresearch-validated): one issue per session; flow recap with HARD STOP; delegation tiers — solo for small fixes (≤2 files, no behavior change), + `gh-issue-verifier` on business-logic changes, scout→worker→verifier for large/unfamiliar work; explicit risk/blast-radius disclosure at propose; hard rule that a post-report follow-up is never a close request. Validated across 12 runs / 9 configurations: 100% guards (zero pre-approval edits, unprompted closes, commits), 0.3–2.8 min per issue end-to-end.
- **Autoresearch artifacts**: `audit-reports/gh-issue-workflow-autoresearch-2026-10-08.md` (decision report) + `issue-workflow-guideline.md` deliverable; scratch bench JSONs (`suite-*`, `rescore-*`, `final-diff.patch`) removed.

### Changed

- **`prompts/issue.md` formatting**: bold lead anchors on every paragraph (Rules, Flow, Delegation, Risk, Hard rule) — wording unchanged, validated text verbatim. 1,181 → 3,143 bytes.
- **`permission-gate` typing**: `capBashOutput` now returns the SDK's `ToolResultEventResult` instead of inline structural types — no behavior change.

## [1.27.0] - 10-08-2026

### Changed

- **`/issue` redesigned from stateful pipeline to in-context flow**: issue state (validation, verdict, proposal, decision) now lives in conversation only — never in files. Dropped: `.pi/issues/N.md` record + scaffold, `ISSUE_TRACKER.md` bookkeeping, `/tmp/issues/N.json` dumps, dedicated `fix/issue-N` branch, human `Decision`/`Version` ceremony, built-in changelog-edit and ship stages (owned by the standalone `/update-changelog` and `/ship` commands). New flow: single `gh issue view` fetch → validate (repro/expected/observed + stale/dupe) → propose in the same reply → hard stop for human verify → skip, or implement on the current branch with narrowest verification → `gh issue close $1 -c` with a concise comment, only when the human asks.

Measured: `prompts/issue.md` 3,132 → 1,181 bytes (−62%); prompt template loads on demand (zero prefix cost) — run `/reload` in active sessions; portability sweep clean.

## [1.26.0] - 10-08-2026

### Added

- **Anti-pattern audit adopted into the harness audit mechanism**: the one-off 2026-10-08 audit framework (6 prompt anti-patterns, workflow mapping, security checklist) is now a permanent checklist at `skills/harness-engineer/references/anti-pattern-audit.md` — rg-signature sweep, calibration rules (earned emphasis vs boosters), report format with false-positive credit. Audit mode gained step 4 (steps 4–6 renumbered 5–7); trigger phrases added to the skill description ("anti-pattern audit", "audit my skills/prompts/extensions").

### Changed

- **First anti-pattern sweep applied** (report archived locally under `audit-reports/`, +14/−1,109 lines): systematic-debugging — booster rhetoric rewritten as reasoned imperatives, spliced "Use this ESPECIALLY when" list repaired, 5 stale reference files deleted (foreign-harness test scaffolds + creation log); brainstorming — body/description trigger contradiction aligned, design gate scoped to genuinely unclear intent; frontend-design — CRITICAL/IMPORTANT prefixes and a stale hardcoded model name dropped; web-search — unpinned `curl | bash` install now gated behind asking per AGENTS.md; browser-tools — `puppeteer`/`puppeteer-extra`/`stealth` deps removed (zero imports, lockfile −755 lines, `puppeteer-core@23.11.1` verified installed).

Measured: skill validator PASS (harness-engineer 130 lines, desc 415 chars); mdcmdcheck clean for all changed files (11 pre-existing findings in archived reports untouched).

## [1.25.0] - 10-08-2026

### Added

- **Permission-gate block audit** (`audit-reports/extensions/2026-10-08T051448Z.md` + `audit-reports/extensions/block-audit.mjs` scanner): all 120 blocks across Oct 6–7 sessions measured — family/recovery taxonomy (one-shot compliance 119/120), per-block cost ~460 tok vs measured savings, 4 over-blocking findings (2 confirmed false-fires), 1 verbatim re-send loop. Findings drove the gate changes below.

### Changed

- **Gate over-blocking + re-send loop fixed per the extensions audit** (`extensions/permission-gate.ts`):
  - **`;`-joined sed regions count as one batch** — AGENTS.md sanctions "sed -n when batching 2+ regions" but `sedBatch` counted ranges only within one invocation, false-firing on the split two-region form; same dump ceiling as the already-sanctioned `-e`×2 form, so no new evasion lane.
  - **≤128 B cats inside multi-command batches exempt** (`trivialCat()`): a block costs ~460 tok, so vetoing `date; cat .watermark.json (49 B); ls …` in full was a net loss; standalone cats, flags, globs, and unstatable targets still block.
  - **Re-block escalation**: a verbatim re-send of a just-blocked command within 2 min gets a dedicated reason naming the re-send itself (audit's single RETRY-SAME case re-sent `git clone + git log` twice because the second block merely repeated the original reason); real non-gate command failures don't arm it; state clears on compact/session switch.
  - **AGENTS.md gate-contract line synced** — sed/cat exemptions and the Re-block rule stated so the doc matches enforcement exactly.
  - Measured: `node tests/permission-gate.test.mjs` 72/72 PASS (+9 fixtures: distributed sed batch, batched/standalone/tiny/big cat, Re-block escalation, compliant variant, real-failure no-arm); `tsc --noEmit` clean; `tests/block-recovery-audit.mjs` ≥85% gate OK.

## [1.24.0] - 10-07-2026

### Added

- **`/issue <n>` gated issue-fixing pipeline** (`prompts/issue.md`): one GitHub issue per session, driven by a state machine on disk (`.pi/issues/<n>.md` record + `ISSUE_TRACKER.md` row). Phases: validate (formalized repro, stale/dupe check) → propose (root cause, deps flag, suggested semver bump) → human-only Decision gate (approve/skip/partial + changelog version target) → implement (scoped branch, narrowest test, CHANGELOG entry) → fresh-eyes pre-push review → ship (PR or direct push) → close with a comment drafted from the record. Hard rules: no code before approval, no unasked push, Decision untouchable by sessions.
- **`/triage [max]` batch duplicate detection** (`prompts/triage.md`): clusters likely-duplicate reports across fetched issue dumps (conservative — symptom and trigger must match) into an `ISSUE_TRACKER.md` "Possible duplicates" section; resolving clusters stays human.
- **`fetch-issues.sh [limit] [repo]`** (`scripts/fetch-issues.sh`): batch-pulls open issues to `$TMPDIR/issues/` and regenerates `ISSUE_TRACKER.md` at the repo root — full gh backlog merged with per-issue pipeline statuses from record files; non-table sections survive re-syncs.

## [1.23.0] - 10-07-2026

### Added

- **Post-Block Impact Analysis** (`audit-reports/harness/2026-10-07T110500Z-block-impact-permission-gate.md`, Feedbacks.md taxonomy v1; classifier in `tmp/block-impact/`): every gate block in watermark-scoped sessions joined to its next tool call, labeled per taxonomy (compliant / cosmetic / semantic-evasion / fragmentation / loop / abandonment), scored on 4 axes. R6/R7/R9 healthy; **R10 withdraw-or-narrow** (compliance 0.06, mean −1.83 — base-key prefix collisions: shared `nvm use`/`KEY=` preambles, heredoc `cat` base, `node --test` re-filters; escapes are token-level; 2 correctness hits from tails of never-created files); R2 needs narrowing (`sed -n "s/…/p"` extraction false-positive, free `head`/`awk` evasion lane, er 0.24); runner caps mis-flag `> file` redirects; R5 misses `git log -<N>` short form; Anchor Guard / R1 kept (loss-rate artifacts documented in-report). Ranked actions in report §5 — implement on request. Measured: 139 blocks classified (0 unknown), 20 pre-watermark excluded as stale-gate; 42 sessions >30 d pruned (339→297 files); watermark advanced to `2026-10-07T10:50:40Z`.

### Added

- **Strict typecheck pipeline**: `tsconfig.json` (strict, `noEmit`, covers `extensions/` + `tests/`), `npm run typecheck`, and `scripts/link-pi.mjs` — symlinks the global `@earendil-works/pi-coding-agent` + nested `pi-tui` into the gitignored `node_modules` (validating link resolvability, not bare existence), so extensions compile-check against the exact host pi version and API drift after a global pi update surfaces as compile errors.

### Changed

- **Gate narrowed per the 2026-10-07 block-impact audit** (`extensions/permission-gate.ts`, report `audit-reports/harness/2026-10-07T110500Z-block-impact-permission-gate.md`, research: Claude Code PreToolUse deny+reason pattern, Hermes-agent #18076 identical-args dedup):
  - **R10 rekeyed to full-command identity** (fd-merges `2>&1` stripped, whitespace collapsed; `firstUnquotedPipeOrRedirect` deleted). The pipe-truncated base collided every command sharing a preamble — `source nvm.sh && nvm use X` keyed four different test runs, `KEY=$(…)` keyed different curl targets, `cat > f <<EOF` truncated to base `cat` — compliance 0.06, mean net −1.83, and the only escape was token-level mutation. A different downstream filter is now a legitimate re-view, not a dup.
  - **R2 narrowed + widened**: `sed -n "s/…/…/p"` substitution-print exempt (extraction, prints matches only — false-fired 5 blocks in one dropx-admin session); `do … done` bodies no longer split (the suggested fix, read, cannot loop); standalone `head`/`tail` viewers joined the block set with `tail -f` exempt (evasion was cheaper than compliance: er 0.24 via `head -40 file`/`awk NR`); reason now warns that a re-read of in-context lines hits R1 (cascade fix).
  - **`isCapped` counts stdout redirects to files** (`> /tmp/x`, incl. `/dev/null`; `2> err` alone does not) — `npx tsc --noEmit > /tmp/tsc.out 2>&1` was false-flagged though the bytes never land in context.
  - **R5 accepts `git log -<N>`** short form (lookbehind-guarded) — `git log -1 --format=%ci` false-fired. Measured: `node tests/permission-gate.test.mjs` 63/63 PASS (was 54; +9 fixtures: nvm-preamble non-collision, whitespace-variation still blocked, watcher-word exemption, head/tail viewing blocked, `tail -f` exempt, s///p pass, loop-body pass, redirect-caps-runner, `git log -1`); `tsc -p tsconfig.json` clean; `tests/block-recovery-audit.mjs` 98% one-shot recovery (gate ≥ 85%).
- **pi imports migrated to the `@earendil-works` scope** (`extensions/subagents/*`, `tests/subagents/*`): all `@mariozechner/*@0.65` imports replaced — subagents code had been executing pre-1.0 modules inside the 1.0.4 host (1.x API like `defaultActive` silently no-oped). Root devDeps: `typescript` + `@types/node` in, stale `@mariozechner/*` out.

### Fixed

- **`/ship` prompt: broken gate resolution + minimized** (`prompts/ship.md`): the prompt claimed "this command is the only thing that enables" pre-push-review, but nothing in the runtime enables a `disable-model-invocation` skill — agents in project repos hunted for the missing harness (`ls .husky`, `rg package.json`, `ls scripts/ .pi/`, one wasted call + reasoning per code session; observed in akg-frontend and dropx-merchant 10-07 sessions). Gate now resolves deterministically: body already in context → use it; else one read of `~/.pi/agent/skills/pre-push-review/SKILL.md`; never search the repo. Added ban on preemptive `.husky/`/`commitlint.config.*`/`lint-staged` reads (hooks run on their own; adapt only on rejection). Body compressed 430→230 words with all rules intact. Same treatment for `prompts/update-changelog.md` (290→175): URLs, header-placement prose, and new-file boilerplate cut — behavior across its 3 invocations (read → porcelain/date → edit → one-line report, no waste) unchanged by construction.
- **15 strict-mode type errors** in `extensions/subagents/`: `launchSubagent` name-required guard and `getSessionFile(): string | undefined` (ExtensionToolContext match), `ImageContent | TextContent` discriminant checks on `.text`, required `invalidate()` on the three message renderers, narrowed `activityFile` copy for the hoisted `flushNow` closure.
- **Gate re-read block reasons could exceed the 220c diet cap** on long paths (`extensions/permission-gate.ts`) — displayed path clamped to `…` + last 58 chars, worst-case reason ≈218c for any path length.
- **Test-suite env leakage** (`tests/subagents/test-env.ts`, imported first by `test.ts`): strips `PI_SUBAGENT_NAME`/`_AGENT`/`PI_SUBAGENTS`/`_ALLOWED` before the extension module evaluates — module-scope gating reads had flipped tool activation, discovery, and error paths when the suite ran inside a spawned subagent.
- **`tests/permission-gate.test.mjs` symlink preflight** checked bare `existsSync` — a leftover empty `node_modules/@earendil-works/` dir skipped link creation and crashed the module import; now validates `package.json` resolvability and clears the stale dir.

Measured: `npm run typecheck` exit 0; unit 156/156 (clean env) and 155/155 under a simulated `PI_SUBAGENT_*` env; `system-prompt-mode` 21/21.

## [1.22.0] - 10-07-2026

### Added

- **Subagent tools gated by default** (`extensions/subagents/index.ts`): `subagent`, `subagent_message`, `subagents_list` register with `defaultActive: false` in top-level sessions (pi's native deferred activation) — zero prompt tokens until a trigger: `/subagent on` / `/subagent off`, any `/subagent <agent> [task]` spawn (auto-enables), or `PI_SUBAGENTS=1` at process start. Subagent sessions always register active (the child's `--tools` sandbox governs). +5 unit tests: registration gating, both env variants via cache-busted re-import, and the command toggles.
- **Integration harness spawn-tool opt-in** (`tests/subagents/integration/harness.ts`): `startPi` injects `PI_SUBAGENTS=1` so integration sessions start with the tools active — the first live rerun without it showed models echoing spawn tasks instead of calling the hidden tool (and one false pass where the parent ran the marker-file echoes itself via bash).
- **`/subagent` auto-routing** (`extensions/subagents/index.ts`): the agent argument is optional. Prose input picks the first known agent name in the phrase (`/subagent use the worker to fix X` → `worker`); when no agent is named at all, the command activates the spawn tools and asks the session model to route by task content (`subagents_list` → `subagent`) — same one-turn cost as the named path, no keyword heuristics. Replaces the hard `Agent "…" not found` error.

### Changed

- **Subagents extension is now first-party** (`extensions/subagents/`, vendored from `pi-extension/` of `amosblomqvist/pi-interactive-subagents@c3e8b53`, itself a tmux-only fork of HazAT's): both former `patches/*.patch` folded into the source — detached `pi-agents` tmux session + tmux ≥3.0 compat, and permission-gate re-enabled inside sandboxed spawns (also repairs the drift where that patch was not applied live); `status.ts` config paths re-anchored to the extension dir; tests moved to `tests/subagents/` with import paths fixed and three upstream test defects repaired: the env-dependent `getToolExtensionPath` test made hermetic (failed on any machine without `~/.pi/agent/extensions/web-search/` — confirmed failing on the pristine checkout too), the fork-mode test retargeted to the real API (it instructed a `fork: true` tool param the schema never had — fork mode is agent frontmatter `session-mode: fork`, exercised via a new `test-fork` agent), and the harness now rewrites the pinned haiku child model to `PI_TEST_MODEL` plus sizes the detached test session wide, re-joins hard-wrapped tokens in `waitForScreen`, and routes over-width commands through `sendLongCommand` so markers don't wrap.

### Removed

- **Patch machinery and package indirection**: `patches/` (update.sh + both .patch files), the `git/` clone, the `settings.json` `packages` entry, and the `git/` gitignore rule — `pi update --extensions` can no longer wipe local modifications; upstream updates are a manual diff against the vendored import. Root `package.json` gains test-resolution devDeps only (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`).

### Fixed

- **`activateSpawnTools` duplicate names**: a session started with a partial `--tools` set (e.g. `pi --tools subagent`) could push duplicate names into `setActiveTools` on `/subagent on`; the merge is now deduped via `Set`.

Measured: unit 155/155 PASS (148 upstream + 7 gating/command tests); `system-prompt-mode` 21/21; integration with real pi + zai/glm-5.3 in a 220-col detached tmux — lifecycle 7/7 (spawn+steer-back, stalled-status, parallel, fork-linked session, caller_ping, project-agent discovery, systemPrompt) and tmux-surface 7/7; tree diff vs the patched checkout shows only the intended deltas (extra-extensions patch fold, gating block, status.ts path re-anchor); fresh `pi -p` smoke loads the extension clean with no package conflicts.

## [1.21.0] - 10-07-2026

### Added

- **R1 coverage resume hydration** (`permission-gate.ts`, Feedbacks.md suggestion A): `session_start` now replays the session branch's read/write tool entries through the same `certify()` path, so dup-read coverage survives `--continue`/resume/fork/reload (2026-10-05 audit: 258 dup reads / ~3,089K across 95 sessions — post-resume reads were the untracked slice). Source of truth is `ctx.sessionManager.getBranch()` (pi's in-context projection — fresh sessions no-op naturally; `--continue` fires reason `"startup"`, which ruled out the `previousSessionFile` design found by live probing); post-compaction slice only; edits skipped (anchor-derived spans — skipping loses savings, never adds a false block); R10 skipped (10-min window); stat-mismatch still gates staleness lazily.
- **`patches/update.sh`** — the package-update wrapper: runs `pi update --extensions`, then re-applies every `patches/*.patch` to the pi-interactive-subagents clone (already-applied detected via reverse-check and skipped; a patch that no longer fits fails loudly with exit 1). `--no-update` = verify/re-apply only. Replaces the manual wipe-recovery dance documented in README (now updated to point here); verified both live paths — real `pi update --extensions` run through the wrapper (patches detected as applied, tree intact) and the earlier fresh-apply round-trip.
- **Violation-memory NDJSON store**: blocks append `{"family","n","ts"}` lines to `~/.pi/agent/logs/violation-memory.ndjson` (aggregated at load; legacy JSON blob stays as a frozen read-only base; torn tail lines tolerated) — replaces the read-modify-write JSON blob whose last-writer-wins race became real once subagent panes got gated (parallel writers).
- **Gated subagents** (`patches/pi-interactive-subagents-extra-extensions.patch`, 24 lines): `applySandboxToParts` re-enables extra extensions inside the `--no-extensions` sandbox — default `~/.pi/agent/extensions/permission-gate.ts` when present (computed from `homedir()` at runtime — no absolute path in the patch), `PI_SUBAGENT_EXTRA_EXTENSIONS` colon-separated override. Subagent panes had been fully ungated (discovered by the 10-07 live probe: plain `cat` never blocked there).

### Fixed

- **Unquoted backslash escapes in both gate scanners** (Feedbacks.md review): `firstUnquotedPipeOrRedirect`/`splitSegments` honored `\` only inside quotes — `rg -o foo\|bar x | head` truncated R10 bases to `rg -o foo\` (two *different* patterns falsely blocked as identical re-runs) and `sed -n 1p\;5p f` split into a non-batch segment, falsely R2-blocked. Both scanners now treat unquoted `\x` as a literal; heredoc-bodies-count-as-unquoted limitation documented on both.
- **Violation-memory robustness** (same review): lesson injection hardened with `appendSystemPrompt ?? ""` — pi seeds `""` today, but an undefined contract would have leaked the literal `undefined` into the system prompt; colon-less block reasons no longer produce a truncated family key via `slice(0, -1)` (latent — all 10 call sites emit colon prefixes today).
- **R10 `2>&1` strip** `\s\d>&\d\s?` → `\b\d>&\d\b\s?` (strips at command start too); **`memoryInjected` → `memoryInjectedThisProcess`** — name now matches module scope (injection stays suppressed across in-process session replacement, e.g. `/handoff`; documented).

Measured: fixtures 43 → **51/51 PASS** (+4 unquoted-backslash, +4 hydration: prior-full-read block, changed-on-disk pass, pre-compaction pass, prior-write block; memory fixture rewritten for NDJSON); strict `tsc --noEmit` clean; live checks — two fresh headless sessions (R2 cat block; R10 identical escaped-pipe re-run blocked, base intact past `\|`), `pi --continue` resume E2E (re-read blocked, span 1–342 correct), patch round-trip identical, and a fresh-parent `gatecheck` subagent spawned with `-e …/permission-gate.ts` whose `cat README.md` was blocked (Reading line in the new ndjson, ts matches). Prefix unchanged (AGENTS.md 5,826 B; 23 skills; 1,438 desc chars) — cache-stable.

## [1.20.0] - 10-06-2026

### Added

- **`tests/block-recovery-audit.mjs`** — measures what the model does after a permission-gate block across logged sessions: family counts, message-size distribution (median/mean/p90/max), one-shot recovery rate (next event = corrected call), same-family re-blocks. Exit 1 below 85% recovery on a ≥10-block sample — regression gate for message changes. Baseline at introduction: 56 blocks, 98% one-shot recovery, median 178 / max 2,250 chars.
- **Violation memory** in `permission-gate.ts` (cross-session repeat-offender lessons): every block persists a per-family count to `~/.pi/agent/logs/violation-memory.json` (`PGATE_MEMORY` overrides; delete to reset); on the first `before_agent_start` of a session, families with ≥5 all-time blocks (top 3) get a one-line lesson injected into `systemPromptOptions.appendSystemPrompt` inside `<violation-memory>` tags — once per session, corrupt-file safe. Counts live in the file, lesson text in `FAMILY_LESSONS` in source. Verified via `/tmp/vm-probe/vm-probe.mjs` — 5/5 spec checks (top-3 selection, below-threshold no-op, once-per-session, count persistence, corrupt-file resilience); independently re-verified 2026-10-07 via a spawned worker subagent in the detached `pi-agents` session (tmux 3.0a) — 5/5 PASS, exit 0, no anomalies.
- **`extensions/handoff.ts`** (adopted from the upstream example, adapted): `/handoff <goal>` — model-summarizes the session branch (compaction-aware) into an editable transfer prompt, persists it as a human-readable doc `~/.pi/agent/handoff/<YYYY-MM-DD>-<goal-slug>.md` (`-2`, `-3`… on collision; `HANDOFF_DIR` overrides the dir), then opens the new session with the prompt as draft; doc-write failure never blocks the transfer. Imports trimmed to the resolvable `@earendil-works/pi-coding-agent` surface (no `pi-agent-core`/`pi-ai` sibling imports; `node:crypto` instead of `uuidv7`). Verified: strict tsc clean, stubbed-registration smoke + filename/collision/fallback checks.
- **24 new fixture cases** in `tests/permission-gate.test.mjs` (19 → 43): quoted-`|` R10 base non-collision, identical quoted-pattern re-run still blocked, full `SKILL.md` same-session re-read blocked (closes the skill re-invocation feedback item — R1 coverage already enforces it), post-compact re-read allowed; +3 violation memory; +16 family gap-fill (Anchor Guard existence/uniqueness/overlap, R2 cat/sed-batch, R5 git log, R6 rg -o, R7 ls -R, R8 hooks cap, R9 commitlint, runner cap — block+pass each). The runner now also asserts block reasons ≤220 chars (≤800 for Anchor Guard).

### Changed

- **`permission-gate.ts` block-reason diet** (Feedbacks.md personal feedback): every block message capped ≈200 chars — rule prefix + one corrective sentence + exact fix. Grounding: session audit showed 90% one-shot recovery; verbose text persisted in context ~2.6× for the rest of the session. Anchor Guard keeps the file snippet on anchor-miss (Aider-proven "did you mean" recovery context) trimmed to ≤8 lines, pad 2; R10 drops CI-specific advice; commitlint examples cut to one.
- **R10 quote-aware base extraction** (bug found live while auditing): base command was split at `|`/`>` quote-blind — a `|` inside a quoted regex pattern truncated the base, false-positive-blocking two *different* rg commands as identical re-runs (reproduced in-session 2026-10-06). New `firstUnquotedPipeOrRedirect()` scanner with escape handling; fixture-tested both directions.
- **Quote-aware segment splitting** (bug found by the new sed-batch fixture): `splitSegments()` split at every `\n && ; ||` quote-blind — `sed -n '1p;5p'` truncated to `sed -n '1p` and was falsely R2-blocked. Splits now happen only at unquoted separators.
- Docs: main `README.md` Subagents section gained spawn-failure triage (unpatched-package vs missing-binary symptoms — the detached-tmux patch had been wiped from the clone and was re-applied); `extensions/README.md` packages line corrected (`pi-interactive-subagents` is installed, not "none").
- `pi-interactive-subagents` local patch regenerated: marked-pane lookup now works on tmux ≥3.0 (drops the ≥3.2-only `list-panes -f` filter — lists unfiltered with `#{pane_marked}`, filters in-process, marks the base pane itself when none is marked). OS-agnostic: identical behavior on macOS brew tmux 3.5 and distro apt tmux 3.0. Patch round-trip verified (regenerate → stash → apply → identical).

### Fixed

- **`mdcmdcheck` v2.1** (BINARY NOT FOUND false failures, 9 → 0, exit 0 again): `var=$(…)` substitution assignments misparsed the substituted command as the head token (`tag=$(gh api …)` → binary `api`) — new `stripSubst()` strips a leading run with quote/paren depth counting, applied in `headTok` and `subCmd`; sourced shell functions (`nvm`) allowed (never visible to `command -v`); root `git/` external clones skipped by the walk; `CHANGELOG.md` inline commands skipped (history, not declarations — now also `HANDOFF-*.md` and generated `handoff/` docs; binaries from past environments need not exist here); absolute `/tmp/` refs (on-demand downloads like actionlint) demoted to an info-only list. Also `prompts/ship.md`: literal `git status --stat` in do-not-run prose rephrased (checker parsed it as a declaration).

### Evaluated

- **Auto-cap via `tool_call` input mutation (parked handoff item) — not adopted.** Would replace blocking for cap-type rules (R5/R6/R8/runner) with rewriting the command before execution. Rejected: the A/B is underpowered by construction (cap-family blocks are a small subset of 56 historical blocks — ≥30 events per arm would take weeks-to-months), the incumbent already measures 98% one-shot recovery at ≤220-char reasons, and command-rewriting is the exact quote-blindness bug class fixed twice this release. Revisit trigger: `tests/block-recovery-audit.mjs` shows cap-family blocks >10/week or one-shot recovery <90%.
- **`web-search` + `pre-push-review` set manual** (`disable-model-invocation: true`, user directive): auto-invocable set 4 → 2 (`ponytail`, `systematic-debugging`); README table + invocation counts updated; permanent prefix ~3.4K → **~1.7K tok** (AGENTS.md 5,826c ≈ 1.5K + 2-entry catalog ≈ 0.9Kc). `agents/reviewer.md` keeps its explicit `skills: pre-push-review` declaration (explicit loads bypass the auto-hide flag; `/skill:<name>` still works for both).
- **Docs synced**: `extensions/README.md` (R10 row, message-diet paragraph, audit script in verify list), `Feedbacks.md` (both personal-feedback items marked resolved with mechanism + verification), `README.md` (skills table, auto-invocable count, token-budget section).

## [1.19.0] - 10-06-2026

### Added

- **`/update-changelog` prompt (`prompts/update-changelog.md`)** — new slash command: updates CHANGELOG.md from session context only (no git tools); existing file pattern wins, Keep a Changelog + SemVer fallbacks; bumps only past the committed version and keeps updating it until committed; minimal 8-line body, new section ≤500 tokens.

## [1.18.0] - 10-06-2026

### Added

- **`skills/web-search/`** — merge of `tavily-search` + `tavily-extract` (both removed): one auto-invocable entry with a "pick the verb" router (no URL → `tvly search`, known URL → `tvly extract`), shared install step, both option tables, budget rule kept. `allowed-tools: Bash(tvly *)` preserved. Net catalog cost ≈ +70 tok vs the old tavily-search desc; extract becomes model-reachable (was hidden, so `tavily-search`'s `(→ tavily-extract)` pointer dangled).
- **`systematic-debugging` model-visible** (`disable-model-invocation` dropped, later set `false` explicitly): its description now carries today's evidence — recurring errors that survive fixes, TS2345/TS2304 classes, tests importing nonexistent modules. New **Error-Class Loop** section: second occurrence of an error class → `rg` the pattern repo-wide, fix the class as one change, run the narrow check once (today: TS2345 ×6, TS2304 ×5, "Unexpected comma" ×4 patched instance-by-instance across turns).

### Changed

- **Leading-word triggers added to 9 descriptions** (phrasings LLMs route on, drawn verbatim from today's issue titles): `auth` +'session outlives backend token', 'jwt sliding session', 'signOut on every 401', 'random sign-outs', 'signed out while browsing'; `systematic-debugging`, `map-integration` +'api key in client bundle', 'hardcoded barikoi key' + checklist #9 (no key literals in bundled config, `NEXT_PUBLIC_*` = public, server-side via proxy — issue #5); `playwright-tester` +'untested critical paths'/'no e2e coverage' (issue #53); `refactoring-ui` +small UI defects (issue #46); `browser-tools` +'verify UI fixes in the running app' (today's UI fixes shipped on typecheck alone); `pre-push-review` +'review my diff', 'pre-push check'; `ponytail` +dead code shipped/duplicated logic (issues #48/#50/#51).
- **Body lessons**: `auth` — 401-ladder bullet + checklist now mandate single-flight signOut (never per-request listeners; one expired token → N parallel 401s → N sign-outs — issue #44) and a typed session-user accessor (issue #42).
- **`ponytail` + `ponytail-review` merged** (ponytail-review removed): description covers both trigger sets; body gains **Review mode** — `L12:tag` format (`delete:`/`stdlib:`/`native:`/`yagni:`/`shrink:`), examples, `net: -N lines` scoring, `Lean already. Ship.`, review scope; `stop ponytail-review` still honored.
- **Explicit `disable-model-invocation` on all 23 skills** (user directive), then same-day trim: initially 11 × `false` (auto), final **4 × `false`** — `web-search`, `systematic-debugging`, `ponytail`, `pre-push-review`; user directive returned `auth`, `github-actions`, `documentation-writer`, `grilling`, `research`, `prototype`, `domain-modeling` to manual (`true`). Invocation state now visible per file instead of inferred from absence.
- **`github-actions`: Dependabot removed** (user directive) — pin-note clause, two bullet clauses, and §9 (`.github/dependabot.yml` recipe) deleted; sections renumber cleanly 1–8.
- **Cross-refs repointed**: `browser-tools` (desc + §body) and `fallow-audit` (desc) now reference `web-search` / `ponytail review mode`. Historical mentions in `harness-engineer` assets + older CHANGELOG entries left as records.
- **README synced**: badge 25→23 skills; auto-invocable prose corrected to the actual set (had missed auth, github-actions, pre-push-review, documentation-writer), then re-trimmed to the final 4; `github-actions` row added to the table (was absent); floor badge ~2.5K→~3.0K→**~2.1K tok** (chars÷4: AGENTS.md 5,826c + 4-entry catalog ≈ 2.4Kc); floor target row re-anchored to ≤ ~2.2K tok with the 2→11→4 auto-skill history noted.

### Removed

- `skills/ponytail-review/` (merged into `ponytail`), `skills/tavily-search/` + `skills/tavily-extract/` (merged into `web-search`). Skill count 25 → 23; no dangling references in live skills (verified).

## [1.17.0] - 10-06-2026

### Added

- **R10 identical re-run guard (`extensions/permission-gate.ts`)**. From the 2026-10-06T121014Z session audit (`~/.pi/agent/audit-reports/`, outside this repo): `gh run list` double-poll 31 s apart (session 01a11091…, dropx-merchant) and identical `npx vitest run` re-runs between one-line edits (3856d2a7…, 186/186 single-tool turns); 15 bash dups across 8 sessions that day. Blocks a bash call whose base command (command up to the first pipe/redirect, `2>&1` stripped) already ran ≤10 min ago with **no intervening edit/write** — the output is already in context. Exempts watchers (`watch`, `tail -f`, `sleep`, `--watch`) and retries of failed runs; the run is recorded on `tool_result`, cleared on `session_compact`; every successful edit/write bumps a mutation counter, making verify re-runs legitimate. Block reason carries the fix (`gh run watch <id> --exit-status` for CI waits). 6 new black-box cases (19 total).

### Changed

- **`AGENTS.md` Token Economy + `skills/pre-push-review/SKILL.md`** — matching guidance for what R10 enforces and what it can't: gh-consult ladder (`gh search issues`/`gh issue list --json number,title` to browse; capped `gh issue view` for one-shot reads; per-issue dump files only for repeat consults, then `rg` — never concatenate issues into one file or page-scan), generated dumps one file per unit, repeated-block files get widened `oldText` anchors, verify commands re-run only after an edit that could affect them. "Enforced by permission-gate" list now names the re-run guard. `pre-push-review` gains one line: its body is in context once loaded — never re-read the file from disk in-session (that skill is the most-fired, 34 sessions; 13K in-session re-reads measured 10-06). A same-day `gh-issue-triage` skill was considered and dropped — catalog bloat + firing risk; the ladder lives in AGENTS.md instead.

### Fixed

- **`tests/permission-gate.test.mjs` harness race — suite red at HEAD (6/13) since the committed mtime+size freshness change shipped without a test re-run** (that change also lacked a changelog entry; its behavior is folded into the R1 row of `extensions/README.md` this release). The `read`/`edit` helpers fired `tool_result` without `await` — harmless while certify was synchronous, but `await stat()` before certify deferred population to a macrotask after the probe's `tool_call`, so every R1 "blocked" case raced to `prior: undefined`. Awaiting the dispatches makes coverage population deterministic. Stale fixture `git add` (names the file, doesn't modify it — correctly blocked under the stat model) replaced by a real external on-disk change (`appendFileSync` standing in for codegen/other-terminal writers). Stale reset clauses ("a bash command naming the file's basename") corrected in the gate docblock and both READMEs to the stat-mismatch design. Verified: 19/19 pass, `tsc --noEmit` clean.

## [1.16.11] - 10-06-2026

### Changed

- **tmux agents-only — main terminal never runs through tmux**. User request: `tmux new -A -s pi` for the main terminal shared one fixed session across projects (opening pi in a second project reattached the first project's session). Now: `pi-interactive-subagents` reinstalled (same commit pin) and patched locally (`patches/pi-interactive-subagents-detached-tmux.patch`, preserved in this repo because `pi update --extensions` re-clones and wipes the clone under `git/` — re-apply with `git apply` from the clone dir, documented in README §Subagents). Patch scope: `tmux.ts` only — `isTmuxAvailable` drops the `$TMUX` env requirement (binary on PATH suffices), and `createSurface` splits from `$TMUX_PANE` when pi is inside tmux (unchanged), else lazily creates a dedicated detached session `pi-agents` and splits panes there (`rebalance` targets its base pane). Watch agents with `tmux attach -t pi-agents`, detach `Ctrl+b d`; the session stays out of the way otherwise. `bin/pi` wrapper already ran pi plain outside tmux — unchanged. README: §Subagents install block now includes the patch re-apply step; per-machine setup step 3 rewritten (tmux agents-only, explicit warning against `new -A -s pi` for the main terminal). Verified: patch round-trips on a pristine clone (`stash → apply --check → apply → identical diff`); e2e outside tmux (`env -u TMUX -u TMUX_PANE`): session auto-created, pane split, command sent and observed via `capture-pane`, pane closed, layout rebalanced. Upstream `npm test` unrunnable pre-existing (test-only dep `@mariozechner/pi-tui` absent from vendored node_modules) — not caused by the patch.

## [1.16.10] - 10-06-2026

### Changed

- **Subagents off by default — `pi-interactive-subagents` package removed**. Reverses the always-on adoption of [1.16.8]: `pi remove` from `settings.json` → `packages` (now empty), clone under `git/` gone via `pi update --extensions`. Zero per-session cost (~1K tok tool defs + the model's spawn-on-own-initiative possibility both eliminated); when delegation is wanted: `pi install git:github.com/amosblomqvist/pi-interactive-subagents@c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7` (pin from [1.16.8]), then `/reload`; remove again when done. Behavioral guard added to `AGENTS.md`: never spawn subagents unless the user explicitly requests one in the current session. Interim `subagent-mode.ts` blocking extension (built this session, `/subagent-mode` toggle) was deleted — uninstall supersedes it, no duplicates. `agents/` overrides (scout/researcher/worker/reviewer) stay — plain definitions, inert without the package. Main `README.md` and `extensions/README.md` updated accordingly.

## [1.16.9] - 10-06-2026

### Changed

- **README subagent-mode docs completed (docs-only)**. Main `README.md`: new `## Subagents` section (tools, auto-steer results, `ask_question`, tmux requirement, 4-agent table, override/nesting rules, package README pointer); stale facts fixed — skills count 24 → 25 (badge + tree + intro prose), `settings.json` row no longer claims `packages` empty, always-on floor restated ~1.5K → ~2.5K tok (1.5K core + ~1K subagents tool defs, both measurement dates kept), quick-start `cp office:…` → `scp` (was not runnable), first-run regen lists now include `git/`. `extensions/README.md`: extensions-vs-package boundary note (subagents = commit-pinned pi package under `git/`, tool defs DO enter the prefix — unlike extensions). Done via two parallel worker subagents, verified in parent.

## [1.16.8] - 10-06-2026

### Added

- **`pi-interactive-subagents` adopted — ALWAYS-ON (final)**. Same-session decision history: always-on → opt-in (`pi remove` + `/subagents` launcher) → back to always-on, on the user's judgment that ~1K tok/session is immaterial vs. context-isolated delegation (reviewer checks pre-push diffs in its own pane; main session stays lean). Declared in `settings.json`: `pi install git:github.com/amosblomqvist/pi-interactive-subagents@c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7` (repo has no tags → commit pin; clone machine-local under `git/`, `pi update --extensions` re-clones — verified). Adds `subagent`/`subagent_message`/`subagents_list` + `/subagent`. Spawning requires pi inside tmux (`tmux new -A -s pi`); outside tmux tools exist but spawns fail with a setup hint. The `/subagents` launcher extension built for the opt-in phase (tmux `respawn-pane -k` restart + `--session` resume — plain spawn+exit resurrected the parent shell as a second TTY reader) was verified e2e and then removed with the final decision; same for a workflow-specific `/issue` prompt template.
- **`agents/` global overrides (scout, researcher, worker, reviewer)** — the bundled defs were unusable here: they pin a model under `openrouter/` (provider not configured) and `web_search`/`web_fetch` (backing extensions absent → tools silently not granted). Overrides declare **no `model`** — sub-agents inherit the harness default from `settings.json` (`params.model ?? frontmatter.model ?? pi default` — verified in source; spawn-time `model` param still overrides), so agents don't rot when the default model changes. `researcher` retooled to `bash` + `tvly` CLI (search/extract, 2–3 call budget); `worker` keeps `read, write, edit, bash` + `subagent_agents: scout, researcher`; `scout` keeps read-only tools. **`reviewer` is new** (no bundled counterpart): read-only pre-commit review — `git diff HEAD` + callers + narrowest check, auto-loads the `pre-push-review` skill, emits APPROVE/REQUEST_CHANGES; explicitly forbidden from committing/pushing. Discovery priority project > global > package keeps them authoritative.
- **tmux 3.7c installed** (brew) on this machine; Linux boxes run `sudo apt install tmux` (README per-machine setup step 3).
- Measured (final state): first-turn context 4,133 plain → **5,181–5,187 always-on (+1,048 tok, accepted)**; tool defs 4 → 7; plain `pi -p` lists all four agents with the global overrides. E2E in tmux: scout spawned in a split pane (15s, $0.008), result steered back and woke the parent (98.4% cache); launcher e2e: conversation + 97.7% cache survived a respawn-pane restart (then removed). AGENTS.md unchanged (4,980 B); skills unchanged (25 dirs / 1,713 B descriptions); portability hits 0 (functional files).

## [1.16.7] - 10-06-2026

### Removed

- **ast-grep discipline retired** — AGENTS.md construct-shape bullet deleted, permission-gate R10 removed (rule, helpers, `existsSync` import, header trails), session-audit astgrep aggregation + views block dropped (the metric measured a rule that no longer exists). rg is the single search tool again.
- Global `@ast-grep/cli` npm package uninstalled from this machine (npm globals do not ride dotfile sync — repeat on the Linux box if it was installed there).
- **AGENTS.md deduplicated against permission-gate** — dropped prose the extension already enforces with corrective block reasons (`oldText` anchor validity, covered re-reads, `cat`/`sed -n` viewing); the "Enforced by permission-gate" pointer line remains the sole carrier. Ponytail ladder bullet stays — always-on floor; the skill's body is load-on-demand, only its description rides the prefix (2026-09-15 A/B: overthinking rose without the rungs in-prefix).
- **`ponytail:` comment-prefix convention dropped** — clause removed from AGENTS.md + ponytail SKILL.md Rules; existing prefixed comments normalized to plain comments (permission-gate, extensions README, skillcheck.sh). CHANGELOG history untouched.
- Measured: `node tests/permission-gate.test.mjs` 13/13 PASS; `tsc --noEmit --strict` clean for permission-gate.ts (residual errors are upstream .d.ts noise in the pi package); `node --check` + `bash -n` clean on the audit scripts; mdcmdcheck failures pre-existing and untouched (gh/actionlint binaries absent from this machine — github-actions skill only).

### Changed

- **ponytail skill: persistence logic removed + "lazy" vocabulary retired** — dropped the `## Persistence` section and "level persists until changed or session end" (pi skills are load-on-demand: once the body is in context it simply governs; cross-response mode tracking was fiction from the Claude-Code era). Fixed `/ponytail` → `/skill:ponytail` (pi's real invocation syntax; `argument-hint` kept — verified parsed by pi's slash-commands). Replaced instruction wording "lazy" with terms LLMs parse precisely (minimal / YAGNI / root-cause / shortest diff); "be lazy" survives only as a user-trigger phrase in the description (routing quotes user vocabulary, not model behavior). Section "When NOT to be lazy" → "What never to cut"; description updated to match. AGENTS.md ladder bullet's `/ponytail` reference corrected to `/skill:ponytail`.
- Measured: SKILL.md 6,894 → 6,765 B; description 398 → 344 c (≤250-token health rule); body "lazy" occurrences 9 → 0; persistence remnants 0; frontmatter valid (name/dir match, all fields parse).
- **AGENTS.md vocabulary: coined phrases → canonical terms LLMs parse reliably** — "Solve with the least that works" → "Do the simplest thing that works" (XP maxim), "unrequested abstractions" → "speculative generality" (Fowler's term, already the skill-description vocabulary), "define the failing case" → "reproduce the failure first" (canonical debugging), "BSD∩GNU intersection"/"BSD∩GNU flags" → "portable BSD/GNU subset"/"flags" (drops the math symbol), "speculative previews" → "speculative status checks". Proper nouns (Ponytail ladder, permission-gate) untouched.
- Measured: AGENTS.md 4,690 → 4,706 B (+16 B ≈ +4 tok); 6 phrase swaps across 5 lines, zero rule changes.
- **AGENTS.md ponytail bullet: intensity-switch syntax dropped** — "(always active; default full, `/skill:ponytail lite|full|ultra`)" → "(always active)": completes the persistence removal. Levels, default, and `/skill:ponytail` invocation live in the skill (its description already advertises the modes); AGENTS.md carries only the always-on ladder floor.
- Measured: AGENTS.md 4,706 → 4,657 B (−49 B).
- **Partial revert: Reading/Editing bullets restored to AGENTS.md** — the dedup had dropped the proactive `read`-windowing and `oldText`-anchor prose; restored verbatim. Rationale: the extension blocks a violation after the fact (a failed call costs a retry round-trip), the prose prevents the miss on the first call — both layers stay, pointer line unchanged.
- Measured: AGENTS.md 4,657 → 4,937 B (+280 B).

## [1.16.6] - 10-06-2026

### Removed

- **telemetry & audit redesign** (design doc removed post-implementation; decisions recorded here) — deleted `extensions/error-telemetry.ts` + `extensions/session-learnings.ts` and their stores (`logs/`, `learnings/`): pi natively records all raw session events in `sessions/*/*.jsonl` and the audit toolkit derives every signal from there, so the two always-on extensions were maintenance without unique value (accepted losses: provider-HTTP-error and compaction-failure capture, `/errors` command). Extensions reduce to `permission-gate` only. Audit flow rebuilt: `audit-reports/{harness,skills,sessions}/` taxonomy (every filename carries its date and topic; every header records OS/machine provenance via `uname -srm` + `uname -n` for the office/home machines; machine-local and gitignored — reports name private projects and the repo is public; the 14 formerly-tracked flat reports untracked, root `harness-audit-report.md` dropped as a byte-identical duplicate of `harness/2026-09-23T175246Z-full.md`, root `skills-audit.md` moved into `skills/` as the append-only record), `audit-reports/.watermark.json` with a single per-machine `auditedThrough` timestamp (session-mode audits scope to newer sessions only; a counts field + stop-and-ask integrity protocol were rejected — the timestamp already makes deletion harmless), 30-day session prune at audit close; `.gitignore` `sessions/` anchored to `/sessions/` + `/audit-reports/` added. Scrubbed: harness-engineer Audit-mode step 0 (learnings drain → watermark check) + new close step (advance watermark, prune), `error_audit.py` `--live` mode, README/extensions-README references, dead `.gitignore` rules.
- Measured: `node tests/permission-gate.test.mjs` 13/13 PASS; `node skills/harness-engineer/scripts/mdcmdcheck.mjs` exit 0; `error_audit.py` session mode unchanged on default run; extensions/ tree 1 file (was 3); model prefix untouched by design (extensions never load into it).

### Fixed

- permission-gate header comment: stray 2026-10-08 → 2026-10-05 (comment only, no functional change).

## [1.16.5] - 10-08-2026

### Changed

- **permission-gate: R10 construct-shape rg searches → ast-grep** — the 2026-10-05 audit found ast-grep discipline at 145/177 sessions rg-only (13 calls ever; nothing rejects it — gate, binary, PATH all clean): the model never *selects* ast-grep despite AGENTS.md prose carrying the instruction every turn. R10 blocks rg calls that initiate a construct-shape search (`ident\(` call sites, `=>` arrows, `<Uppercase` JSX) when scoped to code (`-g`/`-t`/code paths) or unscoped in a TS/JS-project cwd; the reason carries the exact rewrite (`ast-grep run -p 'fetchList($$$)'`), the bodyless-fragment pitfall, and the deterministic escape (re-scope to non-code globs, or non-first-party dirs — node_modules/dist/build/.next/coverage — passes untouched). Pipe filters (`git log | rg 'fix\('`) don't trip; grep-family uncovered. Escalation criterion (agreed): registered `code_search` tool only if trips exceed ~5/week in the TS project at the 2-week audit review, or escape-abuse beats compliance.
- Measured: 12-case harness against the live extension — calibration commands trip with rewrite reasons, all escapes (md glob, non-code path, node_modules, pipe filter) pass, R2 regression intact; `tsc --noEmit --strict` clean.

## [1.16.4] - 10-05-2026

### Changed

- **permission-gate: R1 recency window → session-lifetime span-union coverage** — the 2026-10-05 audit found read dup 258× / 3,089K across 95 sessions slipping past R1 through three structural gaps: windowed reads never registered in `lastInContext`, windowed-after-full was always allowed, and `REREAD_WINDOW = 6` expired late-session re-reads (the audit's "offset/limit evades the match" theory was close but the real leaks were these). R1 now tracks, per absolute path, the union of in-context line spans and blocks only reads whose requested window is **fully** covered — partial overlap passes (it brings new lines). Certificates: read results certified by their actual returned lines (`details.truncation.outputLines`; an untruncated whole-file read certifies 1–EOF), edit-result spans, whole file after `write`, images whole-file. Resets: `session_compact`, bash naming the file's basename, failed edit. Block reason names the covered span and the escapes (windowed read outside it, rg to verify). State moved inside the extension factory (per-instance, was module-level).
- ponytail: coverage is not hydrated on session resume — the map starts empty, erring toward allowing. Revisit only if the next audit's dup-read-targets table shows post-resume dups mattering.
- Measured: `node tests/permission-gate.test.mjs` 13/13 PASS (identical window, windowed-inside-full, full-after-full, post-edit span, image, relative-vs-absolute key all blocked; continuation, truncated-tail, partial-overlap, post-compaction, post-bash, no-details fallback all pass); `tsc --noEmit --strict` clean; `mdcmdcheck` exit 0; live post-reload smoke test blocked an identical re-read with the new reason text. Acceptance metric (next directory audit): DUP_TOOL_CALL 3,207K → under 1,200K.

### Fixed

- **permission-gate: fallback line count over-certified by one line** — live `tool_result` events carry no `details.truncation`, so the text-fallback path runs in production; it stripped the read tool's trailing `[N more lines in file…]` note but not the blank `\n\n` separator line before it, certifying one line past every windowed read's real content (live smoke test showed `1–11` for two 5-line windows). Now strips the note (both variants) plus the separator; fixture case added. Also noted: gate checks fire at `tool_call` time, so two identical reads inside ONE assistant turn cannot block each other — sequential turns block correctly.

### Changed

- **session-audit: the two stats the 10-05 report could not get** — `rules.mjs` DUP_TOOL_CALL read findings now carry `evidenceStats.path` (recorded at digest time — no per-session fetches, no budget change); `views` prints "Dup read targets (top 10 by waste)" and "BIG_TOOL_OUTPUT by tool". SKILL.md Phase 1 list synced. First render on a 60-session digest already localizes the habit: `/tmp/issues.txt` 6 dups / 518K / $0.73, `/tmp/prepush.diff` 320K — wholesale re-reads of big temp files, not source files.
- Measured: `audit.mjs run --max 60` + `views` renders both sections; empty digests degrade to `(no read dups)` / `(none)`.

## [1.16.3] - 10-05-2026

### Changed

- **AGENTS.md: guard-enforced mechanics trimmed to norms** — Token Economy rules that `permission-gate` already blocks with corrective text are no longer restated in the prefix: cat/sed viewing + batching exception (R2), re-read bans + ≤60-line-window detail (R1), oldText fuzzy-match spec (Anchor Guard), recursive walks + uncapped `git log` (R7/R5), runner cap recipes (the guard reason carries them), commit/push tail + hooks rationale (R8), `log --oneline` cap. Unenforced rules kept verbatim (npm install tail, git diff/show caps, general rg caps, no-re-run, cross-platform flags, safety, judgment), plus one breadcrumb naming what the gate enforces. Basis: `learnings/pending.md` — blocks in ~30 of 45 signal-runs with the rules present; the gate is the working mechanism, the text was not preventing.
- Measured: AGENTS.md 5,738 → 5,400 B (−338 ≈ −85 tok/session); prefix changed → fresh session advised. `audit_toolcall_rules.py` unchanged (audits session JSONLs, not AGENTS.md text). Revert trigger: any block family spiking in pending.md over the next week → restore that rule.
- **Tier 2 review: queue drained, no new promotions** — consumed all 48 pending.md runs (09-29..10-05) + 172 error-log entries (09-24..10-05). Top signal: R2 sed-viewing blocks 56× (+ cat 17×) — plausibly aggravated by the old AGENTS.md rule text naming `sed -n`; the 1.16.3 trim removes the mention, so watch the post-trim rate before adding anything. Anchor Guard 13×, re-read 7× (4× CHANGELOG.md post-edit — guard working as designed), runner caps 8×, git log 4×, rg -o 4×; zero provider/compaction errors, zero cache-unstable runs. npm-install/diff-show/general-rg gaps show no pain in logs → stay rules, no new guards.
- Measured: pending.md 55 → 7 lines (48 consumed); 172 log entries aggregated across 6 files; no code changed. Standing practice (user-directed 10-05): a Tier 2 review that has aggregated and recorded the signal clears `logs/` and `learnings/` — raw data dies after its `Measured:` line exists.

### Fixed

- **permission-gate: R7 false positive on quoted patterns** — R7 (recursive walks) tested raw segments, so a quoted search pattern containing `ls -R`/`find -exec` (hit live: `rg -n "…|ls -R|…"`) was blocked as a walk. Now tests the quote-stripped `bare` segment like R6, for both regexes.
- Measured: 6-case matcher test 6/6 PASS (falsely-blocked rg patterns pass; `ls -R`, `ls -laR`, `find -exec` still blocked). Live gate picks the fix up at next session start.

## [1.16.2] - 10-05-2026

### Added

- **permission-gate: R9 commitlint enforcement** — `git commit -m <msg>` calls are validated against the commitlint conventional pattern (`type(scope?): subject`; types feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert, header ≤ 100 chars, subject not capitalized, no trailing `.`) before the commit runs. Header rules only (body `-m` flags and `-F`/heredoc messages skipped). Checked ahead of the R8 hook-cap rule so a bad message never reaches git hooks. Measured: 9-case unit test of the matcher (9/9 PASS after body-paragraph fix); +55 lines in `extensions/permission-gate.ts`; AGENTS.md and skill descriptions untouched (prefix byte-stable except extension code).

## [1.16.1] - 10-05-2026

### Changed

- **Skill descriptions — leading-word compression** (missing-established-term audit): `auth` "whose identity provider is an external REST backend" → "against an external REST IdP"; "proxy/middleware route protection" → "middleware route guards". `ponytail` "speculative abstractions, one-implementation interfaces" → "speculative generality" (Fowler's term; single-implementation abstraction is his literal example — one term covers both). `ponytail-review` "speculative abstraction" → "speculative generality" (vocabulary alignment, zero chars). Rejected with reasons: `baseQuery` (covers only RTK Query, not the fetch layer), `wayfinder` → "epic" (imports build-slice semantics the skill distinguishes itself from), `brainstorming` → "Socratic" (loses the operational instruction), `grilling` → "red-team/steelman" (wrong meaning). 16 other descriptions already term-dense.
- Measured: desc total 6,218 → 6,150 chars (−68, ~17 tok/session); validator PASS ×3; AGENTS.md untouched (5,738 B); prefix changed → fresh session advised.

## [1.16.0] - 10-05-2026

### Added

- **`skills/wayfinder`** — new skill (COUNT 18 → 19) from mattpocock/skills: chart an effort too big for one session as a `wayfinder:map` issue + decision-ticket children on the repo's issue tracker; one ticket resolved per session until the route to the destination is clear. Manual invocation only (`disable-model-invocation: true`). Deliberately missing deps: sibling skills (grilling, domain-modeling, research, prototype) and tracker setup not installed — local-markdown tracker fallback covers it.
- Measured: skills 19 dirs, wayfinder desc 197 chars (auto-trigger cost 0 — manual only); validator PASS (exit 0); skills-audit.md 319 → 332 lines (append-only); README.md 284 → 285 lines (badge 18→19, intro, tree, table row, Last updated).

- **`skills/wayfinder` deps: grilling, research, prototype, domain-modeling** — the four sibling skills wayfinder's body invokes, from the same repo; all auto-invocable. With wayfinder and the pre-existing-but-undocumented `documentation-writer` (committed in c64f214 without a README row), COUNT 18 → 24. Upstream layout adapted to the local convention: domain-modeling's GLOSSARY-FORMAT.md / ADR-FORMAT.md and prototype's LOGIC.md / UI.md moved to `references/` with body links rewritten; `agents/openai.yaml` not copied (OpenAI-only). Remaining gap: tracker setup (`/setup-matt-pocock-skills`) still absent — wayfinder falls back to local-markdown tracker.
- Measured: skills 24 dirs, desc total 6,218 chars across all frontmatters; validator PASS ×6 (incl. documentation-writer); skills-audit.md 332 → 347 lines (append-only); README.md 285 → 290 lines (badge →24, intro, tree, auto-invocable line, 5 table rows incl. documentation-writer).

## [1.15.2] - 09-27-2026

### Changed

- **Docs sync (living map)** — `README.md`: Last updated 09-27; extensions tree/table rows + Extensions section now document `session-learnings.ts` and the self-learning loop (queue → Audit-mode step 0 drain → `Measured:` promotion); machine-local table gains `learnings/`. `skills-audit.md`: dated entry — usage audit 18/18 skills used, 135 invocations, 0 unused; data-gated pruning recommendation closed with evidence; health-score "count > 15: −10" flagged miscalibrated against measured 100% usage.
- Measured: README.md 278 → 284 lines (5 edits, zero command/path claims added beyond `learnings/` which mdcmdcheck treats as ~-path); skills-audit.md 307 → 319 lines (append-only); model-visible prefix unchanged (AGENTS.md 5,738 B, 18 descriptions byte-stable, 0 prompts); skills 18/18 used (skill_usage_audit.py, 135 invocations).

### Fixed

- **`extensions/session-learnings.ts`** — pre-push-review F1 (high): block-detection regex anchored `:$`, but permission-gate emits `Prefix: corrective text...` on one line — `blocks` would have stayed permanently empty (the extension's primary signal). Regex now `/^(Anchor Guard:|Token Economy \([^)]*\):)/`, family = match minus trailing colon. Verified: strict tsc clean; both §3 failure modes checked (prefix-only lines still match; real tool errors can't false-fire).
- **`tavily/session.json`** — pre-push-review F2 (low): tavily CLI port→hash state, mutated by tool usage; tracked by accident and the `git add -A` sync flow would commit it forever. Now gitignored next to `tavily/config.json` and untracked (`git rm --cached`, working-tree file kept).
- **`skills/harness-engineer/scripts/mdcmdcheck.mjs`** — pre-existing red, root-caused (F3): `git <sub> --help` emits man pages with overstrike formatting (15,180 backspace bytes on `git log --help`), so flag extraction missed every bold-rendered option — six permanent FLAG false-positives since those entries landed. Fix: strip char+backspace pairs before extraction (git-log flag set 153 → 371; `--grep`/`--oneline`/`--no-merges` now found). Plus CHANGELOG 1.12.0's inline "git commit|push" shorthand (pipe-split made `push` a phantom binary) → `git commit` / `git push`. `--help` exempted at validation (universal flag, absent from git man pages — this fix's own documentation tripped it). Measured: checker exit 0 — first time since 1.13.0's contract; MAC-ONLY info items remain deliberate (systematic-debugging documents macOS codesign flows).

## [1.15.1] - 09-27-2026

### Changed

- **`skills/harness-engineer/SKILL.md`** — Audit mode gains step 0: drain `~/.pi/agent/learnings/pending.md` first; recurring items (same rule family / tool / project / repeated `⚠cache`) are pre-ranked candidates, promoted via Workflow with `Measured:` lines, consumed lines deleted. Closes the discovery gap from 1.15.0: the queue's designated Tier-2 consumer had no pointer to it — a fresh audit session would have run the scripts and missed the queue (including the session that built it). Skill body only — loads on demand; description untouched.
- Measured: SKILL.md 120 → 121 lines (+1); skill description unchanged at 266 chars (0 prefix bytes — bodies are not model-visible until loaded, catalog byte-stable); skills 18, AGENTS.md 5,738 B, prompts 0 — all unchanged; mdcmdcheck failure set identical to pre-existing (BINARY 1 / FLAG 6 / SYNTAX 0 — no new findings).

## [1.15.0] - 09-27-2026

### Added

- **`extensions/session-learnings.ts`** — Tier 1 of the self-learning loop (learn-claude-code s09 pattern, cache-safe adaptation): deterministic per-run collector. On `agent_settled`, appends one line to `~/.pi/agent/learnings/pending.md` when the run has signal — tool errors (from `tool_result`), permission-gate blocks by rule family (from `tool_execution_end` reason prefixes; disjoint from `tool_result`, no dedupe), provider ≥400, ≥10 tool calls, ≥15 turns, or >100k tok with <40% cache-read (`⚠cache` prefix-instability flag). Zero model calls, zero prefix bytes, external storage. Tier 2: harness-engineer review promotes recurring items with `Measured:` lines and deletes consumed queue lines; never auto-edits AGENTS.md — the human gate is the admission check. Closes the loop's missing trigger: audit scripts previously ran only when manually invoked. Source: learn-claude-code repo analysis (this session).
- **`extensions/README.md`** — table row + `session-learnings.ts` section; `.gitignore` + `learnings/` (machine-local, `logs/` class).
- Measured: strict `tsc` clean (7.0.2 paths-mapped via ephemeral /tmp tsconfig; TS 7 removed `baseUrl` — recipe drops it, `paths` with absolute generated targets); model-visible prefix unchanged (AGENTS.md 5,738 B, 18 skills, 0 prompts — extension is runtime-only, loads at next session start); portability hits: 0 (`os.homedir()` paths only). Live evidence during the change itself: permission-gate blocked this session's own uncapped `npx tsc` — guard fired while building the collector that documents it.

## [1.14.0] - 09-27-2026

### Changed

- **AGENTS.md** — removed the four inline dated audit statistics (severity-only parentheticals; conditions and actions untouched): re-reads `(817K / 59%, 2026-09-14)`; single-call turns `(94%, 2026-09-14)`; long-session cost-tail `(2026-09-16 audit: 300+ turn sessions, $10–14 each)`; injected skill bodies `(2026-09-16: 7,952-tok first turn vs ~3k baseline)` → dateless magnitude (`~2.6×`). Undated severity phrases retained (`top measured waste`, `top cost-tail driver`). Rationale: a dated stat is a scheduled mutation — every audit pressured a prefix edit, violating cache-is-sacred; the numbers carry no conditional weight (this evidence now lives here and in `skills-audit.md`). AGENTS.md is now immutable-by-construction across future audits.
- Measured: AGENTS.md 5,835 → 5,738 B (−97 B, ~24 tok/turn); remaining `2026-` references in AGENTS.md: 0 (`rg -c` exit 1); skills 18, prompts 0, portability hits — all unchanged. Prefix changed → fresh session advised.

## [1.13.0] - 09-27-2026

### Changed

- **`extensions/permission-gate.ts`** — R1 windowed-overlap: anchor validation now returns each edit call's post-application line spans (exact-match anchors; cumulative line-shift for multi-edit calls; fuzzy-matched anchors contribute none — windowed checks fall back to allow for them), and a windowed read is blocked when it covers a just-edited span — the edit result already echoes the applied text. After `write`, every window overlaps (whole file in context). Closes the gap the 09-23 R1 guard left open by exempting all windowed reads: post-guard sessions re-read 1.4–6.8K `CHANGELOG.md` windows seconds after editing them (2026-09-27T074015Z audit, project `agent`: sessions 01a0d347 / 01a0d1f6 / 01a0d33a — 28K of the week's 56K waste). Legit paths stay open: windows beyond the edited lines, bash-touched files (freshness drop), failed edits, read-after-read windowed navigation. No behavior removed — one rule narrowed.
- **`extensions/README.md`** — R1 row and state description updated to the span-tracked model (also caught the row lagging 1.12.0's read-after-read).
- Measured: strict `tsc` clean (7.0.2, paths-mapped) + 12-case mock-driven behavioral suite 12/12 (full/windowed/write/shifted-span/fuzzy/failed-edit/bash-drop/read-after-read paths); model-visible prefix unchanged (AGENTS.md 5,835 B, 18 skill dirs, 0 prompt files) — extensions are runtime-only; portability hits: 0.

## [1.12.0] - 09-27-2026

### Changed

- **AGENTS.md** — Token Economy → Command output: `git commit/push` must append `2>&1 | tail -20` (repo hooks re-run lint/test/build; session audit 2026-09-27T071942Z measured 44–48K bytes per call in ubl-survey-dashboard — 5 hook dumps + 2 `git diff | head -c 45000` over-wide caps, 62% of that project's waste; directory-wide BIG_TOOL_OUTPUT 991K/$1.27). Git-read caps tightened to `head -c 4000`. +117 B.
- **`extensions/permission-gate.ts`** — R8: uncapped `git commit` / `git push` blocked with corrective pipe text (`--no-verify` exempt; a cap anywhere in the full command passes — heredoc messages split across segments). R1 extended read-after-edit → read-after-**read**: successful full reads now register in `lastInContext` (kind-tagged `{at, kind}`), a second full read within `REREAD_WINDOW` (6 calls) is blocked with kind-specific text — the audit's 17 read-dups were read-after-read, structurally invisible to the edit-keyed map (directory-wide read dupWaste 1771K). Source: 2026-09-27 audit. Verified: strict `tsc` clean (paths-mapped tsconfig per extensions/README recipe). Meta: the guard blocked this session's own first edit attempt (stale anchor) and an uncapped `npx tsc` — rules fired live during the change itself.
- **`skills/session-audit`** (installed bundle, no upstream repo — reinstall overwrites; diff kept minimal) — `views --project <name>` renders the per-project slice (sessions w/ full ids + per-session rates, findings by rule w/ sessions-affected, finding detail w/ evidenceStats, per-date trend) that previously cost 3–4 unlogged hand-rolled jq queries per audit; `fetch --kind tool_input --uuid` now anchors on the exact toolCall id with a `match:true` marker (was: ts-ordered tail window that silently ignored `--uuid` — anchoring immediately corrected this audit's rank-1 attribution: 2 of 7 BIG findings were `git diff | head -c 45000` over-wide caps, not hook dumps). SKILL.md Phase 1 documents the flag.
- **Repo fix (outside harness)**: `ubl-survey-dashboard/.npmrc` `loglevel=verbose` → `warn` — npm-verbose hook logging was the flood amplifier.
- Measured: AGENTS.md 5,718 → 5,835 B; skills 18 (unchanged); prompts 0; permission-gate.ts 12,327 → 14,147 B (lazy-loaded, zero prefix); portability hits 1 benign (AGENTS.md's own rule text). Next-audit targets: ubl-survey-dashboard BIG_TOOL_OUTPUT ≤2 findings/<20K (from 7/79.5K); read-dups <5 (from 17).

## [1.11.0] - 09-24-2026

### Changed

- **Extension consolidation** (upstream-convention alignment): `edit-anchor-guard.ts` + `token-economy-guard.ts` merged into **`permission-gate.ts`** — both were `tool_call` interceptors; one handler now runs anchor pre-validation, re-read freshness (R1), and bash economy rules in deterministic order, with validation preceding `pendingEdits` registration — a blocked edit can never enter the freshness map. User-preferred name `permission-gate` (blocks unconditionally, unlike upstream's confirm-style namesake — the planned commit/push confirmation gate stays `commit-gate.ts`); `error-log.ts` → **`error-telemetry.ts`** (kept after the 09-24 decision — it feeds the audit loop; renamed to name the observer role). Block-reason prefixes per rule family (`Anchor Guard:`, `Token Economy (…)`) unchanged. Rollback: restore the pre-merge pair from git HEAD.
- **`extensions/README.md`** (new, enriched) — per-extension docs modeled on the upstream examples README: role/hooks table, `permission-gate` rule catalog (R1/R2/R5/R6/R7 + anchor checks with reason prefixes and state model), `error-telemetry` capture table + `/errors` + audit-loop rationale, pi conventions (single-file/default-export, blocking vs confirming semantics, pi-native packaging via `pi install npm:<pkg>` → `settings.json` `packages`), verification recipe, adding-a-new-extension checklist, adoption-candidate shortlist; links https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions for future follow-ups.
- **Deleted `npm/`** — orphaned nested package (`opencode-pi`, `pi-session-analyzer`, `pi-token-burden`): zero callers anywhere in the harness, no `packages` declared in `settings.json`, gitignored/regenerable. Pi-native package mechanism is `settings.json` → `packages` (installs under `npm/`), *not* root `package.json` — root keeps repo tooling (husky/commitlint) only. `bin/` stays: pi-managed, auto-downloads arch-correct binaries (documented machine-local).
- Measured: strict `tsc` clean ×3 under new filenames; `mdcmdcheck` exit 0 (no findings from changed files); model-visible prefix unchanged (AGENTS.md 5,718 B, 18 skill dirs, 0 prompt files); portability hits in `extensions/`: 0.
- **Docs drift fix**: `bin/{fd,rg}` → generic `bin/` in `README.md` + `skills-audit.md` (`rg` absent from `bin/`; enumeration invites drift). Pre-push review (pre-push-review skill) run on the full uncommitted diff: medium (unverified changelog claim) and low (`-e`-form sed batching) fixed in place, all findings closed.

## [1.10.0] - 09-24-2026

### Changed

- **`extensions/edit-anchor-guard.ts`** — intra-call overlap pre-check: exact-match spans of verified anchors are compared pairwise; overlapping `edits[i]`/`edits[j]` are blocked naming the pair *before* the edit tool rejects the whole call (same failure class as anchor misses: one failed round-trip saved). Fuzzy-matched anchors excluded — their indices live in normalized space.
- **`extensions/token-economy-guard.ts`** — R7: recursive directory walks blocked with corrective text (`ls -R`/`--recursive`/combined `-R…` flags, `find -exec`/`-execdir`; redirected `ls -R > file` exempt) → `rg --files <dir> | head -N` / `rg -l`. Closes the last mechanically-checkable AGENTS.md searching rule ("no `ls -R`, `find -exec`"). R2 false-positive fix: `sed -n` with 2+ `;`-separated print regions (AGENTS.md-allowed batching) is no longer blocked — observed live this session (`sed -n '1,7p;108,120p'`).
- **Extension renames evaluated, none made** — all three names already match the upstream examples convention (`dirty-repo-guard.ts` guard family, noun-phrase loggers like `session-name.ts`); upstream `-gate` (`permission-gate.ts`) means user-confirmation gates, which these are not. Renaming would churn 6 referencing files (CHANGELOG, README, SKILL.md, two audit reports, `error_audit.py`) for zero functional gain. `error-log` enrichment (session id per record) skipped: `ExtensionContext` exposes no session identifier — not inventing an API contract.
- Measured: extensions are runtime-only — model-visible prefix unchanged before→after (AGENTS.md 5,718 B, 0 prompt files, 18 skill dirs, extensions 3 → 2 files); strict `tsc` clean (merged `permission-gate.ts` + `error-log.ts`); R7/R2 regexes smoke-tested (9/9 cases + edge fixes).

## [1.9.0] - 09-24-2026

### Added

- **`extensions/error-log.ts`** — deterministic tracking of every LLM runtime error. Hooks three events and appends to machine-local, gitignored `logs/errors-<YYYY-MM-DD>.jsonl`: (1) `tool_result` `isError` — bash exit≠0, edit anchor misses, fs errors; plus `tool_execution_end` `isError` for **blocked** calls (guard blocks, unknown tools) which never reach `tool_result`; (2) `after_provider_response` HTTP ≥ 400 — the LLM call itself failing (rate limits, auth, 5xx, with retry-after); (3) `session_compact_failed` (non-abort). Records `{ts, cwd, kind, tool/status/reason, input≤2KB, output≤2KB}`; `/errors [n]` (default 10) reviews the tail across days. External storage only — zero model-context cost, no prefix change; strict `tsc` clean. Motivation: recurring failures (e.g. 2026-09-24 `wc -l` pipeline + EISDIR read) were invisible outside live transcripts.
- **`skills/harness-engineer/scripts/error_audit.py`** — batch error mining over `sessions/**/*.jsonl` (default) or `--live` for the extension's daily JSONL. Joins `toolResult.isError` back to the originating `toolCall.arguments` via `toolCallId`; reports totals by tool/kind/project and top failing command heads. Baseline scan (2026-09-24): 397 errors / 134 sessions — bash=269, edit=117, read=11; top kinds: exit 1 ×149, token-economy blocks ×77, edit anchors ×62; worst project 111 errors.

### Changed

- **`skills/auth/`** — file-layout refactor: `lib/auth.ts` → `lib/auth/{index,options,session,routes}.ts` (import only from `@/lib/auth`, never deep paths), backend REST wrappers extracted to `lib/api.ts`; all references updated in lockstep. Policy hardened: session cookie maxAge now mirrors the backend JWT `exp` with **no fallback** — `authorize()` rejects tokens without a usable expiry instead of guessing 24h.

### Fixed

- **README.md** — skill map was stale at 17: `auth` (shipped with the 1.8.x auth work) missing from table/badge/intro → 18. Documented the previously-unmapped `extensions/` layer (3 extensions) in the tree + git tables, and the new gitignored `logs/`.
- `.gitignore` — `logs/` excluded as machine-local runtime data (same class as `sessions/`).

Measured: always-on floor unchanged — AGENTS.md 5,718 c, skill descriptions 1,682 c, prompts 0 (before = after; extension + script are non-prefix layers). Portability: 0 hits (homedir()-derived paths, stdlib only, no OS-only commands).

## [1.8.1] - 09-24-2026

### Fixed

- **skills/auth (SKILL.md + 4 references)** — two correctness holes found in review:
  - `callbackUrl` is a user-controllable query param: `router.push("https://evil.com")` navigates off-origin (open redirect). Skill now mandates sanitizing `callbackUrl` to a same-origin relative path before pushing; checklist and login-flow references updated.
  - 401 retry ladder retried even when nothing can rotate the token between attempts — with a static module-holder token the retry is byte-identical. Retry is now gated on a real rotation source (refresh endpoint / session re-fetch); otherwise go straight to `signOut` + gated redirect.
  - `hydrateSessionToken()` contract clarified: sets both the token and user module holders (references aligned).

## [1.8.0] - 09-24-2026

### Added

- **`extensions/edit-anchor-guard.ts`** — mechanically kills the recurring `Could not find edits[N] ... oldText must match exactly` edit failure. Root cause (2026-09-24 dropx-merchant session): the model built `oldText` anchors from lines it never read — a windowed read (`offset: 128`) cut mid-object at `}`, and the two lines above were pattern-inferred (`LANGUAGE: 'language',\n} as const`) instead of actually being `enabledTransports: ['ws', 'wss'],\n  },\n}`. The edit tool's fuzzy matching only tolerates cosmetic drift (trailing whitespace, smart quotes/dashes/spaces) and cannot recover nonexistent text. The guard intercepts every `edit` tool_call, reads the file, and validates each `edits[i].oldText` (exact, then the same fuzzy normalization the tool uses) before execution:
  - **Miss with partial overlap** → blocks and pastes the *actual* file content (with line numbers) around the longest fragment of the anchor that does exist — the model corrects the anchor in one retry instead of fail → re-read → retry.
  - **Duplicate anchor** → blocks with occurrence line numbers (prevents the `Found N occurrences` sibling error).
  - **No overlap** → instructs a windowed read of the target region.
  - Valid anchors (including fuzzy-only matches) pass through untouched; unreadable files defer to the tool's own error.
  - Verified against the reconstructed incident (6 cases: hallucinated anchor blocked with correct diagnosis, session's successful retry anchor allowed, smart-quote/trailing-ws anchor allowed, multi-edit call names the bad `edits[N]` index, duplicate blocked with lines, no-overlap blocked) + strict `tsc` clean.
- **AGENTS.md (global rule added)** — new **Editing** bullet under Token Economy: `oldText` anchors must be bytes actually seen in a read result this session; if the anchor needs lines beyond a read-window edge (above `offset` or past `offset+limit`), widen the read — never infer the missing lines; fuzzy matching tolerates quotes/trailing whitespace, not text that doesn't exist. Addresses the interaction where windowed-read economy rules push anchors onto window boundaries.

## [1.7.1] - 09-24-2026

### Fixed

- **Full macOS (arm64, stock BSD userland, bash 3.2) validation pass** — every executable in the repo syntax-checked and runtime-smoke-tested (Linux had passed earlier; this closes the cross-platform contract):
  - `skills/browser-tools/scripts/{browser-nav,browser-eval,browser-content,browser-cookies,browser-pick,browser-screenshot}.js` — crashed with `TypeError: Cannot read properties of undefined (reading 'goto')` when the Chrome instance on :9222 restores no real tab (profile whose targets are all extension background pages/omnibox): `(await b.pages()).at(-1)` is `undefined`. Now falls back to `await b.newPage()` in all six. Verified live against local Chrome: start → nav → content → eval → screenshot → cookies all pass; `web-fetch.mjs` and `browser-hn-scraper.js` unaffected and verified.
  - `skills/harness-engineer/scripts/ab_prefix.sh` — `date +%s.%N` is GNU-only: stock macOS `date` prints a literal `N`, so the heredoc Python's `float()` crashes **after** both paid pi runs. Replaced with `python3 -c 'import time; print(time.time())'` (python3 is already a hard dependency of the script); sub-second wall timing preserved, verified.
- Also validated clean on macOS (no change needed): `bin/fd` (arm64 Mach-O), `tavily/setup.sh` (idempotent path + BSD-safe install path), `find-polluter.sh` (sandbox polluter found), `make_test_home.sh` (perl strip + `.tavily` symlink), harness-engineer py×3 + `mdcmdcheck.mjs`, brainstorming `start/stop-server.sh` + `server.cjs` full lifecycle, session-audit ×7 (`audit.mjs run/views/fetch`, `skillcheck.sh`), `validate-skill.mjs`, `.husky/commit-msg` (after root `npm install` — 122 pkgs, prepare ran; valid msg exit 0 / invalid exit 1).

## [1.7.0] - 09-24-2026

### Added

- **`skills/auth`** — NextAuth v4 credentials auth skill for Next.js App Router apps whose identity provider is an external REST backend issuing bearer tokens. Covers: `authorize()` with server-side backend calls, session-token plumbing for RTK Query/fetch layers, proxy/middleware route protection, 401 retry + sign-out ladder, OTP registration/password-reset, social-login token exchange, deterministic post-login redirects, and a legacy-auth migration path. References split per concern (`nextauth-setup`, `token-plumbing`, `route-protection`, `login-flows`, `otp-flows`, `social-login`, `migration`) — Agent Skills layout (`references/`). Manual invocation; scoped to NextAuth v4 + App Router, explicitly NOT for OAuth-first, Auth.js v5, or Firebase. Skills count 17 → 18.

## [1.6.1] - 09-23-2026

### Changed

- **AGENTS.md (global rule added)**: "No absolute user paths in anything written" — `~`/`$HOME` or relative paths only; scripts derive their root from their own location (`$(dirname "$0")`, `import.meta.url`). Source: this session's portability audit caught a hardcoded `/home/nurmdrafi` root in freshly written `mdcmdcheck.mjs`. Takes effect on new sessions.
- `.nvmrc` 22 → 24 (current Node LTS; ≥22 remains the floor via `skills/browser-tools` engines). README aligned.
- **ast-grep rule demoted from FIRST-mandate to hint + empirically validated idioms** (3 weeks of audits: two phrasings, 0 adherence, unpriced cost; tool confirmed installed both machines):
  - Harness setup: Linux upgraded 0.26.3 → 0.37.0 (`npm i -g`); 0.38+ requires glibc 2.33 — this Ubuntu 20.04 box (glibc 2.31) is pinned at 0.37.0. Mac: darwin builds unaffected, `npm i -g @ast-grep/cli@latest` (0.45.3) verified install path only — no SSH route from this box.
  - Footgun confirmed across 0.26–0.37 and per official docs ("pattern code must be valid code"): bodyless fragments (`function $F($$$)`) parse to ERROR nodes → silent zero matches at every strictness; complete-node pattern `function $F($$$): $RET { $$$ }` works. `sg` collision re-verified: `/usr/bin/sg` → newgrp (shadow-utils) exists alongside the nvm alias; PATH order decides.
  - AGENTS.md carries the corrected hint (install, idiom, sg warning, rg-stays-correct); definitions remain an `rg` symbol-outline job.

### Added

- `skills/session-audit/scripts/skillcheck.sh` — portable (bash 3.2/coreutils) "was a skill actually loaded" check; replaces the node/jq-dependent `skillcheck.mjs` path. Validated: syntax (sh -n/bash -n), negative path (live session), positive path (output identical to `skillcheck.mjs` reference). Exits 1 when no requested skill was loaded — gate-usable.
- **Skill directory structure standardized to the Agent Skills spec** (agentskills.io; the spec pi implements): `scripts/` (executable) / `references/` (docs) / `assets/` (templates, data) alongside `SKILL.md`. Moves: browser-tools loose `*.js|mjs` → `scripts/`; systematic-debugging loose docs/example → `references/`, `find-polluter.sh` → `scripts/`; brainstorming companion docs → `references/`; session-audit `bin/`+`src/` merged → `scripts/` (imports updated); playwright-tester `template/` → `assets/`; harness-engineer `evidence/` → `assets/`. All SKILL.md/doc path references updated; `mdcmdcheck.mjs` adopted at `skills/harness-engineer/scripts/`.
- **skill-manager now enforces the layout**: SKILL.md gained a "Directory layout" section (scripts/references/assets semantics, no loose root files, package.json exception) + checklist item; `validate-skill.mjs` flags any nonstandard top-level entry. All 17 skills pass; negative test (loose `orphan-helper.sh`) correctly FAILs.
- **Portability audit (contract rule: no absolute user paths in functional files)**: fixed `mdcmdcheck.mjs` — repo root now derived from `import.meta.url` (was hardcoded `/home/nurmdrafi`, my own violation); added bare-script-name resolution against `skills/*/scripts/` so sibling-skill references (e.g. `skillcheck.sh`) validate without PATH. Post-review hardening: exits 1 on any finding (was always 0 — a gate could pass dirty); `<placeholder>` tokens are quoted before `bash -n`, implementing the documented waiver (skill-manager's own gate block now passes clean); `command -v` invoked argv-safe (no shell-string interpolation). Verified: official README check clean; `mdcmdcheck` runs from any cwd; `bin/` ELF confirmed gitignored (pi-regenerated per machine); `.github/`, `extensions/`, root `*.sh` clean. Historical audit reports/CHANGELOG quotes remain out of scope by contract.
- **skill-manager hardened as the explicit skill gate**: `disable-model-invocation` kept (invoke via `/skill:skill-manager` on any skill create/modify task); workflow split into create/modify paths (modify: preserve name/dir, grep-wide path-reference updates after moves); mandatory validation gate wiring all three harness validators — `validate-skill.mjs` (loop to exit 0), `mdcmdcheck.mjs` (command/path integrity when commands changed), `skillcheck.sh` (post-`/reload` load confirmation); `allowed-tools` format documented. Self-validates: PASS at 151 lines.
- **Validator aligned with Anthropic's skill-authoring best practices** (docs.claude.com best-practices + code.claude.com skills reference, researched 09-23): added name/description XML-tag check, reserved-word check (`anthropic`/`claude`), naming guidance (gerund/action names, avoid `helper`/`utils`/`tools`). One real catch: ponytail-review's description used `L<line>:<tag>` angle-bracket placeholders — replaced with literal `L12:tag` example. Confirmed already-aligned: 64/1024 char limits, <500-line body, third-person what+when descriptions, progressive disclosure (one-level refs, ToC >100 lines), freedom-vs-fragility, feedback loops, anti-option-lists, no dated info, forward slashes. Note: our no-loose-root-files layout is deliberately stricter than Anthropic's illustrated examples (loose FORMS.md etc.) — it follows the agentskills.io recommended `scripts/`+`references/`+`assets/` convention pi implements.
- Markdown command sweep (one-off, /tmp tooling): all 45 .md files — fenced + inline commands — checked for binary PATH resolution, long-flag validity vs per-subcommand `--help`, relative-script existence, bash -n syntax. Result: 24 binaries OK, 0 missing, 0 bad flags, 0 missing scripts; 2 waived: `<placeholder>` convention (skill-manager et al.) and macOS-only binaries inside an explicitly illustrative example (systematic-debugging signing script).

### Fixed

- harness-engineer evidence JSON restored to `assets/` — it was staged as renamed but deleted in the worktree (pre-commit review catch); the SKILL.md reference and the "moves" claim above are true again.
- browser-tools SKILL.md: first-run `npm install` pointed at nonexistent `{baseDir}/scripts/browser-tools` (the path rewrite propagated a stale pre-existing suffix); package.json lives at the skill root — now `cd {baseDir}` + pre-flight on `{baseDir}/node_modules` (`require` from `scripts/` already resolves upward).
- README stale facts swept + made developer-friendly (badges, skills table): 16→17 skills, `audit`→`fallow-audit`, default model glm-5.2→glm-5.3, thinking default medium→`off`, `models.json` "empty"→defines `glm-5.3-flash`, three `.nvmrc` lines 22→24, auto-invocable set corrected (ponytail + tavily-search; the other 15 manual), dropped nonexistent `prompts/` claim and a future-dated note (2026-12-17).
- README always-on floor re-anchored ~1.6K→~1.5K tok (post-commit re-measure, chars÷4: AGENTS.md 5,396 c + ponytail 380 + tavily-search 205; the 1.6K figure predated 1.6.0's AGENTS.md growth and 1.6.1's absolute-paths rule).
- README skills tree: removed stale `youtube-transcript/` entry (skill deleted in 606993a); `└──` connector corrected.

## [1.6.0] - 09-23-2026

### Added

- **2026-09-23 — token-economy-guard: read-after-edit (R1) + uncapped `rg -o` (R6) enforcement** (from the 09-16→23 session audit):
  - R1: a full re-read of a path successfully edited within ~3 turns (6 tool calls) is blocked — the edit result is already in context. Freshness is confirmed only on a successful `tool_result` (a failed edit permits the re-read); windowed reads (offset/limit) always pass; any bash command naming the file drops freshness (external change). Source: commit-flow `CHANGELOG.md` re-read loops — `read` dup 56× / 316K ≈ 72% of the week's waste, 24/35 sessions (worst: `01a0cd3b-680f`, reads of one file ×7).
  - R6: `rg -o` / `--only-matching` without a pipe cap is blocked; quoted spans are stripped before the flag test so a *pattern* containing `-o` can't false-fire. Source: 33–51KB outputs from wide `-o` windows over Chrome extension bundles (BIG_TOOL_OUTPUT 7 findings / 119K / $0.15).
  - Verified: 16-case behavioral suite + `tsc` against pi's own types; ponytail-trimmed (−3 lines: redundant full-path `includes` clause, prune loop). Takes effect on new sessions.
  - `Measured:` AGENTS.md unchanged (extension, not prompt — zero prefix cost); the pre-existing rules self-blocked this session's own `cat`/`sed -n` slips, correctly.

### Changed

- **2026-09-23 — skills genericized (`d3b4811`, 12 SKILL.md bodies, +95/−74)**: stripped project-specific content, dated refs, and broken cross-links from skill bodies; folded mdskills best practices into `skill-manager`. Body-only — descriptions untouched, model-visible prefix stable.
- **2026-09-23 — `audit-reports/2026-09-23T115618Z.md`** (35 sessions, 09-16→23): headline waste 438K ≈ $0.46 floor (0.56% of read); hit ratio 1.000, 0 compactions, no session above 125K peak — the 09-19 marathon-session fix landed. Re-read habit worsened per-session (4.9K→9.0K/sess) → drove R1/R6 above. Next-audit targets: `read` dupWaste 316K → <150K, BIG_TOOL_OUTPUT 119K → <50K, one-call turns 87% → <70%, ast-grep 0 calls (rg in 33/35 sessions).

### Fixed

- **2026-09-23 — skill-script hardening (all-scripts review: 33 scripts, syntax 33/33, findings 1 medium + 7 low, all fixed and fix-loop re-reviewed)**:
  - `make_test_home.sh`: bare `sed -i` → portable perl strip — BSD/macOS sed break, empirically confirmed on this machine (medium).
  - `browser-cookies.js`: cookie values masked by default (`••••`+last-4, `--reveal` opt-in) — httpOnly session tokens no longer land in agent transcripts.
  - `browser-pick.js`: an abandoned pick is cancelled on the next invocation (`window.__pickCancel`); previously its pending promise hung every later pick on that tab.
  - `stop-server.sh`: the `rm -rf` gate canonicalizes the path (logical `pwd`, macOS `/tmp` symlink kept) and requires the `/tmp/brainstorm-*` prefix — the old `/tmp/*` glob matched `..` segments.
  - `start-server.sh`: dead unverified stale-pid kill block deleted (fresh session dir makes it unreachable; EADDRINUSE fallback covers collisions).
  - `find-polluter.sh`: `while IFS= read -r` loop — spaced paths no longer word-split.
  - `web-fetch.mjs`: 30s `AbortSignal.timeout` — a hanging server no longer hangs the script.
  - `browser-hn-scraper.js`: `pathToFileURL` CLI detection (spaces/special chars) + argv guard — dynamic import no longer throws; verified by a live scrape.
  - Two regressions introduced by the fixes themselves were caught in fix-loop re-review and fixed: `find-polluter.sh` loop input (`done <<< "$TEST_FILES"`) and the `pathToFileURL(undefined)` throw.

## [1.5.3] - 09-23-2026

### Changed

- **2026-09-23 — AGENTS.md Behavioral Core: global security rule** (user decision after 7-day bot audit):
  - New line: "Security is build-time, not review-time: mutating routes/actions carry auth/permission checks when first written, secrets stay server-side, and guard/effect fixes re-check the adjacent paths they silenced or unblocked."
  - Source: audit showed permission gating + fix-induced regressions as cross-domain classes (admin #66-6 ungated mutating route; 7/17 findings fix-induced). Supersedes the earlier skip recommendation; rest of audit lessons stay skill-local.
  - `Measured:` AGENTS.md 4,916 → 5,137 B (+221 B, ~+55 tok/turn); portability 0 hits; prefix cache invalidated — fresh session required.
  - Same decision thread: pre-push-review §2.7 expanded from 2 lines to the full security enumeration (route-level authz, object-level/IDOR, input validation at trust boundaries, output/log exposure, CI posture) — zero prefix cost; AGENTS.md stays stance-only by design.

## [1.5.2] - 09-23-2026

### Added

- **2026-09-23 — pre-push-review skill: local mirror of the CI push-review bot** (from 7-day session + `ollama-review` issue audit):
  - Evidence: 11 issues / 17 findings (all MEDIUM) filed 2026-09-16..22 by `barikoi/code-review@v1` across barikoi-admin-nextjs, bkoi-gl-js, dhaka-express-admin, dropx-admin. ~60% async/stale-state lifecycle; 7/17 were regressions introduced by pushed fixes to earlier findings (dhaka-express-admin edit-polygon block: 5 consecutive fix pushes). All 27 Barikoi sessions committed+pushed directly — review fired only post-push.
  - `skills/pre-push-review/SKILL.md`: manual invocation only (`/skill:pre-push-review`, user preference), checklist ordered by observed bot-hit frequency, CI-parity severity + finding format, mandatory fix-loop re-review of fix diffs.
  - **Auto-sync with the bot (same day):** skill §0 fetches live criteria from `barikoi/code-review` on every invocation (local clone → `gh api` raw fallback → offline proceeds on embedded checklist). Fetched prompt is authoritative; org-side rule changes apply without a skill edit.
  - **Audit lessons pushed into dev skills (body-only, descriptions untouched → prefix byte-stable):** `systematic-debugging` Phase 4 adjacent-path check (7/17 findings were fix-induced); `refactoring-ui` §0b logic-in-UI hard rules (staleness/.catch, reset completeness, pre-fill-vs-fallback, lazy-tab prefill, default polarity); `frontend-design` logic guards for mutating UIs (permission gating day one + same set); `map-integration` §5.5–5.6 draw/polygon sync upsert + geometry load guards (10/17 findings were this domain). `playwright-tester` already covered CI/headless — no edit.
  - `Measured:` AGENTS.md 4,916 B unchanged; skills 17→18; model-visible desc catalog unchanged (manual skill = zero prefix bytes); portability quick-check 0 hits before and after.

## [1.5.1] - 09-19-2026

### Changed

- **2026-09-19 — ask-don't-assume, enforced at both layers** (from discoverthreejs mis-targeted audit):
  - `AGENTS.md` Behavioral Core line 1 rewritten: "If unclear, ask once then move" → "Do not assume: if anything is unclear or a named target/reference is not found, **ask and wait for the answer** — never substitute a closest match or proceed on a guess. Ask once, then act on the reply." Root cause: the old wording licensed proceeding without the answer; agent substituted react-bkoi-gl for the user-named discoverthreejs and spent a full audit pass on the wrong target.
  - `skills/session-audit/SKILL.md` Phase 1: new hard rule — if a user-named target (project/path/session) is absent from the digest (including active-excluded), stop and ask; never audit a closest match or unilaterally choose fetch-inspection. Note: skill dir is the live copy; port the line to the skill source repo on next install.
  - `audit-reports/2026-09-19T151000Z.md`: directory digest (84 sessions, 1,347K/$0.94 floor) + fetch-only inspection of the still-open discoverthreejs session; marathon-session pattern confirmed there too (pasted book chapters + growing README re-reads).

## [1.5.0] - 09-15-2026

### Added

- **2026-09-16 — AGENTS.md Turns: session-length hard stop + no skill-body injection** (from 09-16 react-bkoi-gl session audit):
  - Hard stop at ~200 assistant turns → propose fresh session (cost-tail driver: 300+ turn sessions at $10–14 each; glm-5.3 reasoning share hit 53%). Never paste a skill's full body into a prompt — bodies ride every subsequent turn (measured 7,952-tok first turn vs ~3k baseline).
  - `Measured:` AGENTS.md 4,704→4,743 B (+39 B, ~+10 tok); audit also found 126 tool-call violations across the two sessions (cat-for-viewing 86, speculative 30, minified-uncapped 7, pollution 2, rerun 1) — behavior unchanged since 09-14, rules already present.
  - **Enforcement:** `extensions/token-economy-guard.ts` — `tool_call` hook blocks bash cat/sed-for-viewing, uncapped `git log`, and uncapped verbose runners (npm test/build, vitest, jest, playwright, tsc) with the corrective rule text. Verified: `pi -p` cat attempt blocked, model recovered via `read`. Zero prefix cost (extension, not prompt).

- **2026-09-15 — occluded-window freeze guidance ported to browser skills**:
  - `skills/browser-tools/SKILL.md` (Debugging failing e2e §) + `skills/playwright-tester/SKILL.md` (Headed review runs §): a headed run that "shows nothing" → suspect Chromium rAF/compositing freeze for occluded/backgrounded windows; verify (front/screenshot/headless) before rerunning. Body-only edits — zero prefix cost. Source: 09-15 react-bkoi-gl session audit (~45 min of blind reruns).
  - `audit-reports/2026-09-15T063200Z.md` + `2026-09-15T090800Z.md` (react-bkoi-gl session audits, habit fixes ranked); `harness-audit-report.md` rewritten for 09-15 (health 75/100, portability PASS).

- **2026-09-16 — map-integration: per-framework deep docs** — `docs/frameworks/<name>.md` (e.g. `cra.md`) added to the docs-split contract in the docs-split bullet. Body-only edit, zero prefix cost.
- **2026-09-16 — tavily: gitignore `tavily/config.json`** — file holds live OAuth tokens from `tavily auth`; excluded from the repo. `tavily/session.json` (hash-only session state) stays tracked.

### Changed

- **2026-09-15 — ponytail ladder re-enabled; description trimmed**:
  - `AGENTS.md` ponytail bullet → full ladder rungs (need it? → codebase → stdlib → platform → dep → one line → minimal code), deletion-over-addition, `ponytail:` corner-cut comments. Re-enabled after user A/B showed overthinking/token use rise without it.
  - `skills/ponytail/SKILL.md` description 424→398 c (Σ descriptions 5,224→5,198 c): dropped AGENTS.md-ladder restatement, kept all fire cues, states what loading adds. Permanent floor ~1,235 tok (2 model-visible skills); portability 0 hits; health 75/100 (context 1,080 tok; 17 skills).
  - User directive: **no skill archiving** — 5-unused-skills recommendation (fallow-audit, refactoring-ui, systematic-debugging, tavily-extract, youtube-transcript — 0 loads each) declined; all 17 skills stay in `skills/`. Future audits: do not re-propose.

### Removed

- **2026-09-15 — `prompts/commit.md` deleted (user request)**: last remaining prompt, so `prompts/` removed entirely. README tree, persistence-table row, and self-audit commands updated to match.

## [1.4.0] - 09-14-2026

### Fixed

- **2026-09-14 — session-audit `bin/audit.mjs` missing from the installed bundle (root cause: gitignore)**:
  - Blanket `bin/` pattern in `.gitignore` — meant for pi's machine-local root `bin/` — matched nested dirs, so `git add .` silently skipped the skill's source `bin/`; the runner was never tracked (verified: absent from history on all branches; `git check-ignore` named line 8). Pattern anchored to `/bin/`; root `bin/` stays ignored.
  - Runner restored per SKILL.md contract: `run` (digest → manifest/l1_findings/overview in `$AUDIT_WORKDIR`), `views` (all 13 sections), `fetch` (5 kinds, byte-capped, logged to `fetch_log.jsonl`). Verified end-to-end: `run --max 25` → 46 findings, active session auto-excluded; clean error paths.
  - `turn_window --uuid` resolves both responseIds and toolCall ids — findings' `turnPointers` are mixed (CACHE_TTL/CONTEXT_GROWTH carry responseIds; DUP/BIG/RETRY carry toolCall ids).

### Changed

- **2026-09-14 — AGENTS.md Token Economy rewritten concise; global cross-platform rule**:
  - ~640 → ~350 words, 18 flat bullets → 13 in four groups (Searching / Reading / Command output / Turns). Every operative rule preserved (coverage-checked rule-by-rule); measurement citations deduped (817K/59% read-dup and 94% single-call retained).
  - Added: `npm install --no-fund --no-audit | tail -5`; milestone fresh-session suggestion past ~150K context; Behavioral Core now requires everything written or run to work on both macOS and Linux (BSD∩GNU intersection; `sed -i`, `stat -c/-f`, `grep -P` named as splitter traps).

### Added

- **2026-09-14 — validation addendum on the 2026-09-14 audit report** (`audit-reports/2026-09-14T041139Z.md`): parser fix verified in `src/parser.mjs:183-187`; BIG evidence exact (51,338 / 45,268 / 51,339-char toolResults); fix-#1 evidence corrected — 2 identical full reads + 30 windowed in `01a0573a…`, not "~6 full + 7 windowed"; ast-grep 0.45.3 `run -p` syntax verified.

## [1.3.0] - 09-14-2026

### Fixed

- **2026-09-14 — session-audit DUP_TOOL_CALL artifact (`edit`/`write` paramHash)**:
  - `src/parser.mjs` normalized `edit` inputs to path only, so distinct sequential edits to one file counted as duplicates — 132 of 213 DUP findings false (repeatBytes 49–98 B); `write` had the same flaw (11 false findings). Both normalizers now include the edits/content payload.
  - Measured (61 sessions, re-run): findings 231 → 84, headline waste 1,515K → 1,375K tokens; edit-dups 132 → 1 (true repeat), write-dups 11 → 0.

### Changed

- **2026-09-14 — full-directory session audit (61 sessions, 2026-08-30→09-13) tightens two Token-Economy rules**:
  - Report: `audit-reports/2026-09-14T041139Z.md`. Headline waste 1,515K ≈ $1.75 (floor). Cache rules structurally blind: provider logs 0 `cacheWrite` on all 3,937 turns (hitRatio 1.000 degenerate).
  - Top finding (54% of waste, 816K): whole-file re-reads of large files during iterative fixes (e.g. `ManagePickupLocations.tsx` read full-file ~6× in one session). AGENTS.md now forbids re-reading whole a file already read/edited this session — offset/limit window at the known anchor instead.
  - Second (34%, 513K): uncapped npm/typecheck tails (45–51K escapes; typecheck run twice in one turn). AGENTS.md now requires piping build/test output through `rg … | head`, at most one per turn, never the same command twice.
  - Trend vs 2026-09-06 audit: waste rate 1.13% → 0.73% of read volume.
  - Runner note: installed skill bundle lacks `bin/audit.mjs`; audit ran via a thin workdir driver importing the skill's `src/` modules.

### Added

- **2026-09-14 — three new `views` blocks: batching, ast-grep discipline, tool detail**:
  - Batching (tool calls per assistant turn): 3,403 calling turns, **94% single-call, avg 1.1/turn**; worst offenders listed (e.g. `01a0573a…` 155/155 one-call). Caveat: single tool call ≠ unbatched — `&&`-chained bash still batches commands (2026-09-08 harness-engineer measurement: 60–95% of bash calls `&&`-batched); this block measures harness-level turn batching only.
  - ast-grep discipline: **16 ast-grep/sg calls across 2 of 61 sessions, vs rg in bash in 47 sessions — 45 sessions rg-but-never-ast-grep** (AGENTS.md "ast-grep first" rule largely unpracticed).
  - Tool detail with dup-finding linkage: read dup 38× / 817K dominates; bash dup 32× / 45K.
  - Aggregation lives in the workdir runner (batching + astgrep into `overview.json`); rendering in `src/views.mjs`. Runner (`bin/audit.mjs`) still absent from the installed bundle — the workdir driver remains the entry point.

## [1.2.0] - 09-09-2026

### Changed

- **2026-09-09 — cross-session audit (pickaboo-frontend, react-bkoi-gl) tightens Token-Economy rules**:
  - Audited last sessions: pickaboo-frontend (Sep 9, 122 turns, $1.13, 96% cache-read, 78 bash/18 edit/6 read) and react-bkoi-gl (Sep 6, 18 turns, $0.10, 11 bash/3 edit/1 write).
  - Only recurring issue in both: uncapped `rg` (e.g. `rg '"version"' package.json`). react-bkoi-gl additionally catted 4 workflow yamls whole + `head -8 CHANGELOG.md` (rule-letter loophole).
  - Rules updated in AGENTS.md: (1) every match-printing `rg` now requires a cap (`-m`/`| head`/`-l -q -c`); JSON fields → `jq`. (2) `cat x | head` and `head -N file` explicitly count as whole-file-read violations; lone `sed -n` windows → `read`. (3) Prefer byte caps (`head -c 4000`) for possibly long-line output. (4) New turn-batching heuristic: batch search-then-act when target ~80% identified (cache-read cost scales with turns).
  - Not added: hard turn/token budgets and bash-vs-read quotas — tool mix varies legitimately by task.

## [1.1.0] - 08-09-2026

### Fixed

- **2026-09-08 — `audit_toolcall_rules.py` extraction bug + rule sync with current AGENTS.md**:
  - Bug: analyzer looked for `tool_execution_start` records; real logs store tool calls as `toolCall` content items in assistant `message` records → every session reported `calls=0 viol=0` (false negatives). Now parses the actual format.
  - Rules updated to current Token-Economy: `sed -n` windowed reads no longer flagged (R2); full `git log` without `--oneline|head` now flagged separately (R5_git_log_full); new R6 flags uncapped `rg` into dist/minified paths.
  - Measured: full sweep 83 sessions, 1,431 violations — R2_cat_file 686, R1_grep_file 526, R4_speculative 154, R6_minified_uncapped 35, R5_pollution 9 (+6 git_log_full), R3_rerun 15. Before fix: 0 detected. `&&`-batching healthy in recent sessions (~60–95% of bash calls).
- **2026-09-08 — precision fixes to audit_toolcall_rules.py**: R1 now only flags `grep` at pipeline stage 0 (downstream/stdin grep exempt per AGENTS.md pipe rule) and analyzes `$(...)`/backtick contents as separate statements; `env VAR=x grep` prefix handled; turn tracking via user-message boundaries (real per-turn batching distribution); removed unused PIPE_SAFE regex. Unit-checked 9/9 sample commands. Measured: R1_grep_file 526→210 (−316 false positives); other counters unchanged.

### Added

- **2026-09-08 — salvaged `skill_usage_audit.py` from archived upstream `pi-skill-audit` skill**:
  - New: `skills/harness-engineer/scripts/skill_usage_audit.py` — counts per-skill invocations across `~/.pi/agent/sessions/` (skill tags + SKILL.md reads), tiers high/medium/low/unused. Referenced from harness-engineer's "Rank skills" step.
  - Fixed vs upstream: default skills dir `~/.agents/skills` → `~/.pi/agent/skills`; header now prints actual scanned dirs; "Skills with usage" counts installed skills with >0 invocations (was inflated); removed `bunx skills remove` hint (not applicable; manual review + `rm` instead).
  - Skill itself NOT installed (archived upstream, wrong paths, ~225-token description, redundant with harness-engineer loop).
  - Measured: harness-engineer SKILL.md 6178→6299 bytes (+121); scripts load on demand, no prefix cost.

## [1.0.0] - 05-09-2026

### Added

- **2026-09-06 12:21Z — audit-driven output-cap rules + bkoi-gl-js session audit**:
  - Added: AGENTS.md Token Economy — minified/dist grep capping (`rg -o` or `| cut -c1-200`; `head -N` bounds lines, not bytes, and minified lines are megabytes); playwright-tester SKILL.md (Reconnaissance-then-action) — cap recon output (`JSON.stringify(x).slice(0, 500)` for `page.evaluate` dumps, `| tail -20` on test-run output, `-o`/`cut` for dist greps).
  - Measured: audit of the last 2 bkoi-gl-js sessions (624 turns, 643K tok ≈ $0.90 waste floor): BIG_TOOL_OUTPUT 3×45–51KB from uncapped dist greps/probes = 57% of waste; rules target exactly that class. Target next audit: BIG_TOOL_OUTPUT → 0, DUP-read waste 238K → <50K.
  - Docs: audit-reports/2026-09-06T114525Z.md (full report; notes the installed session-audit bundle ships src/ without bin/audit.mjs — audit ran via a workdir-local orchestrator over the bundle's own modules).
  - Risk: none — advisory text only.

- **2026-08-28 15:50Z — deprecate setup.sh / bundle.sh; .env fixes**:
  - Added: `.env` regenerated correctly (auth.json stores nested `{type,key}` objects; keys exported flat as ZAI_API_KEY / DEEPSEEK_API_KEY), chmod 600. `.gitignore` now also excludes `setup.sh` and `bundle.sh`; both untracked from the index (files still on disk pending user removal).
  - Measured: `git check-ignore setup.sh bundle.sh .env auth.json models-store.json` all pass; index 66 files, 0 scripts/secrets staged. auth.json verified byte-identical after the aborted setup.sh test run.
  - Docs: PORTABILITY.md "Git sync" section is now git-only (no setup.sh in home flow; auth.json buildable from .env via documented one-liner); HARNESS-ARCHITECTURE.md portability summary marks setup.sh/bundle.sh deprecated.
  - Risk: none — scripts remain on disk until user deletes them; git-only flow documented.

- **2026-08-28 15:35Z — .env / .env.example**:
  - Added: `.env` (machine-local, generated from auth.json: ZAI_API_KEY, DEEPSEEK_API_KEY; gitignored) and `.env.example` (committed placeholder template).
  - Measured: `git check-ignore .env` passes; index contains only `.env.example` (+ prior baseline). auth.json, models-store.json, bin/, npm/ remain ignored (already covered in step 1).
  - Docs: PORTABILITY.md auth note now documents .env as alternative to copying auth.json; models-store/bin/npm confirmed regenerable.
  - Risk: none — .env never enters git; pi still reads auth.json directly.

- **2026-08-28 15:20Z — git-backed portable sync**:
  - Added: `.gitignore` (auth.json, sessions/, bin/, npm/, **/node_modules/, *.log, ._*, .DS_Store, models-store.json, skills-archive.tar.gz, harness-audit-report.md); initialized git repo (branch main).
  - Measured: 69 files staged, 0 secrets in index (git check-ignore verified auth.json/sessions/npm/bin ignored); `git status` clean of local-only artifacts. Tracked: AGENTS.md, settings.json, models.json, skills/ (14), prompts/, HARNESS-*.md, PORTABILITY.md, setup.sh, bundle.sh, skills-audit.md, .nvmrc.
  - Docs: PORTABILITY.md gained "Git sync (preferred)" section (office push / home pull + setup.sh; auth.json copied manually once per machine); HARNESS-ARCHITECTURE.md portability summary now states git primary, bundle.sh secondary.
  - Risk: none — repo not committed/pushed yet; bundle.sh flow unchanged.

### Changed

- **2026-09-06 12:21Z — `sg` directive → portable ast-grep rule**:
  - Changed: AGENTS.md Token Economy — canonical invocation is now `ast-grep run -p` with a narrow construct-shape trigger (imports, call sites of a specific API, `new X(`, `function|class|const X` definitions, JSX structure in first-party TS/TSX/JS src) plus an explicit rg-is-correct list (symbol/text presence, pipe-filtering command output, configs/JSON/CSS/MD, dist/node_modules). The `sg` alias is banned: on Linux it collides with shadow-utils' setgid `sg`. Install hint added (`npm i -g @ast-grep/cli`, prebuilt darwin/linux binaries).
  - Why: three audited sessions across two projects invoked sg 0× despite it being installed before both bkoi-gl-js sessions (04:48 UTC via `npm i -g`); advisory + fuzzy "structural code search" phrasing did not survive glm-5.3. Narrow imperative trigger + rg whitelist is unambiguous, and `ast-grep` avoids the per-call deprecation banner `sg` prints.
  - Measured: AGENTS.md +~340 B permanent prefix (~+85 tok); `ast-grep run -p` verified functional on this machine (exit 0, banner-free).
  - Risk: low — Linux machines need a one-time `npm i -g @ast-grep/cli` (npm globals do not ride dotfile sync).

- **2026-09-05 07:05Z — AGENTS.md `sg` availability clause**:

  - Changed: line 20 — `try \`sg run -p '<pattern>'\` (ast-grep)` → `if \`sg\` (ast-grep) is installed, try \`sg run -p '<pattern>'\` before keyword guessing`
  - Why: external review flagged that `sg` is third-party and not guaranteed installed; clause now makes the fallback to `rg` explicit instead of assumed. All other review suggestions rejected (prefix bloat / already covered by tool definitions).
  - Measured: AGENTS.md 3134 → 3156 bytes (+22 B, ~+6 tok permanent); skill count / descriptions / prompts unchanged
  - Risk: negligible — behavior identical when `sg` is installed; when absent, agent skips to `rg` instead of hitting a failed command first
  - Rollback: restore the original line 20 text.
  - Note: prefix changed — start a fresh session for clean cache.

- **2026-09-05 06:09Z — AGENTS.md output-cap rule (permission → imperative)**:
  - Changed: `AGENTS.md` Token-Economy line 16 — "Filtering command output through a pipe (`cmd | grep x`) is fine." → "Filtering command output through a pipe is fine — cap verbose output (`cmd | tail -40`, `npm view x | head -30`) before it lands in context."
  - Why: session-audit 2026-09-05 (reports 054940Z, 060421Z) — BIG_TOOL_OUTPUT is the #1 rule by dollars directory-wide: 16 findings / 11 sessions / 2038K tokens = $1.19 (51KB vite/e2e dumps in react-bkoi-gl; 46-51KB npm-research dumps in agent project, recurring through 09-03). Permission wasn't triggering truncation; imperative with copy-able syntax should.
  - Measured: AGENTS.md 2348 → 2425 bytes (~587 → ~606 tok, +19 tok permanent); skills 17 / desc 1682 B / prompts 1 unchanged
  - Risk: low — tail window may hide earlier errors; mitigated by wider re-run when diagnosing. Rollback = restore old line.
  - Verification: next session-audit target BIG_TOOL_OUTPUT 2038K → <800K; delete the clause if unmoved.
  - Note: prefix changed — start a fresh session for clean cache measurement.

- **2026-09-05 05:50Z — session-audit skill (Claude Code port → pi sessions)**:
  - Changed: `skills/session-audit/` (new: SKILL.md, `bin/audit.mjs`, `src/{parser,discover,rules,pricing,views}.mjs`) — 0 → 7 files; README tree + skills-audit entry
  - Why: capability — layered (L0/L1 scripts + L2/L3 prompt) audit of `~/.pi/agent/sessions` for token/cost waste; pricing derived from logged `usage.cost` (no static table)
  - Measured: skill count 16 → 17; desc 300 chars (~75 tok); validator PASS; dry run over 40 real sessions: 191 findings, ~2780K waste tokens = $2.13, 4 models priced from logs (glm-5.3 $1.31/MTok-in)
  - Risk: low — manual invocation (`/skill:session-audit`); writes only to `$AUDIT_WORKDIR` + `~/.pi/agent/audit-reports/`
  - Portability: clean — `homedir()`-based paths, Node ≥18, zero deps

- **2026-02-14 — Conventional commit enforcement (commitlint + husky)**:
  - Changed: `package.json` (new, tracked), `commitlint.config.js` (new), `.husky/commit-msg` (new); `core.hooksPath=.husky`
  - Why: reliability — 13/14 historical messages failed conventional format; enforce at commit time
  - Measured: commitlint rules 0 → active (default conventional + `harness`/`release` types); hook rejects bad msg (exit 1), passes `harness: …` (exit 0)
  - Risk: low — history untouched; only future commits validated
  - Portability: clean — Node ≥18 required (`.nvmrc` pins 22); deps gitignored via `**/node_modules/`

Entry format:
```
  - Changed: <path> — <before> → <after>
  - Why: <cache / tokens / reliability / focus / portability>
  - Measured: <concrete before→after numbers (bytes/tokens/files); "unchanged" if N/A>
  - Risk: low|med|high
  - Portability: clean|fixed|attention
```

---

- **2026-09-03 16:04Z — tavily-search desc trim; task.md superseded; audit report delta**:
  - Changed: `skills/tavily-search/SKILL.md` — description 510 → 209 chars (510 → 205 parsed; folded block → single line), trigger-first, NOT-routing kept, details already in body
  - Changed: `task.md` — SUPERSEDED banner (Phases 1–2 built/deleted by design, Phase 4 decided differently); prevents stale re-execution
  - Changed: `harness-audit-report.md` — same-day delta block in Executive Summary
  - Kept (by request): `skills/browser-tools/node_modules` — already double-gitignored (root `**/node_modules/` + skill-local `node_modules/`), self-contained for standalone sync
  - Why: tokens — tavily-search is now model-visible, so its description is resident; 510 chars cost ~128 tok/turn for trigger info the body already carries
  - Measured: catalog 49 → ~101 tok (ponytail 49 + tavily 52); permanent floor ~764 → **~688 tok**; YAML validated (tavily-search, 205-char desc)
  - Risk: low — prefix changed again → fresh session recommended before next measured comparison
  - Portability: clean

- **2026-09-03 15:56Z — bench/ deleted; audit tooling attached to harness-engineer skill**:
  - Changed: `bench/` (60 MB: fixtures incl. 19 MB pi-repo copy, task defs, raw run logs, work dirs) — deleted; one-shot L2-vs-L3 decision complete (see 15:49Z entry)
  - Changed: `scripts/` — removed (run_l2_vs_l3.sh, collect_results.py, setup_l3_home.sh deleted; usage-metrics.py `git mv` → `skills/harness-engineer/scripts/`)
  - Changed: `skills/harness-engineer/` — +scripts/{usage-metrics.py, audit_toolcall_rules.py (generalized: session-path arg, no bench coupling), make_test_home.sh, ab_prefix.sh}; +evidence/2026-09-03_l2_vs_l3_matrix.json (decision evidence preserved); SKILL.md deep-evidence section updated to skill-relative paths
  - Why: minimal core — one-shot bench scaffolding is not permanent harness; audit tooling lives with the audit skill (progressive disclosure), reusable for future audits
  - Measured: agent dir 60 MB lighter; model-visible skill set unchanged (ponytail, tavily-search); SKILL.md description untouched (catalog byte-stable); all 4 scripts verified from new location (A/B smoke: real 2,383 tok vs test-home 2,785 tok first-turn)
  - Risk: low — raw bench logs unrecoverable (untracked), but matrix JSON + methodology preserved; rerunnable via make_test_home + ab_prefix
  - Portability: clean

- **2026-09-03 15:49Z — tavily-search model-visible; bench scripts → scripts/**:
  - Changed: `skills/tavily-search/SKILL.md` — removed `disable-model-invocation: true` (3,796 → 3,765 B); model-visible skills 1 (ponytail) → 2 (+tavily-search)
  - Changed: `scripts/{run_l2_vs_l3.sh, collect_results.py, audit_toolcall_rules.py, setup_l3_home.sh}` — moved from `bench/` for reuse; paths now script-relative (`../bench`), no absolute user paths
  - Why: tokens/reliability — L2-vs-L3 A/B matrix (glm-5.3, 10 runs, bench/results/matrix_l2_vs_l3.json): tavily-search was the only skill that fired; without it the agent ignored an explicit "use tavily-search" instruction, substituted curl, 3.7% price error vs 0.08% with the skill. Other 15 stay manual-only (4/5 L3 skills never fired; full L3 failed the ≤20% median-cost rule, +23%)
  - Measured: permanent catalog +510 desc chars ≈ +128 tok (chars/4) → permanent floor ~636 → ~764 tok; ≈ $0.00003/run extra at 97% cache. Scripts verified from new location (collect + audit rerun OK)
  - Risk: low — one more auto-triggerable skill; prefix change → start a fresh session for cache stability
  - Portability: clean

- **2026-09-02 19:29Z — tavily-search: search budget tip (max-results 3, 2-3 searches)**:
  - Changed: `skills/tavily-search/SKILL.md` Tips +1 line: default `--max-results 3`, stop after 2-3 searches and synthesize — extra searches add context tokens every remaining turn, rarely signal
  - Why: tokens — this session's research turn ran 4 searches ≈ 6k tok of tool output re-sent each subsequent turn; AGENTS.md deliberately not touched (rule-per-observation accretion is self-defeating; this is skill-local, loads only when used)
  - Measured: SKILL.md 3435 → 3796 B (+361 B ≈ +90 tok, on-demand load only, manual invocation)
  - Risk: low — guidance only; deep-research flows can still escalate via tavily-research
  - Portability: clean

- **2026-09-02 18:54Z — AGENTS.md: LLM-friendly rephrasing of Token Economy + YAGNI ladder**:
  - Changed: `AGENTS.md` — verb-first imperatives ("`grep` on files: never" → "Never `grep` a file path"; same for cat/sed/head/tail), pipe carve-outs un-nested from parentheses into standalone sentences, "re-pays the prefix" → "re-sends and re-processes the whole conversation", "status/stat preambles" → "preview commands (`git status`, `--stat`)" + continuation-reads clarification, "need-to-exist?" → "Is it needed at all?"
  - Why: compliance — instruction-following guidance prefers imperative verb-first phrasing, positive framing, and un-buried carve-outs; the pipe distinction (grep a file = banned, `cmd | grep` = fine) was the likeliest misread; pagination vs one-call-per-question ambiguity resolved explicitly
  - Measured: AGENTS.md 2210 → 2348 B (≈553 → ≈587 tok, +34); no rule semantics changed, phrasing only
  - Risk: low — wording only, verified line-by-line against prior version
  - Portability: clean

- **2026-09-02 18:42Z — AGENTS.md: round-trip economy rules (batch, one-call-per-question, no re-runs)**:
  - Changed: `AGENTS.md` Token Economy +3 lines: batch independent commands (`a && b`, each round-trip re-pays the prefix), one call per question (no speculative status/stat preambles), never re-run a command whose result is already in context
  - Why: tokens — self-audit of a 3-call turn (redundant `git status --short && git diff --stat` before full `git diff`); web research (arXiv 2602.07359 parallel tool calling; codeant.ai batching; Anthropic context discipline) confirms round-trip count as a first-class cost lever; context editing documented at 84% reduction over 100 turns (harness-level, not codified here)
  - Measured: AGENTS.md 1733 → 2210 B (≈433 → ≈553 tok, +120); research rejected as rules: prompt caching, model routing, catalog minimization (already done 2026-09-02), session audits (already practiced)
  - Risk: low — additive behavior rules only
  - Portability: clean

- **2026-09-02 18:20Z — AGENTS.md: strict, concise tool rules in Token Economy**:
  - Changed: `AGENTS.md` Token Economy — rewritten: rg is the only file-search tool (grep on files banned; pipes fine), read the only file-content tool (cat/sed -n/head/tail on paths banned; pipes fine), >150-line files = region read around rg hit, symbol outline before whole-file reads, git reads bounded
  - Why: tokens — session-log audit (20 sessions, 2,779 tool calls) showed 33% of tool output (~157K tok) via violating commands: grep-on-files 159, cat 133, sed -n 129 (median 1,248 chars vs rg's 420); 69% of reads whole-file (29 code files)
  - Measured: AGENTS.md 1425 → 467 → 1733 B final (≈349 → ≈433 tok, +84 vs pre-audit baseline); Token Economy section 797 → 569 chars; expected ~30% cut in violating tool classes (verify next audit)
  - Risk: low — tightens existing behavior only; pipes and build/test output unaffected
  - Portability: clean

- **2026-09-02 17:48Z — ponytail always-carried; AGENTS.md verification block**:
  - Changed: `skills/ponytail/SKILL.md` — removed `disable-model-invocation: true`; description 323 → 195 chars (trimmed routing prose, kept triggers)
  - Changed: `AGENTS.md` — Cadence +2 lines from test/ pair evaluation: narrowest-relevant-check matrix (test/typecheck/lint/build), never claim success without verification
  - Why: reliability + focus — empty catalog caused model-invocation misses; ponytail requested always-on to bias toward minimal thinking by default
  - Measured: AGENTS.md 1425 → 1691 chars (≈349 → ≈423 tok); visible-skill catalog 0 → 1 skill (347 chars ≈ 86 tok + ~120 tok intro); validate-skill.mjs PASS
  - Risk: low — prefix changed; start a fresh session

- **2026-09-02 — All skills: manual invocation only (disable-model-invocation)**:
  - Changed: `skills/*/SKILL.md` (all 16) — added `disable-model-invocation: true` to frontmatter
  - Why: tokens — skill catalog (~1k tok) removed from every-turn prefix; skills now load explicitly via `/skill:name`
  - Measured: catalog block 3934 desc chars + wrapper → 0 bytes; visible-in-prompt skills 16 → 0 (verified via pi `loadSkillsFromDir` + `buildSystemPrompt`); all 16 pass `validate-skill.mjs`
  - Risk: med — no auto-triggering; user must invoke `/skill:name` manually when a skill is needed
  - Portability: clean

- **2026-09-01 — Tavily portable auth setup (tavily/setup.sh)**:
  - Changed: tavily/ (new) — setup.sh bootstrap (installs uv via astral.sh + tvly CLI, symlinks ~/.tavly → repo tavily/ dir, early-exits if already linked) + session.json; works on macOS + Linux, no brew dependency.
  - Why: portability — OAuth token stored in repo dir so `git pull` + `setup.sh` on any machine restores Tavily auth without re-login.
  - Measured: 1 new script (32 lines); tvly 0.1.6 installed; auth-check fixed (pipefail masked unauthenticated exit); skip-path verified (exit 0, no reinstall).
  - Risk: med — auth token committed to git; repo must stay private. OAuth login still pending.
  - Portability: clean — bash + curl + ln only; astral.sh uv installer covers macOS/Linux.

- **2026-08-31 — all markdown swept for staleness**:
  - Changed: README.md — skill count 14→16 (tavily-search/tavily-extract were missing from the tree), token floor ~1.3K→~1.6K, map-integration comment gains library-dev scope, persistence table's HARNESS-ARCHITECTURE.md row → README.md (this file), Last updated refreshed. prompts/commit.md verified current; AGENTS.md clean; dated history (CHANGELOG/skills-audit/harness-audit-report) untouched by design.
  - Why: reliability — the living map must match reality after renames/additions.
  - Measured: 6 README fixes; 0 stale markers outside dated history; all README-referenced files exist (usage-metrics.py, validate-skill.mjs, .nvmrc, .gitignore); skill count 16 verified.
  - Risk: none — docs only, no prefix impact.
  - Portability: clean.

- **2026-08-31 — CHANGELOG normalized: latest-first order + unified headings**:
  - Changed: all 47 entries re-sorted latest→oldest (were append-order with future-dated 2026-12-17 entries interleaved); 31 `##` headings unified to `###`; `2026-08-28THH:MMZ` timestamps and `(rev N)` markers moved out of the date field (kept in heading/title). Header docs now mandate top-insertion, synced into harness-engineer SKILL.md step 5 ("append"→"add at TOP") and README.md tree line.
  - Why: reliability — the changelog is the harness audit trail; jumbled order + mixed levels made entries hard to find and deltas hard to compare.
  - Measured: 47 entries, 0 content lines touched (headings/order only); order now 100% descending (2026-12-17 ×2 → 2026-08-11 ×11).
  - Risk: low — note: the two 2026-12-17 dates predate today (2026-08-31); kept as written, correct them if typos.
  - Portability: clean.

- **2026-12-17 — HARNESS-ARCHITECTURE.md promoted to README.md**:
  - Changed: `git mv HARNESS-ARCHITECTURE.md README.md`; prepended repo intro + new-machine quick start (clone, auth.json, ~/.agents neutralize, Node ≥22). Updated 4 references in skills/harness-engineer/SKILL.md; refreshed stale bits (Last updated, settings.json packages note, AGENTS.md purpose line). skills-audit.md historical mentions left as dated history.
  - Measured: README.md 10,776 bytes (was 10,776-byte architecture doc + ~800-byte intro); no prefix cost (README is not auto-loaded). validate-skill.mjs PASS for harness-engineer. Portability: 0 hits.
  - Risk: none — documentation only. skill body changed → fresh session recommended.

- **2026-12-17 — AGENTS.md slim + package cleanup + desc trims**:
  - Changed: Ponytail ladder merged into Behavioral Core as one bullet ("Solve with the least that works: ..."); `## Ponytail` section removed. `## Skills` section removed from AGENTS.md — routing covered by skill-creator's description; merge-preference rule already in skill-creator body step 2. Removed both extension packages from settings.json; deleted stale `~/.pi/agent/npm` package cache. Trimmed descriptions: systematic-debugging, harness-engineer, ponytail.
  - Measured: AGENTS.md 2,008→1,460 bytes (502→365 tok); catalog descs 3,977→3,919 chars (~994→~980 tok); permanent floor ~1,496→~1,345 tok (−151). All 3 edited skills validate-skill.mjs PASS. Portability: 0 hits.
  - Risk: low — ladder wording compressed but all rungs preserved; skill routing relies on descriptions (unchanged behavior). Prefix changed → fresh session required.

- **2026-08-31 — session-learnings folded into 3 skills (react-bkoi-gl v3 sessions)**:
  - Changed: body-only edits from the last 2 react-bkoi-gl sessions (08-26 already absorbed by playwright/browser skills; 08-30 gaps closed now). `map-integration` +new "Developing react-bkoi-gl itself (v3)" section (zero-config worker contract, engine-utils re-export, exports surface, framework-suite invariants, TerrainControl/Marker guards, docs split, checklist item 6; sections renumbered). `sdk-development` +framework-matrix consumer-testing bullet (repro apps × bundler majors, tarball-never-link, runtime-render assertions, sha-keyed prepare) +dead-script/file sweep in release step 5. `playwright-tester` +one-HUD-across-headed-suites +instant-case-transitions bullets.
  - Why: focus — mistakes/feedback from those sessions (silent v6 render breakage, "visual UI does not match", "after 10s timer window taking time", "does all scripts required? remove dead") become portable guards.
  - Measured: map-integration body 6,155→8,803 B (+2,648, desc 320 chars unchanged); sdk-development +~0.7 KB body; playwright-tester +~0.6 KB body; all 3 validate-skill.mjs PASS; skill count 16; descriptions untouched → prefix byte-stable, no fresh session required.
  - Risk: low — bodies load on demand.
  - Portability: clean.

- **2026-08-31 — skill-creator renamed to skill-manager**:
  - Changed: `skills/skill-creator/` → `skills/skill-manager/` (dir + `name` field + body title); README.md skill tree line updated. Purpose broadened from creation-only to create/manage/maintain.
  - Why: focus — name now matches the description's existing scope ("new/fix/merge/rename/split skill"); no functional change.
  - Measured: skill count 16 unchanged; desc 213 chars unchanged; body byte size unchanged (rename is length-neutral); validate-skill.mjs PASS; 0 stale `skill-creator` refs in functional files (CHANGELOG/skills-audit historical mentions left as dated history).
  - Risk: low — name/desc block changes the prefix → fresh session required; `/skill:skill-manager` activates it.
  - Portability: clean.

- **2026-08-31 — Tavily onboarded as primary research routing**:
  - Setup: uv + Python 3.12 (user-local, system 3.8 untouched), tavily-cli 0.1.6, OAuth verified, live search verified. 8 skills installed, then trimmed.
  - Kept: tavily-search + tavily-extract (both research intents have an always-visible routing surface). Deleted: tavily-cli/map/crawl/research/dynamic-search/best-practices (CLI one-liners; re-add via `npx skills add tavily-ai/skills --skill <name> --agent pi --global`). Deleted scripts/web-search.py (DDG IP-challenged, 0/6; superseded).
  - Changed: browser-tools desc + research routing line now point at tavily skills; web-fetch.mjs noted as cheapest static-page extractor. validate-skill.mjs PASS x3.
  - Measured (definitive frontmatter parse, quotes stripped): catalog 4,853 chars (~1,213 tok) across 16 skills; floor ~1,334→~1,578 tok (+244 for reliable routing). Bench: tvly search 4.2s/812B lean vs DDG blocked; tvly extract 2.3s/29.1KB vs web-fetch 2.0s/22.6KB (−23% tokens, no quota). Free tier 1,000 req/mo.
  - Risk: low. Prefix changed → fresh session required to activate tavily skills.

- **2026-08-31 — browser-tools rescoped: Playwright/e2e ONLY**:
  - Changed: description rewritten to route research/web → scripts/web-search.py + web-fetch.mjs, QA/general debug → elsewhere; "When to Use" now opens with scope fence + routing; research ladder tier-3 (Chrome fallback for research) removed; "Other uses" section replaced by "Out of scope".
  - Measured: desc 329→301 chars (82→75 tok, −7); body 14,203→~14,900 B (on-demand only); validate-skill.mjs PASS; catalog avg ~71 tok (no score impact).
  - Rationale: user directive — Chrome reserved for e2e; research must use the cheap headless ladder.
  - Risk: low — e2e workflows unchanged. Prefix changed (desc) → fresh session required.

- **2026-08-31 — cheap research ladder: web-search.py + skill wiring**:
  - Added: `scripts/web-search.py` (python3 stdlib, DDG lite → "title — URL" lines, --snip). Zero deps, portable.
  - Changed: browser-tools SKILL.md "When to Use" gains read-only research ladder: web-search.py → web-fetch.mjs (capped) → Chrome only for JS/DOM/challenged engines. Description untouched → prefix byte-stable.
  - Measured: search output ~50–411 B vs ~800+ tok Chrome results page; article extract 2,025 B capped vs ~6,800 B full browser-content dump (−70%). Keyless engines bot-hostile today (DDG 202 challenge both endpoints, Mojeek shell, 4/4 SearXNG 429/403) — Chrome remains the fallback; free search API key (Tavily/Serper) is the only robust fix, needs user signup.
  - Risk: low — additive; web-fetch.mjs reused as-is.

- **2026-08-31 — usage-metrics script + skill pointer (evidence from web R&D)**:
  - Added: `scripts/usage-metrics.py` (python3 stdlib, portable) — per-model token profile (in/out/reasoning per turn, cache %, cost), top-5 cost-tail sessions, first-turn prefix trend. Replaces repeated hand-written JSONL analysis (done 3x in 2026-08-31 session).
  - Changed: harness-engineer "Optional deep evidence" section now points to the script. Description untouched → prefix byte-stable.
  - Measured: AGENTS.md 1,460B unchanged; skills 14; he body 5,007→5,246B; permanent floor unchanged (~1,298 tok). Script output: glm-5.2 reasoning 342 tok/turn = 55% of its output bill; top session 436 turns/$17.50 (cost tail), deepseek-v4-flash cheapest (1,401 in/t, 0 reasoning, 98% cache).
  - Rationale: Anthropic/Glean research — token cost lives in reasoning output and unmanaged session tails, not prefix wording; audit loop must see them.
  - Risk: none — additive, on-demand only. No fresh session needed (body-only edit).

- **2026-08-28 17:35Z — micro-polish: skill-creator desc de-duplicated**:
  - Changed: skill-creator description dropped the restated "load BEFORE any skill edit" rule (AGENTS.md already routes it always-on); triggers and negative scope kept.
  - Measured: skill-creator desc 262→211 chars (~65→~52 tok, −13 tok); skill count 14; catalog ~1,058→~1,045 tok; permanent floor ~1,475→~1,462 (chars/4 heuristic; consistent with audit-report method ~1,463). validate-skill.mjs PASS. No disable-model-invocation changes (youtube-transcript's link-paste flow depends on model invocation; not worth 47 tok). No other descs touched.
  - Risk: low — AGENTS.md guarantees the routing rule survives. Prefix changed → fresh session required.

- **2026-08-28 17:20Z — audit capability folded into harness-engineer (no new skill)**:
  - Extended: skills/harness-engineer/SKILL.md gained "## Audit mode" (inventory chars/4, permanent floor, Health Score rules from the 2026-08-28 audit, harness-audit-report.md output, previous-report diff, audit-only = no file changes). Body now points at HARNESS-ARCHITECTURE.md/CHANGELOG.md as the living map.
  - Measured: description 470→350 chars (~118→~87 tok, −31 tok permanent catalog); skill count unchanged (14); validate-skill.mjs PASS.
  - Rationale: one meta skill for inspect/audit/diagnose/change/measure/log; no near-duplicate harness-audit skill created.

- **2026-08-28 16:55Z — track harness-audit-report.md in git**:
  - Changed: removed harness-audit-report.md from .gitignore; now tracked (it is a measured audit artifact worth syncing across machines, not a regenerable cache).
  - Measured: index 65 files.

- **2026-08-28 16:45Z — merged PORTABILITY.md into HARNESS-ARCHITECTURE.md**:
  - Merged: full portability contract (git sync, tracked/machine-local tables, keys, post-clone setup, portability rules) into HARNESS-ARCHITECTURE.md's "Portability contract" section, replacing its redundant summary; PORTABILITY.md deleted.
  - Measured: index 64 files; harness-engineer SKILL.md re-validated PASS after removing the PORTABILITY.md reference; live docs (ARCHITECTURE tree, doc-map, skill scope) carry 0 dangling references (append-only CHANGELOG/skills-audit history mentions left as-is).
  - Rationale: one doc instead of two overlapping; arch doc was already the map, PORTABILITY the territory.
  - Risk: none — content preserved verbatim in structure, only nesting level changed.

- **2026-08-28 14:58Z — re-audit (no changes made)**:
  - Re-ran quantitative harness audit; refreshed harness-audit-report.md.
  - Measured: skill count 14; catalog 3842 B desc (~961 tok); AGENTS.md 2008 B (~502 tok); permanent floor ~1463 tok (was ~2467, −41%); Health Score 95/100 (was 50). Portability: 0 hits. Skills dir clean (0 node_modules/.zip/._ files).

- **2026-08-28 — SDK twin merge + description catalog trim (audit-driven)**:

Driven by harness-audit-report.md (Health 50/100; permanent floor 2467 tok; avg desc 131 tok;
2 descs > 250 tok; AGENTS.md/ponytail duplication; skills-dir pollution). Note: HARNESS-*.md /
PORTABILITY.md / skills-audit.md are disk docs — never auto-loaded by pi (loader candidates:
AGENTS.override.md, AGENTS.md, CLAUDE.md only) — so their sizes cost 0 session tokens.

  - Changed: skills/sdk-development-npm/ — deleted (merged into skills/sdk-development/).
  Unique npm content preserved: new "E2e infra details" subsection (.env hygiene: commit
  .env.example, gitignore .env precisely; no invented window.__*__ globals). The other ~95%
  of the twin (package surface, externals, pack smoke, test pyramid, vitest pitfalls,
  upgrade protocol, docs set, R&D, publish gate) was already duplicated verbatim.
  - Changed: descriptions shortened in 10 skills (frontmatter only, bodies untouched except
  the merge): sdk-development 1045→325 B, playwright-tester 746→325, ponytail 670→327
  (now points to the AGENTS.md ladder instead of restating it), skill-creator 664→262,
  browser-tools 622→323, map-integration 505→318, ponytail-review 472→315, audit 437→315,
  frontend-design 411→272, youtube-transcript 69→189 (was validator-FAIL vague; added triggers).
  - Changed: hygiene — removed skills/browser-tools/node_modules (125 MB; regenerable: cd
  skills/browser-tools && npm install), skills/{browser-tools,playwright-tester,sdk-development}.zip,
  all macOS ._* AppleDouble files under skills/ and agent root. skills/ 125.6 MB → 556 KB.
  - Changed: docs — HARNESS-ARCHITECTURE.md skill tree 9→14 entries (was stale, missing
  audit/playwright-tester/map-integration/sdk-*/skill-creator) + date; skills-audit.md §14 appended.
  - Why: tokens (catalog −926 tok/session) + focus (one SDK entry point instead of two near-twins
  with ~90% identical trigger lists) + portability (AppleDouble junk signaled non-rsync copy).
  - Measured: skill count 15→14; catalog 7859→4157 B (~1965→~1039 tok, −53%); avg desc 131→~74 tok;
  desc max 261→~85 tok (0 descs > 250 tok, was 2); permanent floor 2467→~1541 tok (−37%);
  AGENTS.md unchanged (2008 B / ~502 tok). All 14 skills PASS validate-skill.mjs.
  Cross-check vs measured baseline: lean first-call prompt 2557 tok → predicted new full-harness
  prompt ≈ 2557 + 1039 + ~700 harness scaffolding ≈ 4300 tok (was 5731; −~1400 tok/call, re-sent
  every turn). ponytail/ponytail-review NOT merged: per skills-audit.md Rev 7 evidence, the review
  body (L<line>:<tag> format) exists only in ponytail-review; boundary tightened instead.
  - Risk: low — descriptions are routing hints; bodies untouched (except merge addition). Worst
  case: a trigger phrase misses and a skill loads on explicit /skill: mention. Rollback: tar at
  ~/.pi-backups/pi-skills.pre-trim.20260828-204608.tar.gz (pre-change skills + AGENTS.md + docs).
  - Portability: fixed — removed macOS AppleDouble junk + in-skill node_modules (both were
  non-portable artifacts); browser-tools needs `npm install` on a fresh machine (already declared
  "not bundled" in PORTABILITY/ARCHITECTURE contract).

- **2026-08-21 — provider cleanup: zai + deepseek only; docs synced**:
  - Changed: auth.json (removed openrouter/opencode/omniroute keys), models.json (removed omniroute block → {}), models-store.json (dropped openrouter+opencode cache), removed zen-provider.template.json; PORTABILITY.md + HARNESS-ARCHITECTURE.md provider sections rewritten for zai(default)+deepseek only.
  - Why: openrouter/opencode/omniroute were only smoke-tested once (08-10 say-hi loop); not production. DeepSeek is built-in + already keyed (verified in models-store + auth.json) → no config needed.
  - Measured: auth.json 3 keys → 2; models.json providers 1 → 0; tar.gz provider-model cache −~250 entries.
  - Risk: low (zai stays default; deepseek available via /model).
  - Portability: clean — auth.json + models.json confirmed present in pi-portable-*.tar.gz.

- **2026-08-20 — skill usage audit (65 sessions) + fixes**:
Measured: skills 9 → 9 (removed youtube-transcript [0 loads, niche], added audit). Real body loads: browser-tools 4, systematic-debugging 3, refactoring-ui 1, brainstorming 1, frontend-design 0, ponytail/-review/playwright-e2e/youtube-transcript 0.
  - systematic-debugging: description retuned to actual prompt phrasing (TypeError/runtime error/API wrong data/build failure/regression) — was missing concrete-bug sessions (01a018c9, 01a00e56, 01a00a25).
  - frontend-design: description narrowed to "NEW files from scratch", explicit NOT-cases for editing existing UI and logic-only changes — was 0-load with misses attributed to routing.
  - audit skill added, distilled from session 01a01ddf (fallow dead-code cleanup): independent verification, non-import string scan, cascade loop, scripted-edit diff review, orphan JSDoc sweep, behavior-identical gate.
  - AGENTS.md untouched per user instruction.

- **2026-08-13 — radically simplify /release + /changelog (goal-oriented, not procedure-oriented) (rev 4)**:

**What:** User reported a hand-typed sentence ("update changelog based on current
changes and suggest a single commit message") works better than the slash
commands. Root cause: the prompts had become rigid prescriptive procedures (exact
`git diff` commands, numbered steps, elaborate format/version/bump rules) that
constrain and mis-fire. A capable agent does better with a clear goal than a script.

Rewrote both to ~4 short goal-oriented lines mirroring the user's phrasing, keeping
only the guardrails that earned their place: source = current uncommitted
working-tree changes (NOT history/tags — the anchor that killed all prior bloat);
match existing CHANGELOG format, don't touch older entries; conditional version
bump; one conventional commit never `chore(release)`; don't commit until confirmed.
Dropped every prescriptive `git diff ...` command and step number — the agent picks
how to see the changes.

**Measured:** release.md 2510→859 B (-66%), changelog.md 1251→483 B (-61%).
Prefix byte-stable. Portability: 0 hits.
**Risk:** low — less prescription = fewer failure modes; the agent's general
intelligence handles format/version detection from the real files.

- **2026-08-13 — revert changelogen; /release + /changelog back to working-tree diff; changelogen package removed (rev 3)**:

**What:** changelogen (added rev 2) only reads COMMITTED history, so it forced a
"commit your work first" response on the user's uncommitted working tree — wrong
for their flow. Reverted both prompts to `git diff HEAD` (staged + unstaged working
tree = exactly what VS Code shows as modified), keeping the format-matching lessons:
match the project's Keep-a-Changelog section names + date format, no emoji, no
commit hashes, idempotent block (replace if target version exists), conditional
bump (skip if no package.json `version`), content-based commit (never
`chore(release)`). Added explicit "do NOT tell me to commit first" guard.

**Cleanup:** removed the changelogen package my test runs cached —
`~/.bun/install/cache/changelogen@0.6.2@@@1` + `~/.bun/install/cache/changelogen`
(bun) and `~/.npm/_npx/6ecdf59648e29544/` (npm/npx staging, full dep tree).
Verified zero `changelogen` left in bun/npm caches and zero refs in prompts.
No package was ever added to settings.json.

**Why:** the user's release workflow is uncommitted-working-tree → one commit;
changelogen's committed-only model is incompatible. `git diff HEAD` covers it and
also kills the original bloat (which came from a stale `<tag>..HEAD` range, not
from the working tree).

**Measured:** release.md 2960→2510 B, changelog.md 1585→1251 B. AGENTS.md 4360 B,
9 skill descriptions 2908 B — prefix byte-stable. Portability quick-check: 0 hits.
**Risk:** low — removed a runtime network dependency (npx fetch) the harness no
longer needs.

- **2026-08-13 — /release + /changelog: switch to changelogen (deterministic), fixing the real root cause (rev 2)**:

**What:** Rewrote both prompts to use `npx --yes changelogen@latest --from=<prev-release-commit>` as the changelog generator, after evidence on akg-frontend revealed the TRUE root cause of every prior failure.

**Root cause (evidence):** akg-frontend's `git describe --tags` → `v1.4.1`, but CHANGELOG.md is already at `1.11.1` (and the only `bump to` commit-message is `1.9.0`). So BOTH tag-based ranges (`git diff <tag>..HEAD` → 35 commits) AND `git log --grep='bump to'` (→ 1.9.0) regurgitated already-documented work — exactly the bloat in the original 1.12.0 complaint. Verified live: `changelogen` with no `--from` emitted everything since stale v1.4.1 incl. "Bump to 1.9.0".

**Fix:** the `--from` point is now **the last commit that touched CHANGELOG.md** (`git log --format='%H' -- CHANGELOG.md | head -1`) = the previous release commit — format-agnostic, survives stale tags and inconsistent bump-message conventions. Verified: `--from=<that commit>` yields only genuinely-new commits (empty right now, since HEAD == the 1.11.1 commit — correct: nothing to release until new work is committed).

**Other fixes preserved/added:**
  - Deterministic generation ⇒ no hallucinated bullets (original issue #2 root cause).
  - Translate changelogen's emoji sections → the project's Keep-a-Changelog names (🚀→Added, 🩹→Fixed, 💅/🎨→Changed, 🏡/❤️→omit); strip per-bullet hash links; match existing date format (DD-MM-YYYY).
  - Bump package.json ONLY if a `version` field exists — else SKIP silently (akg-frontend has none; version is generated from CHANGELOG via scripts/generate-version.mjs). Original issue #1.
  - Commit message from the release's top change, **never `chore(release)`**. Original issue #3.
  - Idempotent: if the target-version block already exists at top, replace its sections.

**New runtime dependency:** `npx --yes changelogen@latest` (per release). npx ships with Node (pinned via .nvmrc) — portable; bunx works as a faster alternative on machines with bun. No package added to settings.json.

**Measured:** release.md 1817→2960 B, changelog.md 969→1585 B (prompts/ only). AGENTS.md 4360 B, 9 skill descriptions 2908 B — prefix byte-stable, no fresh session needed (prompts are slash-autocomplete-only).
Portability quick-check: **0** hits.
**Risk:** low-med — introduces an npx network fetch per release; deterministic tool removes the hallucination failure mode entirely.

- **2026-08-13 — /release: missing version field now SKIPS bump, not aborts (rev)**:

**What:** Corrected yesterday's over-reach. When `package.json` has no `"version"`
field, `/release` now **skips Step 2 (the bump) silently** and still produces the
changelog + commit — instead of aborting the whole release. The version for the
changelog header/commit footer still comes from `$1`/auto-inferred level.
`/bump` reverted to original "stop and say so" (its sole purpose IS the bump, so
no-version genuinely means nothing to do there). `/release` Step 3 staging line
now says `(+ package.json if you bumped it)` to match the conditional bump.

**Why:** user intent was "leave package.json alone if it has no version," not
"skip the entire release." The release can proceed without a version field in
package.json (version comes from the level arg).

**Measured:** release.md 3690→3708 B, bump.md 1094→967 B. Prefix (AGENTS.md +
9 skill descriptions) unchanged. Portability quick-check: **0** hits.
**Risk:** low — prompt-template-only. No fresh session needed (not in prefix).

- **2026-08-13 — /release + /changelog + /bump: diff-grounded changelog, hard version gate, content-driven commit subject**:

**What:** Three fixes to the release prompts, all from real /release misuse
(akg-frontend 1.12.0 changelog listed entries not tied to code changes, and every
release produced `chore(release): vX.Y.Z`).

1. **`prompts/release.md` Step 1 — changelog now DIFF-grounded.** Replaced
   `git log` commit-subject mapping with `git diff --name-only <tag>..HEAD` +
   `--stat` samples. Every bullet must tie to a changed path; drop what isn't
   backed. Empty Added/Fixed explicitly allowed over invention.
2. **`prompts/release.md` Step 2 (and `prompts/bump.md` step 1) — version-field
   hard gate.** If `package.json` has no `"version"` field, STOP immediately, do
   not ask, do not proceed. One-line message only. (Was "stop and say so" —
   ambiguous, sometimes prompted the user.)
3. **`prompts/release.md` Step 3 — commit subject derived from the changelog's
   top change**, conventional-commits form `<type>(<scope>): <subject>` +
   `changelog: vX.Y.Z` footer. Explicitly **never `chore(release)`**.
4. **`prompts/changelog.md`** aligned to the same diff-grounded method so
   `/release` and `/changelog` don't contradict.

**Why:** commit subjects ≠ shipped code (root cause of invented entries); the
release commit should describe the release, not be a generic tag marker; missing
version is a hard stop, not a question. Cache impact: zero (prompt templates are
NOT in the prefix — slash autocomplete only), so no fresh session needed.

**Measured:** release.md 2019→3690 B, changelog.md 1077→1502 B, bump.md 965→1094 B
(prompts/ only; AGENTS.md 4360 B unchanged, prefix untouched). Skill count 9,
skill descriptions 2908 B unchanged. Portability quick-check: **0** hits.
**Risk:** low — prompt-template-only edits; no functional code. No prefix change.

- **2026-08-12 — Remove redundant `## Skills` section (skills + slash list)**:

**Question (user):** is listing skills + slash commands in AGENTS.md required,
given skills auto-invoke and prompts are manually invoked? "Research via web
search."

**Research method:** no web-search tool available — used the authoritative
primary source instead (pi's own docs + the live tool defs in my system prompt),
which is strictly better than web search for pi-internal behavior.

**Evidence (decisive):**
  - `skills.md` L64-71: "At startup, pi scans skill locations and extracts names
  and descriptions. The system prompt includes available skills in XML format…
  progressive disclosure: only descriptions are always in context." → pi ALREADY
  injects every skill's name+description into the model context (visible to me
  as `<available_skills>`), and its system prompt already states the load-on-match
  mechanic. The AGENTS.md "## Skills" paragraph was a pure restatement.
  - Cross-references already live in the descriptions themselves: frontend-design →
  "NOT for polishing → refactoring-ui"; refactoring-ui → "NOT for building →
  frontend-design"; ponytail vs ponytail-review split by verb (write vs review).
  → the condensed "Disambiguations" line was redundant.
  - `prompt-templates.md` L57/33/46: template descriptions render in the `/`
  autocomplete dropdown (TUI), NOT in model context; the body expands into the
  user message only on `/invoke`. → prompts are user-driven; the model doesn't
  need the slash-command list.

**Removed:** entire `## Skills` section — skill-discovery explanation +
disambiguations + slash-command list (`/preflight /commit /changelog /bump /release`).

**Kept (verified, not changed):** the Token-economy strategic-read ladder —
grounded in the real `read` tool semantics ("truncated to 2000 lines or 50KB…
Use offset/limit" → bare whole-file reads of big files waste budget/truncate the
wrong region), `rg` via `bash` (no standalone rg tool), and `git diff` for
changes. Already accurate; no edit.

**Tradeoff (acknowledged):** the model loses proactive slash-command suggestion
(e.g. "run /preflight first"). Prompts remain fully user-invokable via `/`;
acceptable per the manual-invocation model. Skill disambiguation now relies
solely on the pi-injected descriptions (which DO cross-reference).

**Measured:** AGENTS.md 4968→4360 B (−608 / −5 lines this turn). **Net across
the ENTIRE feedback process: 5419→4360 B (−1059 ≈ −265 tok/session).** Prefix now
≈ 1.8 K tok (7268 B) — BELOW the original 1.9 K architecture estimate, despite
gaining 4 ambiguity fixes earlier. Skill count 9, skill descriptions 2908 B
(unchanged). Portability quick-check: **0** hits.
**Risk:** low — removal of restated content only; pi's own system prompt carries
the skill mechanics. Refreshed HARNESS-ARCHITECTURE.md token figures.
**Prefix changed → recommend a fresh session** for cache.

- **2026-08-12 — Global AGENTS.md de-projectified; CLAUDE.md test-line fixed**:

**Directive:** "global AGENT.md should not contain project/stack-specific
content." The global file loads in EVERY session (incl. non-Barikoi: `~/.pi`,
`Downloads`, the `pi` repo) — stack/Barikoi-architecture content was waste there
and a DRY duplicate of per-project CLAUDE.md.

**Removed from `AGENTS.md`:**
  - **`## My stack` section entirely** (React 18, Ant Design 4, Redux Toolkit,
  Barikoi GL Maps, Axios, Socket.io, Node ^18, JS/JSX, Vite/Next.js). All of it
  lives in each project's CLAUDE.md (verified: dropx-admin/CLAUDE.md covers all).
  - **Project-architecture bullet** (App.config.js centralization, Redux slices,
  permission dot-notation, `user_type === 1`, NEXT_PUBLIC_AUTH_URL example) —
  dropx-specific; already in its CLAUDE.md verbatim.
  - **Preserved (relocated):** the general "audit third-party code → flag, don't
  silently fix" clause moved into the Think-before-coding bullet (it's a general
  work-principle, not project-specific).

**Also (approved prior turn, now the content's correct home):**
  - `dropx-admin/CLAUDE.md`: removed bogus `npm test # Jest via react-scripts` —
  package.json has NO test script and NO test runner installed (not react-scripts,
  not vitest, not jest). Project docs outrank global per pi precedence, so a stale
  project line could have re-fired the bug the global strip closed.

**Methodology correction (integrity, per external "verify the 56" flag):**
Two turns ago I justified the "normal mode" fix with "56 session uses." That was
a SLOPPY grep — total string hits across ALL session files incl. self-reference
(my own harness sessions discussing the term + AGENTS.md text re-read into
logs). True user-TYPED invocations of "stop ponytail"/"normal mode" = **2**.
The fix itself stands (the term WAS undefined regardless of count), but the
magnitude was overstated. Lesson logged: isolate user-role messages before
quoting a usage count. (чужой check: clean — not in any persisted file.)

**Measured:** AGENTS.md 5762→4968 B (−794 / −4 lines this turn). **Net across
ALL feedback turns: 5419→4968 B (−451)** — leaner than before despite +4
ambiguity fixes. Prefix back to ≈ 2.0 K tok (7876 B), matching the original
architecture estimate. Skill count 9, skill descriptions 2908 B (unchanged).
Portability quick-check: **0** hits.
**Risk:** low — global file is now project-agnostic by design; per-project
specifics rely on each repo's CLAUDE.md being accurate (dropx-admin verified;
merchant/laboni-express CLAUDE.md accuracy not audited this pass — flag for
user). Refreshed HARNESS-ARCHITECTURE.md token figures.
**Prefix changed → recommend a fresh session** for cache.

---

- **2026-08-12 — AGENTS.md 2nd feedback pass: DRY trims + drop stale count**:

**Source:** refined external review. **Important:** reviewer was partly working
from a pre-last-turn snapshot — 4 of their flagged items (Vite/react-scripts
contradiction; stop-ponytail scope; Karpathy ALWAYS-ON tag; verify definition)
were ALREADY fixed last turn. Confirmed present (4/4). No re-work.

**Accepted (DRY / drift):**
  - **Removed "I value the laziest correct solution, surgical diffs, and being
  asked before destructive operations."** Pure DRY violation — every clause is
  an enforceable rule elsewhere (Ponytail / How-I-Work / Safety). Keeping a soft
  copy risks it drifting from the hard rules when those are tightened.
  - **Removed "I build React/Next.js dashboards and admin panels."** Now redundant
  with the corrected Stack line (covers both, repo-scoped).
  - **Dropped "(all 38)" from the skills-archive note.** Proven stale: archive
  actually holds 82 `SKILL.md`s. Vindicates the drift warning — the file is the
  source of truth, the prose count added nothing load-bearing.

**Rejected (would bloat prefix / lose load-bearing context):**
  - Inline `# VERIFY:` markers next to stale-risk claims — NO. AGENTS.md is the
  model's always-on instructions, not a maintenance log; inline markers cost
  prefix bytes every turn and confuse the model. Verification lives in the
  snapshot loop / changelog / portability-check, not inline prose.
  - `user_type === 1` → named enum — NO (again). Raw value is the portable
  constant in a GLOBAL doc; enum names vary per repo (drifts worse).
  - Title line / skill disambiguations / slash-command list / skills-audit pointer
  — kept; each is load-bearing (tone / anti-co-fire / proactive suggestion /
  pointer-not-claim).

**Measured:** AGENTS.md 5922→5762 B (−160 ≈ −40 tok/session). Net across BOTH
feedback turns: 5419→5762 (+343 ≈ +86 tok/session). Skill count 9, skill
descriptions 2908 B (unchanged). Portability quick-check: **0** hits.
**Risk:** low — prose trims only, no behavior/tooling change; the removed
soft-preference sentence is fully covered by the hard rules it duplicated.
Refreshed HARNESS-ARCHITECTURE.md token figures (5762 B / 8670 B prefix).
**Prefix changed → recommend a fresh session** for cache.

---

- **2026-08-12 — AGENTS.md feedback pass: 6 surgical scope/consistency fixes**:

**Source:** external review of global AGENTS.md. Triaged by evidence (session
history + per-repo `package.json`), not opinion. 3 of 9 suggestions REJECTED
(see below) to protect prefix budget.

**Accepted (evidence-backed):**
  - **Stack line (Vite/react-scripts contradiction)** — dropx-admin is Vite
  (`vite`/`vite build`, NO `react-scripts` dep); dropx-merchant is Next.js +
  vitest. Old line `Tests via Jest / react-scripts` was wrong for every active
  Vite/Next repo. Now: "Build/router/test **vary by repo** (Vite+React Router,
  or Next.js; Jest via react-scripts or vitest) — check `package.json` scripts +
  CLAUDE.md before guessing." Resolves Vite-vs-react-scripts AND Next.js-vs-RR
  in one line.
  - **"stop ponytail"/"normal mode" scope** — 56 session hits, 0 definition. Now
  explicit: suspends engineering ladder ONLY; Token-economy + Safety stay on.
  - **Audit-role scoping** — API/permission conventions tagged "my own Barikoi
  projects"; added "when auditing third-party code with different patterns,
  flag them; don't silently 'fix'."
  - **Karpathy always-on tag** — heading now "(ALWAYS ON — workflow cadence)";
  was unstated vs Ponytail's explicit ALWAYS ON.
  - **"verify" defined** — Karpathy loop: "verify = run the one test/build
  touched, not the whole suite."

**Rejected (would bloat prefix / lose clarity / drift):**
  - `user_type === 1` → named enum: NO. Raw value is the *portable* constant in a
  GLOBAL doc; a named enum varies per repo and would drift.
  - Merge Token-economy + Karpathy: NO. Distinct concerns (read-strategy vs
  loop-cadence); merging loses clarity.
  - Plan-mode go-ahead scope explicit: NO. Placement already scopes it; Karpathy
  "ask once" aligns, doesn't fight.

**Measured:** AGENTS.md 5419→5922 B (+503 ≈ +126 tok/session permanent prefix).
Skill count 9 (unchanged). Skill descriptions 2908 B (unchanged). Lines 41
(unchanged). Portability quick-check: **0** hits.
**Risk:** low — prose scoping only, reversible; no behavior/tooling change.
Caveat: this is the largest single AGENTS.md bump; each fix pays for itself by
preventing a recurring wrong-guess cycle (a bad `npm test` ≈ 1–3K tok/miss).
**Prefix changed → recommend a fresh session** for cache. NOTE (separate,
not auto-fixed): dropx-admin's project `CLAUDE.md` still says "Jest via
react-scripts" — also wrong for its Vite setup; flagged for user to fix.
Also refreshed stale token figures in HARNESS-ARCHITECTURE.md (was 4713 B;
now 5922 B / ~2.2K tok prefix).

---

- **2026-08-12 — Fix `/release` not writing CHANGELOG; lockfile now off-limits**:

**Symptom (user report):** `/release` returned only `chore(release): vX.Y.Z` and
skipped writing the CHANGELOG. Also: lockfile must never be read/modified
(treat `package-lock.json` like `node_modules`).

**Root cause:** `release.md` opened with a blanket "NO … until I confirm" and
ended step 3 with "Output in a fence." A cautious model conflated "don't commit"
with "don't edit files / don't bump," latched onto the fenced message as the
sole deliverable, and skipped steps 1–2. Step 1 was also a dense paragraph
(vs `changelog.md`'s clean numbered list that works).

**Changed:**
  - `prompts/release.md` — rewritten: explicit **DO steps 1–2 now / WAIT only for
  the `git commit` (step 3)** framing; step 1 mirrors the working `changelog.md`
  structure; added a "if diff empty, you skipped step 1" guard; lockfile removed
  from bump + verify + stage list.
  - `prompts/bump.md` — removed `npm version`/`pnpm`/`yarn` branching (it existed
  only to handle lockfile differences); now just `edit` the `version` field in
  `package.json`; lockfile explicitly off-limits; verify `git diff -- package.json`.
  - `prompts/commit.md` — **unchanged** (outputting one fenced commit message IS
  its defined job; not the bug).

**Measured:** release.md 1649→2019 B (+370); bump.md 1051→965 B (−86). Net
+284 B. **Prompt templates are token-free at rest** (load only on `/invoke`,
not in the always-on prefix) → **prefix token cost unchanged (0)**. Skill count
9, AGENTS.md 5419 B (unchanged). Portability quick-check: **0** hits.
**Risk:** low — prompt-only, no code; revert by restoring prior bodies. The DO/
WAIT framing is the real fix; if glm-5.2 still skips the edit, the empty-diff
guard in step 1 forces a retry. **Recommend a fresh session** only if you want
the changelog entry itself to reflect this (not required for prefix cache).

---

- **2026-08-12 — AGENTS.md token-economy clause (rg+limit over whole-file read)**:

**Changed:**
  - `AGENTS.md` "Token economy" bullet: + one clause — "If you already know the
  target symbol/line, `rg -n` it then `read` with `offset`/`limit` that region —
  never a whole-file `read` just to reach one block (biggest single
  context-bloat source)."

**Why:** Evidence from dropx-admin session `2026-08-12T15-46-35` (glm-5.2, 9
turns, ~82.7K tokens). The model *knew* it needed the `.catch` block but still
did a whole-file `read` of `AddMerchant.jsx` (11,593 B ≈ ~3K tok) on the first
move — the single largest chunk in the session. The existing ladder already
says `rg` before whole-file `read`, but only covers *discovery*; this clause
closes the narrower gap: known-target → `rg -n` + `read --offset/--limit`.
Also 2 `grep -rn` bash calls instead of `rg` (same session) — already covered
by existing rule, no edit.

**Measured:** AGENTS.md 5225→5419 B (+194 ≈ +49 tok/session). Skill count 9
(unchanged). Portability quick-check: **0** hits. **Risk:** low — one clause,
reversible. Caveat: glm-5.2 ignored an already-clear rule; if it ignores this
too, the fix is model/habit, not more bytes — do not keep stacking restatements.
**Prefix change → recommend a fresh session** for cache.

---

- **2026-08-12 — CC-session evidence: sharpen ponytail + AGENTS.md endpoint rule**:

**Trigger:** user asked for new skills + existing-skill improvements grounded in
Claude Code session history. Mined 2,238 CC prompts + 264 transcripts
(`~/.claude/projects/`) for (agent-action → user-correction) pairs.

**Finding:** every recurring CC mistake is already owned by an existing pi
skill/rule — frontend-design covers version-match (AntD v4/v5, Tailwind v3/v4)
+ AI-slop; ponytail covers over-abstraction; AGENTS.md covers safety. The gaps
were 3 *thin* rules, not missing skills. **No new skill minted** (would
duplicate frontend-design → minimal-core violation).

**Changed:**
  - `ponytail/SKILL.md` rung 5: "installed dep" → "installed dep, native feature,
  or available plugin" (evidence: `dont use playwright` — installed a
  browser-driver lib while a plugin + running server existed).
  - `ponytail/SKILL.md` Rules: + "No unrequested docs/specs/verbose changelogs"
  (evidence: `concise changelog, without too much detail`; speculative
  `docs/superpowers/specs/*.md` files generated unrequested).
  - `AGENTS.md` endpoint line: + "no hardcoded URLs, no redundant env vars when a
  base URL already exists" (evidence: `remove NEXT_PUBLIC_AUTH_URL, because base
  url is same, just update endpoint`).

**Existing-skill "mistakes" reviewed — NOT bugs:** `harness-engineer` shows 4
portability hits, all self-referential (the portability-check command listing
its own forbidden patterns as examples, lines 21/22/79/80). Intentional. No action.

**Measured:** AGENTS.md 5018→5225 B (+207); ponytail 6456→6777 B (+321).
Skill count 9 (unchanged). **Prefix change → recommend a fresh session** for
cache. Portability quick-check: **0** hits (edits added no paths/OS commands).
**Risk:** low — surgical additions, reversible. Root-cause fix (CC has empty
CLAUDE.md + only 2 skills) deferred to user approval.

---

- **2026-08-12 — strategic-read core rule + `/release` `/bump` go native (git reads, npm version)**:

**Prompt:** read file changes via `git`, only update if `package.json` has a
`version`, read only the top of CHANGELOG; make strategic reading a CORE harness
rule; web-search if needed then update.

**Web search? Not required.** Empirically verified the linchpin instead (stronger
evidence): in a throwaway dir `npm version patch --no-git-tag-version` bumped
1.2.3→1.2.4 in **both** package.json and package-lock.json, no tag, no commit.
That single command replaces the entire hand-edit-the-lockfile step.

**Changed:**
  - `AGENTS.md` (prefix): "Token economy" bullet → explicit **strategic-read ladder**
  (core rule): ① changed content → `git diff`/`git show`/`git log|head`;
  ② targeted → `rg` (`-l`/`-n`/`-q`); ③ headers → `read`+`limit`; ④ whole file → last resort.
  Adds the git rung the user named; keeps the never-`cat`/bounded-`git log` rules.
  - `release.md` + `bump.md`: lockfile hand-edit → **`npm version <level> --no-git-tag-version`**
  (native; syncs both version fields; model reads nothing). pnpm/yarn = surgical
  package.json edit only. Verify via **`git diff --stat`**, not file reads.
  Guard: `rg -q '"version"' package.json` → stop if absent.
  - `release.md` + `changelog.md`: **`read CHANGELOG.md limit 15`** (top only — header +
  latest block) to find the insert point; insert-only, never rewrite. Verify via
  `git diff CHANGELOG.md`.

**Not changed:** `/commit`, `/preflight` (already lean).

  - **Measured:** AGENTS.md 4713→4901 B (+188 — the new core rule; **prefix change →
  recommend a fresh session** for cache). Prompts: release 1943→1619, bump 1021→1031,
  changelog 1059→1061 B. Runtime: lockfile read ~8K→~0 tok; whole-CHANGELOG read →
  ~15 lines. Portability quick-check: **0** hits.
  - **Risk:** low. `npm version --no-git-tag-version` is standard npm; reversible by
  re-edit. Empirically confirmed, not assumed.
  - **Portability:** clean — `git`/`npm`/`pnpm`/`yarn` branches; no paths, no OS commands.

---

- **2026-08-12 — defaultThinkingLevel re-fixed max→medium (article-driven audit)**:

**Prompt:** learn harness engineering from the explainx.ai "Pi minimal agent
harness (Mario Zechner)" article, then rewrite the harness to match it; also
review github.com/amosblomqvist/pi-config.

**Diagnosis (evidence over opinion):** scored the harness principle-by-principle
against the article. The architecture *already* embodies the article's thesis —
minimal core (AGENTS.md 4713 B + 9 skills ≈ 1.9 K tok/session), progressive
disclosure (name+desc+path in prefix, bodies on-demand), primitives-over-features
(plan mode via the `npm:@narumitw/pi-plan-mode` **package**, not a skill — the
article's flagship "no plan mode → pi install package" example), self-hosting
(this skill + the changelog/arch/audit loop), full portability (0 non-portable
hits, `~`/`$HOME` only, POSIX `sh`). A wholesale "rewrite" would be slop and
violate ponytail rule 1 (does it need to exist?) + the harness-engineer
"prefer deletions" principle — so no rewrite.

**One real defect found:** `settings.json defaultThinkingLevel` had **regressed
to `max`** — contradicting this very doc (line 85) and skills-audit Rev 5
("max = heavy reasoning-token burn → set to medium"). `max` burns reasoning
tokens every turn, which is the exact anti-pattern the article's Databricks
evidence warns against (Pi won on *less* context per turn, not more). Also
confirmed the live prefix is clean: the stale skills (adhd/shadcn/ui-ux-pro-max/…)
seen in session logs are *text inside tool outputs reading this audit*, not real
auto-loads — `~/.agents/skills` is absent, only the 9 canonical skills exist.

**Changed:** `settings.json` `defaultThinkingLevel: "max" → "medium"` (restores
documented intent; escape hatch `--thinking high` unchanged). `HARNESS-ARCHITECTURE.md`
"Known constraints": rewrote the thinkingLevel line to flag `max` as drift-on-sight
(so it can't silently regress again) + added a one-line primitives-over-features
note recording that plan-mode is deliberately a package.

**Not changed (deliberately, YAGNI):** the pi-config repo's `bash-guard/`
extension would convert my *advisory* safety rules into *enforced* ones —
real improvement, but a new TS-extension + npm-dep surface; my advisory rules
have not been bitten. Surfaced for the user to opt into, not added unilaterally.
`stop-slop/` ≈ my existing `ponytail-review`; `subagents/`, `memory.ts` — no
current frontend-work need.

  - **Measured:** `settings.json` 211 → 214 B (value only). **Prefix byte-stable**
  (AGENTS.md 4713 B + 9 descriptions 2867 B untouched) → no session restart needed
  for cache; thinkingLevel is a runtime setting, not prefix material. Portability
  quick-check: **0** hits (unchanged).
  - **Risk:** low. One value; reversible. If `max` is ever genuinely wanted for a
  hard task, use `--thinking high` per-session instead of global `max`.
  - **Portability:** clean — JSON edit, no paths, no OS commands.

- **2026-08-11 — bundle.sh prints full post-bundle procedure inline (usability)**:

The success output was a one-liner — `Upload it to Google Drive. On the target:
see PORTABILITY.md -> Sync procedure.` — forcing a doc lookup every bundle.
User asked for the full procedure at the point of use (right after a successful
build). No logic change; pure output/UX.

  - **Changed:** `bundle.sh` — replaced the final `echo` pointer with a 3-step
  heredoc printed on success: (1) upload, (2) restore (`mkdir -p` +
  `tar -xzf … -C ~/.pi/agent` + `sh setup.sh`, overlay not wipe), (3)
  `nvm install 22 && nvm alias default 22 && pi`. References the exact
  `$(basename "$OUT")` so the printed tarball name is always correct. Matches
  PORTABILITY.md's documented procedure verbatim; an earlier 7-step draft was
  trimmed to the required minimum by dropping the optional `ls` verify and the
  on-demand per-skill `npm install` (browser-tools only, when first used).
  - **Why:** the procedure is only needed immediately after bundling; printing it
  there removes the doc-hop. Portable (POSIX `sh`, `~`/`$HOME` only, no OS-only
  commands).
  - **Measured:** `bundle.sh` **1468 → 1824 B** (+356 — echo block only; no logic).
  Iterated 7-step → 3-step in the same session before finalizing. **Prefix
  byte-stable** (AGENTS.md 4713 B + 9 descriptions 2908 B untouched — `bundle.sh`
  is NOT an always-on file) → no session restart needed. Verified by running
  `sh ~/.pi/agent/bundle.sh`: tarball rebuilt (464K), leak check
  `bin/npm/sessions/node_modules/*.log` = 0 each, 3-step procedure rendered with
  the real dated filename.
  - **Risk:** low. Output-only edit; bundling logic + excludes untouched.
  Reversible: restore the previous `echo` pointer line.
  - **Portability:** clean — heredoc is POSIX `sh`; all commands in the printed
  steps are macOS+Linux portable (`mkdir -p`, `tar -xzf`, `nvm`, `pi`).

- **2026-08-11 — document portability round-trip flow in HARNESS-ARCHITECTURE.md (doc-only)**:

  - **Changed (doc — `HARNESS-ARCHITECTURE.md`, NOT in prefix):** added a "Portability flow (bundle → sync → restore → first run)" section right after the "Portability contract" summary. The contract already said *what* travels (bundled vs machine-local); the new section says *how* it moves — the 4-step round-trip (bundle.sh → Google Drive → overlay-extract → setup.sh → pi auto-install), the overlay-not-wipe rationale (sessions/ keyed by absolute paths, bin/ OS-specific), and the macOS+Linux POSIX guarantee. Exact commands stay in `PORTABILITY.md`; the arch doc is the map.
  - **Why:** the bundle.sh / restore / Mac-vs-Linux discussion this session surfaced that the round-trip wasn't in the arch doc (the map re-read first every harness session) — only in PORTABILITY.md. Future audits + any restore now get the flow at a glance without a second file open.
  - **Measured:** `HARNESS-ARCHITECTURE.md` 7126 → 8444 B (+1318). **Prefix byte-stable: AGENTS.md 4713 B + 9 descriptions 2908 B unchanged** → no session restart needed. Skill count 9 → 9 (no skills-audit revision). Portability quick-check: 0 hits.
  - **Note:** `bundle.sh` internals (include-list → auto include-list simplification) were verified equivalent this session (460 KB byte-set identical; file-list diff empty) but NOT yet written — pending the portability-safe rewrite decision. Flow documented against current behavior either way (user-facing round-trip is identical).
  - **Risk:** none — doc-only, reversible, cache-safe.
  - **Portability:** clean (0 hits, unchanged).

---

- **2026-08-11 — thinking-level config fix + ponytail description trim (prefix −175 B)**:

  - **Changed (config — `settings.json`, effective next session):** `defaultThinkingLevel: max → medium`. The arch doc's *intent* was always `medium` (token-efficient); `max` was a stale setting burning max reasoning tokens/session. User bumps per-task via `--thinking high` when a hard task needs it. `hideThinkingBlock: true` left as-is.
  - **Changed (PREFIX — `skills/ponytail/SKILL.md` description):** 825 → 650 B (−175 B, −21%). Removed the full 7-rung ladder re-enumeration (already always-on in AGENTS.md) + condensed trigger phrasing. Kept: YAGNI + stdlib/native/dep preference; the "core ladder is in AGENTS.md; body = framework + modes" disambiguation; intensity levels (lite/full/ultra); scope (ANY coding task); trigger words (ponytail / lazy mode / simplest / minimal / yagni / do less / shortest path + over-engineering complaints); the NOT-case (non-coding). Activation signal preserved.
  - **Changed (doc — `HARNESS-ARCHITECTURE.md`):** reverted the thinking line to `medium`, removed the resolved OPEN-DECISION bullet, refreshed token math (descs 770→727 tok / 3083→2908 B; total 1.95K→1.9K tok).
  - **Why:** closes the OPEN DECISION from the prior audit entry; the ponytail description was the largest and most redundant with AGENTS.md (core ladder stated twice). One source of truth for the ladder (AGENTS.md); the skill points to it.
  - **Measured:** ponytail description **825 → 650 B (−175)**; 9-description total **3083 → 2908 B (≈727 tok)**; **prefix 7796 → 7621 B (≈1905 tok, −44 tok/session)**. AGENTS.md 4713 B unchanged. `settings.json` `defaultThinkingLevel: max → medium`.
  - **Risk:** low. Config reversible (one field). Description reversible; trigger words preserved so auto-routing unaffected. **Prefix changed → start a fresh session** for the new ponytail description + medium thinking to take effect.
  - **Portability:** clean (no paths/OS-only commands touched). Skill count 9 → 9 (no skills-audit revision).

---

- **2026-08-11 — HARNESS-ARCHITECTURE.md doc-sync audit (cache-safe, no prefix change)**:

  - **Changed (doc only — `HARNESS-ARCHITECTURE.md`, NOT in the prefix):** 5 factual corrections surfaced by a full re-audit (discover → mine sessions → verify config against the doc):
  1. **Thinking-level lie (highest impact):** doc claimed `defaultThinkingLevel: medium (token-efficient)`; `settings.json` is actually `max` + `hideThinkingBlock: true`. Corrected to reality + flagged as an OPEN DECISION — `max` burns the most reasoning tokens/session; if `medium` was intended, fix `settings.json` (not the doc).
  2. **Prompts tree:** listed 4, actual 5 — added `/preflight` (already in `AGENTS.md` + skills-audit Rev 7; only the tree block was stale).
  3. **`.nvmrc` (Node 22 pin):** present, in `bundle.sh` FILES, referenced by two prior changelog entries — but missing from the arch tree + bundled list. Added to both.
  4. **Token-budget numbers:** descriptions 650→770 tok (3083 B measured), total 1.8K→1.95K tok; AGENTS.md 1.2K→1.18K tok (4713 B).
  5. Added OPEN-DECISION bullet + marked the byte-math measurement done.
  - **Why:** evidence-over-opinion (harness rule 6). The arch doc is the map every harness session re-reads FIRST; a false "token-efficient medium" claim would mislead every future audit. Doc-sync only — no behavior change.
  - **Measured:** `HARNESS-ARCHITECTURE.md` **6528 → 7126 B (+598)**. **Prefix byte-stable: AGENTS.md 4713 B unchanged; 9 descriptions 3083 B unchanged** → no session restart required. Skill count 9 → 9 (no skills-audit revision). Portability quick-check: 0 hits before, 0 after.
  - **Session evidence (mined this audit):** pi `sessions/*.jsonl` skill-body loads — all 9 live skills healthy: harness-engineer 66, frontend-design 50, refactoring-ui 18, brainstorming 13, systematic-debugging 11, ponytail-review 8, ponytail 7, browser-tools 6, youtube-transcript 3. Ghost skills (adhd / shadcn / ui-ux-pro-max / vercel-react-best-practices / tailwind-design-system / web-design-guidelines) appear ONLY in pre-archive sessions → confirms the 9-skill set; no removals. Correction-word mining was CONTAMINATED (217 "don't" across 57 user turns = mostly skill-body + assistant text) → not actionable; CC `display` prompts give the reliable signal (real corrections: "you removed my previous behavior rules", "your type declaration is wrong", "you did not use react 19 pattern") → these justify AGENTS.md's existing plan-mode + ask-before-destructive guardrails. `defaultModel: glm-5.2` verified present in `models-store.json` (zai).
  - **Not changed (flagged, needs your call):** (a) `defaultThinkingLevel: max` — see OPEN DECISION; (b) `ponytail` description is the largest at 825 B and partly restates the ladder already baked into AGENTS.md — trimmable to ~620 B, but it's a PREFIX change (cache-invalidating, restart needed) and the core skill, so left untouched pending approval.
  - **Risk:** none — doc-only, reversible, cache-safe.
  - **Portability:** clean (0 hits, unchanged).

---

- **2026-08-11 — session-driven prefix retune: 4 descriptions + AGENTS.md dedup + /preflight + harness-engineer methodology upgrade**:

  - **Changed (descriptions — prefix-affecting):** `systematic-debugging` under-triggered (0 CC uses despite real bugs) → retuned to the user's actual bug language ("it doesn't work", "still not working", "why did X happen"). `brainstorming` over-triggered (5× corrected in CC for concrete tasks) → narrowed to genuinely-unclear intent, routes concrete work away. `frontend-design` + `refactoring-ui` co-fired 2–3×/session (CC plans) → each now names the other as the NOT-case. Skill COUNT unchanged (9): `ponytail-review` NOT folded — evidence correction: ponytail body has NO review format, ponytail-review is the sole carrier of the `L<line>:<tag>` format; folding would lose a distinct tool for ~30 tok.
  - **Changed (AGENTS.md — prefix):** Skills section de-duped — removed the 9 per-skill one-liners that re-stated each frontmatter description already injected into the prefix; kept the load-on-demand policy + the 2 disambiguation hints not derivable from descriptions. Corrected a FALSE claim ("ponytail = … review format") → ponytail has modes only; review format is ponytail-review.
  - **Added (prompt — 0 prefix cost):** `/preflight` (`prompts/preflight.md`) — 5-point pre-edit contract (blast radius → reuse target → scope fence → contract check → propagation). Operationalizes ponytail rung-2 + grep-every-caller, the #1 failure mined from sessions ("did you update edit-parcel too?", "restructure X same as Y", "use this case instead of raw").
  - **Changed (harness-engineer skill — on-demand, 0 prefix cost):** added mandatory **step 1a Mine session history** (CC `~/.claude/history.jsonl` `display` + `plans/`; pi `sessions/*.jsonl` skill-loads + corrections) + **Snapshot loop** (BEFORE/AFTER quantified — no win without a number) + fixed the portability quick-check to exclude `node_modules` (was crying wolf: 40 false hits from vendored READMEs citing `/Users/author`). Output format now requires cited session evidence + snapshot delta.
  - **Why:** this session was the proof — the assumption "ponytail-review is redundant" was WRONG until session + body reads corrected it. The upgrade bakes that discipline in: every future harness verdict must cite a real prompt/count and a real before→after number.
  - **Measured:** AGENTS.md **5627 → 4713 B (−914, −16% ≈ −229 tok)**; 4 descriptions grew ~+340 B with real trigger phrases → net prefix **≈ −576 B (≈ −144 tok)**. Skill count 9 → 9. Prompts 4 → 5 (+`/preflight`, 0 at rest). harness-engineer body 4792 → 6896 B (on-demand, 0 prefix). Portability: functional files CLEAN (the prior "40 hits" were `node_modules` README noise, now excluded).
  - **Risk:** low–med. Description + AGENTS.md edits change the prefix → **start a fresh session** to pick them up (this session's cache is stale for those). All reversible from `~/.pi-backups/` + this entry.
  - **Portability:** clean — no new paths/OS-only commands; the check is now MORE correct (excludes regenerable `node_modules`).

---

- **2026-08-11 — pin Node LTS (engines.node ≥ 22 + .nvmrc)**:

  - **Changed:** `skills/browser-tools/package.json` — added `"engines": { "node": ">=22" }` (was: none). True dep floor is Node 20.18.1 (cheerio); pinned to 22 to require a current LTS, not EOL Node 20.
  - **Changed:** new `~/.pi/agent/.nvmrc` = `22` — makes `nvm use` inside the harness dir reproducible (covers the per-skill `npm install` restore step that the bundle.sh fix made load-bearing).
  - **Changed:** `bundle.sh` — `.nvmrc` added to bundled FILES; `PORTABILITY.md` — documented the Node-LTS contract + `nvm alias default 22` tip for running `pi` from any dir.
  - **Why:** reliability/portability. Once `node_modules` stopped shipping (prior entry), `npm install` became the restore path on every target — so deps must install on a known Node line. Without an `engines` floor, `npm install` silently succeeds on Node 16/18 then breaks at runtime (jsdom 27 / cheerio need ≥20). Pinning makes it fail loud + tells `nvm` which Node to use.
  - **Measured:** binding Node floors of installed deps — cheerio `>=20.18.1` (strictest), jsdom `>=20`, puppeteer/puppeteer-core `>=18`, readability `>=14`, turndown/turndown-plugin-gfm (none). Floor `>=22` satisfiable by all. Runtime here: Node `v22.22.2`; nvm also has 18.x/24.x. Prefix byte-stable: AGENTS.md 5,627 B + 9 descriptions untouched.
  - **Risk:** low. `engines` is advisory (warns unless `.npmrc` sets `engine-strict`); `.nvmrc` is advisory. Both reversible. No package downgrades — current set already supports Node 20/22/24 LTS.
  - **Portability:** fixed (was: no Node version contract → silent runtime breakage on old Node). Now clean.

- **2026-08-11 — bundle.sh excludes skills/**/node_modules (−97% bundle) + `Measured:` field**:

  - **Changed:** `bundle.sh` — `tar -czf "$OUT" -C "$AGENT" $INC` → `tar -czf "$OUT" --exclude='node_modules' -C "$AGENT" $INC` (one flag; GNU tar + BSD tar/macOS both support it).
  - **Changed:** `PORTABILITY.md` + `HARNESS-ARCHITECTURE.md` — portability contract now lists `skills/**/node_modules/` as NOT bundled (regenerable via each skill's own `npm install`).
  - **Changed:** `CHANGELOG.md` format + `skills/harness-engineer/SKILL.md` output format — added a **`Measured:`** field (concrete before→after numbers) so every future entry is evidence, not opinion. Skill set unchanged → no `skills-audit.md` revision.
  - **Why:** portability + tokens. `skills/browser-tools/node_modules` was 125 MB of regenerable deps (puppeteer-core, jsdom, cheerio, `@mozilla/readability`, turndown…) silently tarred into every portable bundle. Restorable on-target via browser-tools' documented one-time `npm install`. The `Measured:` field closes the self-rewrite loop with real signal (the skill's own rule 6, applied at the meta level).
  - **Measured:** portable bundle **17,448 KB → 452 KB** (−16,996 KB, **97% smaller**); **11,647 files** removed; `skills/browser-tools/web-fetch.mjs` (the headless URL→markdown extractor) still bundled — only its deps need reinstall on target. Always-on prefix byte-stable: AGENTS.md 5,627 B unchanged; 9 skill descriptions untouched.
  - **Risk:** low. Reversible (drop `--exclude`). On a fresh target, `browser-tools`/`web-fetch.mjs` need `npm install` in the skill dir — already in the skill's Setup section.
  - **Portability:** fixed (was: ~125 MB of regenerable deps shipped per Google-Drive sync). Now clean.

---

- **2026-08-11 — rename `/ship` → `/release`; explicit package.json + lockfile version step**:

  - **Renamed** `prompts/ship.md` → `prompts/release.md` (`/ship` → `/release`). `ship` implied deploy/publish; this command only *prepares* a release (no tag/push/publish). Alternatives considered: `/cut-release`, `/prerelease`.
  - **Strengthened** step 2 of `/release`: now explicitly updates `package.json` `version` AND the lockfile version when present — `package-lock.json` (npm: root `version` + `packages[""].version`); `pnpm-lock.yaml` / `yarn.lock` noted as non-version-storing (re-sync on next install).
  - **Updated** cross-refs: `AGENTS.md`, `HARNESS-ARCHITECTURE.md`, `skills-audit.md` (Rev 6 final-state box).
  - **Why:** accuracy + discoverability; the lockfile detail removes the ambiguity the user flagged.
  - **Risk:** low — reversible; `ship.md` recoverable from `~/.pi-backups/`.
  - **Portability:** clean (no new paths / OS-only commands).

---

- **2026-08-11 — skills + slash commands + frontend-design pattern-audit fix**:

Response to: "create a harness-engineering skill, document the arch, and give the
COMPLETE slash-command solution for changelog/bump/commit (previously incomplete);
frontend-design keeps not following existing design patterns."

Grounded in evidence: session history shows commit-message asks in 117/264
sessions, design-mismatch language in 56, changelog in 45; plus user self-report.

  - **Created skill `harness-engineer`** (`skills/harness-engineer/SKILL.md`): the
  portable inspect→diagnose→propose→implement→log methodology; auto-trigger +
  `/skill:harness-engineer`; points at HARNESS-ARCHITECTURE.md for current state.
  - **Created `HARNESS-ARCHITECTURE.md`**: living map of the harness (layout, skill
  discovery incl. the `~/.agents` caveat, prefix composition, token budget,
  persistence loop, portability contract) so future sessions resume from known state.
  - **Created 4 slash commands** (`prompts/`, token-cheap — NOT in always-on prefix):
  `/commit` (one conventional commit msg from `git diff --cached`), `/changelog`
  (Keep-a-Changelog entry from commits since last tag), `/bump [patch|minor|major]`
  (semver in package.json + lockfile), `/ship` (changelog→bump→commit orchestrator).
  - **Fixed frontend-design root cause** (`skills/frontend-design/SKILL.md`): added a
  MANDATORY **Pattern Audit** first step (read siblings, extract tokens/spacing/color/
  typography/component-patterns, reproduce exactly) that OVERRIDES the skill's
  "BOLD/distinctive/unforgettable" directives whenever an existing UI exists.
  Retuned the `description` to signal pattern-first. The old novelty bias was the
  reason new UI never matched existing AntD dashboards. Qualifying note added that
  the creative/aesthetic exploration is GREENFIELD-only.
  - **Updated** `bundle.sh` (now bundles `prompts/` + `HARNESS-ARCHITECTURE.md`) and
  `AGENTS.md` (added harness-engineer, fixed frontend-design blurb, listed slash cmds).
  - **Why**: close the completeness gap; make repetitive workflows one keystroke; kill
  the recurring design-mismatch failure at its source; keep continuity portable.
  - **Risk**: low–med. Skill/prompt additions are additive. The frontend-design edit
  is a behavior change (deliberate) — old behavior recoverable from the bundle backup
  or `skills-archive.tar.gz` (pre-change snapshot also in `~/.pi-backups/`).
  - **Portability**: clean. All new files use `~`/relative paths; no OS-only commands;
  no env vars. Validated by the portability quick-check.

**Always-on cost now:** AGENTS.md ~1.05 K tok + 9 skill descriptions ~570 tok ≈ **~1.6 K tok/session**. Prompt templates add 0 (autocomplete-only).

**Next measurement:** fresh session → `/skill:harness-engineer` loads; `/commit`,
`/changelog`, `/bump`, `/release` appear in `/` autocomplete; on a real AntD task,
frontend-design reads siblings before generating.

---

- **2026-08-11 — Portable config migration (office macOS → home Linux)**:

Adopted the curated office `.pi` into the home machine and made the config
fully portable. Driven by `pi-harness-engineer.md` + the office `skills-audit.md`.

  - **Adopted** (`.pi/agent/` office copy → `~/.pi/agent/`):
  `AGENTS.md`, `skills/{ponytail,ponytail-review,frontend-design,refactoring-ui,brainstorming,systematic-debugging}/`,
  `skills-audit.md`, `skills-archive.tar.gz`, `zen-provider.template.json`.
  Kept existing `browser-tools` + `youtube-transcript` (merged, not replaced).
  - **settings.json**: `defaultThinkingLevel` max → **medium** (token efficiency; office's curated default).
  - **AGENTS.md**: dropped hardcoded `~/Barikoi/` (path-agnostic); skill list generalized
  (no hardcoded count) + added the two tool skills.
  - **Neutralized** stale `~/.agents/skills` (7 legacy skills pi auto-scans) → renamed
  `~/.agents/skills.disabled.<ts>`. Matches office audit end-state; removes always-on
  description tax from skills that were never used (per skills-audit.md §2).
  - **Created** portable infra (all inside `~/.pi/agent/`):
  `PORTABILITY.md`, `setup.sh` (idempotent per-machine), `bundle.sh` (GDrive tarball),
  this `CHANGELOG.md`.
  - **Not bundled** (machine-local/auto-regenerated): `bin/{fd,rg}`, `npm/node_modules/`,
  `sessions/`, logs. See PORTABILITY.md.
  - **Why**: one `.pi` config, identical on every Linux/macOS box, replace-only sync,
  no env vars, minimal always-on tokens, cache-stable prefix.
  - **Risk**: low. All changes reversible; full backup at `~/.pi-backups/pi-agent.pre-portable.<ts>.tar.gz`.
  - **Portability**: fixed (was: macOS-only binary in `bin/`, hardcoded `~/Barikoi/`,
  `.agents` leakage). Now clean.

**Always-on token cost (post-change):** AGENTS.md ~960 tok + 8 skill descriptions
(~430 tok) ≈ **~1.4 K tok/session**; bodies stay on-demand. `defaultThinkingLevel`
medium cuts reasoning-token burn vs `max`.

**Next measurement:** `/reload` or fresh session; confirm exactly 8 skills load
(0 from `.agents`); try `bundle.sh` → dry-run extract on a temp dir to validate.

---

### Removed

- **2026-08-28 16:30Z — removed .env / .env.example (YAGNI)**:
  - Removed: `.env`, `.env.example` deleted; `.env` entry dropped from `.gitignore`.
  - Rationale: pi never reads .env (auth.json or plain env vars only); shell-rc loading ruled out; duplicated auth.json keys with drift risk. auth.json is the single secrets file.
  - Measured: index 65 files; PORTABILITY.md/HARNESS-ARCHITECTURE.md carry 0 stale .env/setup.sh/bundle.sh references (verified via rg).
  - Risk: none — secrets flow simplified to one-time `scp auth.json` per machine.

- **2026-08-28 16:05Z — removed setup.sh / bundle.sh; git-only sync finalized**:
  - Removed: setup.sh, bundle.sh deleted from disk and absent from index. Deprecated entries dropped from .gitignore comment context (paths still listed for safety).
  - Measured: index 66 files — all portable source-of-truth (AGENTS, settings/models.json, skills/ 14, prompts/, HARNESS docs, PORTABILITY, skills-audit, .nvmrc, .gitignore, .env.example). Ignored as intended: .env, auth.json, bin/, npm/, sessions/, models-store.json, logs, archives. 0 untracked non-ignored files.
  - Docs: PORTABILITY.md fully rewritten git-side (portable/not-portable tables, key rotation via .env, manual per-machine one-time setup incl. ~/.agents/skills neutralization one-liner); HARNESS-ARCHITECTURE.md tree + portability summary updated (no script refs).
  - Risk: low — per-machine setup is now 2 documented manual steps (secrets + legacy skills dir).

- **2026-08-12 — slash-command token fix: `/release` `/bump` `/changelog` (8k→~0 lockfile read)**:

**Prompt:** `/release` cost ~8k tokens and produced a CHANGELOG the user deleted.
Root-cause the prompts.

**Root cause (evidence):** the prompt *bodies* are tiny (~1 KB each) — not the
cost. The cost was **runtime reads**: `/release` + `/bump` instructed the model
to **hand-edit `package-lock.json`**, forcing a 50–100 KB lockfile into context
(~8–12 K tok) just to change two version strings. Secondary: unbounded `git log`
and loose changelog rules (verbose/noisy entries → deletable output).

**Changed (native tool over hand-editing — ponytail rule 4):**
  - `release.md` + `bump.md`: lockfile step now runs `npm install --package-lock-only`
  (the tool syncs root + `packages."".version`); **explicit "never read the lockfile
  into context — 8k-token trap"**. `pnpm-lock.yaml`/`yarn.lock` store no root
  version → skipped (was: "hand-edit / run update command for approval").
  - `release.md` + `changelog.md`: `git log --no-merges … | head -60` (was unbounded).
  - `release.md` + `changelog.md`: changelog entries now ≤10 words, user-facing,
  omit chores/CI/docs; **insert-only** (never rewrite existing entries) — the
  quality rules the deleted output lacked.

**Not changed:** `/commit` (963 B, already lean) and `/preflight` (1647 B,
purpose-built) — no token issue.

  - **Measured:** body sizes barely moved (release 1834→1943, bump 1000→1021,
  changelog 1055→1059 B). The win is **runtime**: ~8 K tok lockfile read → ~0
  (one `npm install --package-lock-only`); git log now capped at 60 subjects.
  **Prefix byte-stable** (prompts are NOT always-on — 0 prefix tokens at rest) →
  no session restart needed.
  - **Risk:** low. `npm install --package-lock-only` is the canonical lockfile-sync
  (no `node_modules` touched); reversible by re-running. Worst case the command
  needs network for a dep change — but a version bump changes no deps.
  - **Portability:** clean — `npm`/`pnpm`/`yarn` branches, no paths, no OS commands.

- **2026-08-11 — bundle.sh auto-include rewrite (explicit FILES list → exclude-only)**:

Closes the "pending the portability-safe rewrite decision" thread from the prior
entry. The explicit `FILES` list duplicated PORTABILITY.md's *"What is NOT
portable"* table and had already drifted — `.nvmrc` + `HARNESS-ARCHITECTURE.md`
both had to be added retroactively (2 silent-omission bugs).

  - **Changed:** `bundle.sh` — deleted the 16-line `FILES` block + the `INC`-building
  loop; now ships **everything under `~/.pi/agent`** minus a top-level-anchored
  exclude set: `--exclude='node_modules' ./bin ./npm ./sessions *.log`. Header
  comment rewritten to state the auto-include contract + why each exclude exists.
  Excludes anchored to top-level (`./bin`, not bare `bin`) so a future skill
  `bin/` subdir is never clobbered.
  - **Why:** one source of truth for "machine-local" (the exclude set) instead of
  two (exclude set + hand-maintained include list). New portable files now ship
  with **zero script edits**; the whole silent-omission drift class is gone. The
  win is maintenance surface + a removed bug-class, not bytes.
  - **Measured:** `bundle.sh` **1276 → 1468 B** (+192 — longer comments explain the
  contract; the `FILES`/`INC` logic shrank). Produced tarball **76 members,
  identical to the explicit-list set** (`diff` empty, re-verified against the
  CURRENT tree, not last session's); bytes **471,609 → 470,852** (−757,
  mtime/ordering only). Leak check `bin/npm/sessions/node_modules/*.log` = **0**
  each. **Prefix byte-stable** (AGENTS.md 4713 B + 9 descriptions 2908 B
  untouched) → no session restart required. Skill count 9 → 9 (no skills-audit
  revision).
  - **Risk:** low. Reversible: `~/.pi-backups/bundle.sh.pre-auto-include.20260811-221738`
  (sha256 `ab01d6e2…`). Residual: a future machine-local *top-level* dir would
  ship until one `--exclude` line is added — but that set (`bin/npm/sessions`)
  is tiny/stable and `tar -tzf | head` catches any leak.
  - **Portability:** clean — no new paths, no OS-only commands, same POSIX `sh`;
  `--exclude` mechanism unchanged (GNU tar + BSD tar both supported).
