# Backlog — next development pass

Open work, captured at the end of the native-tool round (compaction, daemon
isolation, refcount fixes, README perf refresh). Ordered by what I would take
first, with the reason it is first.

## 1. `pibash` `seq 50000` regression — the one measured performance loss

> **Fixed.** Profiled by phase (`PIBASH_PHASES` instrumentation, since removed):
> of the ~16 ms output-size cost, the compression pre-pass was ~9.6 ms — three
> full `split_lines` passes over the stream plus a per-line `String` malloc in
> `dedup_repeats` — and the envelope path materialized the stream twice
> (`full_text` clone + `read_full_output` re-read). Changes, all byte-shape
> preserving (128 unit tests + four parity suites green):
> (1) `compress.rs`: `strip_ansi`/`dedup` are copy-on-write (borrow when
> ANSI-free / fold-free), the line vector is split once and shared by
> `error_priority_lines` / `head_tail_lines`, `fits` counts lines without
> materializing them, and the fold path emits through one buffer instead of
> one allocation per line. compress phase 9.6 → 2.5 ms.
> (2) `accumulator.rs`: `into_full_text` (single materialization, moves the
> raw buffer zero-copy) + string-side `cap_full_output` replace the second
> spill read; spill-compaction windows are maintained incrementally
> (byte + line ring), so repeated `snapshot()`s never re-split the whole tail.
> (3) `main.rs`: `structuredContent` derives from the already-materialized
> text (backlog option (b) as recommended) instead of re-reading the stream.
> One-shot `seq 50000`: p50 19.7 → 13.4 ms (−32%). Repo harness re-run
> (2026-10-19, `benchmark/runs/pibash-microbench-2026-10-18.md`): daemon p50
> 15.78 → 13.46 ms; oracle gap +3.57 → **+2.82 ms** — the residual is exactly
> the Tier-1 compression pre-pass, work the built-in never does (pibash's
> additive error-rescue feature). Every other arm now leads the oracle by
> 1.4–2.7 ms. Removing the residual entirely means dropping the pre-pass or
> making it stream from the spill file — a deliberate follow-up, not part of
> this fix. Model-visible tokens unchanged: display text is the same
> compressed ≤40-line/2 KB body, parity-pinned.

**Symptom.** `pibash` is the only arm slower than the built-in oracle on a
representative case: **+3.57 ms at p50** (`12.216` → `15.783` ms), and the gap
grows with output size. Small-command classes sit within ±0.3 ms, so this is
purely an output-size effect.

**Cause (known).** The envelope ships the payload twice —
`content[0].text` *and* `structuredContent.output` — and it is
parity-pinned, so it cannot be dropped unilaterally.

**Why not fixed already.** `structuredContent` is documented in
`pi-agent-core/dist/types.d.ts:376` as *"Not sent to the model"*, so the
duplication costs **zero model tokens** — only serialization and host memory.
Removing it is a perf change, not a token change, and it would break the parity
contract that `permission-gate` H1 and the bash parity suite depend on.

**Options.**
- (a) Drop the duplicate field and update `tests/pibash-parity.test.mjs` to
  assert on `text` only. Fast, but changes the wire contract.
- (b) Keep both but stop *serializing* twice: build `structuredContent` from the
  already-serialized text rather than re-encoding. Preserves the contract.
- (c) Accept it; document as a known trade-off (current state).

**Recommendation:** (b) — the contract survives and the redundant encode goes
away. Needs a micro-bench before/after to prove the win.

**Decision (2026-10-19, goal: low latency).** Architecture stays on the
accumulator + spill envelope (state at `f51cfc2`); the bounded streaming
rebuild (research/pibash-implementation-plan.md) is closed — measured ~18%
slower at 1M/2M lines with no envelope gain (`073ac87`). Reopen only if
subagents routinely push ≥10 MB outputs or daemon RSS pressure is observed;
the reopen path is a hybrid (accumulator below a threshold, bounded capture
above), gated by the measurement harness. Retired with this decision: the
single-line-overflow pending-cap and the accumulator-constant re-derivation —
both are streaming-design-only concerns.

Next perf item under this goal: eliminate the `seq50000` residual (+2.82 ms).
Correction after reading the code: error-priority already runs only for
Test/Build commands (`compress_output`), so a Generic stream like `seq` never
enters it — the residual is the Tier-1 pre-pass itself (`split_lines`
materializes a Vec<&str> with one entry per line, plus a full-corpus dedup
scan). Approach: a fused single-scan Generic fast path — count lines, capture
head/tail window slices, and detect ESC bytes, adjacent duplicates, and the
omission tag in one pass; on any anomaly fall back to the exact existing
path, so output stays byte-identical by construction. Acceptance: corpus
equivalence test (windowed == materialized on all clean fixtures), unit +
parity suites green, `seq50000` p50 reduced (target: at or below the oracle,
~10.6 ms).

**Done (2026-10-22).** `head_tail_windowed` in compress.rs: one fused scan
counts lines and captures only the head/tail budget windows, bailing to the
exact materialized path on ESC bytes, `[`, adjacent duplicates, or small
corpora — byte-identical by construction, and `trim_overlap`/kept-everything
are provably unreachable on the fast path. `compress_output`'s entry check
now uses `line_count` (no materialized split). Verification: 142 unit tests +
parity suite green, clippy clean; interleaved one-shot A/B `seq50000` p50
~15.0 → ~13.7–13.9 ms (−1.1 to −1.3 ms); harness re-run (2026-10-22) gap
+2.37 ms — the oracle arm itself ran ~4 ms slower that day, so the A/B is
the clean signal. Residual is no longer compression: it is daemon
protocol/IPC cost (288 KB child pipe → 2 KB envelope). "At or below oracle"
was not reached; further reduction is protocol-level work, not compression. Step 8 landed 2026-10-22
(`3391c41`): `custom-tools/pibash/bench-large-output.mjs` (12 fixtures,
1/10/100 MB × uniform/giant-line/stderr-mix, plus `yes | head -c`, non-zero
exit, SIGTERM death) and the 1 MB regression class in
`tests/pibash-large-output.test.mjs`. Assertions pin current behavior:
byte-exact `child_bytes`, `spill_bytes == child_bytes`, envelope ≤ 8192 B
flat across 1→100 MB (unclassified streams render the parity-locked
2000-line tail window — 4111 B measured — hence 8 KB, not 2 KB), and
per-class RSS caps recording the by-design scaling (100 MB peak 1003 MB on
`yes | head -c`). Wall time is recorded, never asserted (noise). Report:
`benchmark/runs/pibash-large-output-2026-10-22.md`. Still owed: one macOS
run of the same harness (parsing and unit normalization are in place).

## 2. `doc:check` is non-deterministic — FIXED

> **Fixed.** All four planned changes are in `scripts/doc-check.mjs`:
> (1) `helpFlags` returns `null` on a probe that produced no output and never
> caches it, so a timeout/ENOENT is reported as `HELP PROBE UNRESOLVED`, never
> as `FLAG NOT IN HELP`; it also retries once at 45 s.
> (2) A failed probe stays uncached — `helpCache.set` only runs on success.
> (3) `bash -c command -v` per token is replaced by an in-process `$PATH` walk
> (`hasBin`, `statSync` + `accessSync(X_OK)`, using `delimiter` so macOS and
> Linux both work). Runtime went 45 s → 7.9 s.
> (4) Tests added for a never-resolving probe and for a resolvable binary that
> must still catch a real missing flag.
> A second, unrelated parser bug surfaced once the flakiness was gone:
> `cmd || { …; }` splits on `||` into a segment `}`, which `headTok` did not
> reject, so it reported `BINARY NOT FOUND: }`. `}` is now in the shell-syntax
> class. `npm run doc:check` passes all 4 families.

`npm run doc:check` intermittently reports false failures — observed 3-4 at a
time, varying run to run:

```
FLAG NOT IN HELP: pidx --out
FLAG NOT IN HELP: pi --extension
FLAG NOT IN HELP: pi --session
FLAG NOT IN HELP: docker run --rm
FLAG NOT IN HELP: tvly search --json
FLAG NOT IN HELP: tvly search --depth
FLAG NOT IN HELP: tvly search --max-results
FLAG NOT IN HELP: tvly search --time-range
FLAG NOT IN HELP: tvly search --topic
FLAG NOT IN HELP: tvly search --include-domains
FLAG NOT IN HELP: tvly search --include-raw-content
```

All of these flags ARE in the respective `--help` output. Same command, same
binary, same PATH — a rerun passes.

**Investigated 2026-10-17 (unresolved, parked).** Findings so far:

- Every flag is genuinely present: `pi --help` lists `--extension`/`--session`,
  `pidx --help` lists `--out`, `docker run --help` lists `--rm`, and
  `tvly search --help` lists all seven. Verified by direct probe.
- The probe is correct in isolation: replicating `helpFlags()` exactly (same
  `execFileSync`, same argv, same regex, same 15 s timeout) returns every flag.
  Sizes: pidx 5 flags/81 B, pi 76/10705 B, docker run 127/11752 B,
  tvly search 23/1662 B — all far inside the timeout.
- **It correlates with the `npm run` path, not with the script.**
  `node scripts/doc-check.mjs` passed 6/6 consecutive runs;
  `npm run doc:check` failed 3/3. `npm run env` adds only `node_modules/.bin`
  prefixes to PATH, and resolving pi/pidx/docker/tvly under that PATH gives the
  same binaries.
- Re-invoking `checkMdCommands()`/`runDocCheck()` twice in one process passes
  both times, and an instrumented `execFileSync` wrapper shows the probes
  succeeding (pidx 113 ms, pi 517 ms) — instrumentation perturbs it away, i.e. a
  timing/race signature rather than a logic bug.
- Wall time: `node scripts/doc-check.mjs` 33.8 s real (2.7 s user), so ~31 s is
  subprocess wait across ~500 markdown files. That is also why iterating on this
  is expensive: each hypothesis costs 34-50 s per run.

Most likely causes, in order: (a) the 15 s timeout firing because the scan
serializes hundreds of subprocesses and a busy machine pushes one probe past it —
the `catch` treats a timeout exactly like a missing flag; (b) ambient state under
`npm run` (`npm_lifecycle_*`, `NODE_OPTIONS`, stdio) making pi/pidx emit empty
stdout.

**Fix (not yet applied):**
1. Distinguish "probe failed" from "flag absent": inspect the caught error, and
   on timeout/ENOENT/empty stdout retry once with a larger timeout before
   reporting. A probe that never succeeded is its own finding class, never
   `FLAG NOT IN HELP`.
2. Do not cache an empty flag set as a resolved result — a failed probe must stay
   unresolved so a later lookup retries (this is the trap `helpCache.set` sets).
3. Cut the 34 s runtime: `bash -c command -v` per command token (lines ~215,
   ~264) dominates; replace it with an in-process PATH lookup plus `existsSync`.
4. Add a test with a deliberately failing probe (a binary that exits 1 with empty
   stdout) asserting it reports "unresolved", not "flag missing".

**Impact:** a red CI gate that goes green on retry trains people to ignore it —
worse than no gate. **Effort:** small for (1)+(2), medium for (3).


## 3. `permission-gate` S4/S5 failures (pre-existing, unrelated) — RESOLVED

> **Resolved on Linux (2026-10-22).** Both cases pass standalone and in the
> full suite on this host. The symlink-confirm fix `a71d167` (2026-10-16,
> "confirm write/edit into symlink-resolved protected paths") predates this
> note's last edit (`d8598ed`, 2026-10-17), so the recorded failure state was
> stale. Only open branch: a macOS re-run — unverified here.

```
FAIL  S4 protected path: write via symlink into HOME/.ssh confirms  (expected blocked, got pass)
FAIL  S5 policy: protected-path edit confirms through H2 before binding blocks  (expected blocked, got pass)
```

2 of 285. Both are `HOME/.ssh` symlink cases: the target resolves *through* the
link into `<fake-home>/.ssh`, and the ladder returns pass where a block is
expected.

**Why it matters:** these are protected-path guards. A real bypass would look
exactly like this. Tests failing may mean the guard has a hole, or that the
fixture drifted — both need to be told apart before anything ships.

**Not investigated yet.** Should be the first security-shaped thing looked at,
not the first thing overall only because it is not coupled to current changes.

## 4. Rust daemons are typecheck-verified on Linux, not run

`cargo check --target x86_64-unknown-linux-gnu` passes for all four crates, but
a real Linux *link* needs a cross-linker that is not installed here. So:

- `setpgid(0, 0)` in `procgroup.rs` is verified on macOS and by POSIX guarantee
  (glibc, musl, and Apple libSystem all export it) — **not by execution on
  Ubuntu**.
- Daemon RSS probes read `/proc`, so they are skipped off-Linux.

**Action:** add a Linux CI job that runs `cargo test --release` and
`node tests/daemon-process-group.test.mjs`. Until then the Linux story rests on
the typecheck plus one test file, which is thinner than the macOS evidence.

## 5. `piread` compaction: revisit the tail source

Compaction currently tails the *already-truncated* body, so on a 6001-line file
the tail is around line 1000, not line 6001. The continuation notice
(`[Showing lines 1-2000 of 6001. …]`) is kept last so the reader still learns
the file continues, which contains the damage — but a tail from the real end of
the file would be more useful.

**Trade-off:** tailing the real EOF means the head and tail describe different
byte ranges, and it changes the parity story further. Worth a design note before
code.

## 6. `tests/` scratch files

`tests/.child.tmp.mjs`, `.childwd`, `.crossrung`, `.iso2`, `.mkchild`, `.mkwd`,
`.probe`, `.rc` — eight throwaway repro harnesses kept deliberately (user
asked to retain them in case they help future work). They are dot-prefixed and
excluded by the `tests/**/*.test.mjs` glob, so they never run in CI. Their
durable equivalents are `daemon-exit.test.mjs`,
`piread-daemon-settle.test.mjs`, `daemon-process-group.test.mjs`, and
`pidoc-portability.test.mjs`. Delete once the related bugs stop being live.

## 7. Gate blocks: surgical fix vs. effect-based approval

Triggered by a real session incident: the gate blocked a `cd <dir> && seq …`
command, the user approved a different command (`cargo build -p piread`), and
the next step then wrote outside that scope (`cp` + `codesign` into `bin/`)
because the *goal* matched. The approval was for a build; the effect was a
mutating install. That is the failure mode to close.

**Policy the evidence supports (proposed, not yet in AGENTS.md):**

1. Blocks split into two classes and must be handled differently:
   - **Mechanical** (wrong tool for the job, missing path/glob scope, BSD vs GNU
     flag, shell-syntax error): apply the *narrowest* fix and name the fact that
     was wrong. This is not evasion; re-sending the same text is the defect.
   - **Approval-gated** (destructive/mutating, elevated privilege, secret
     access, irreversible): stop, state the *effect*, ask once, wait. Never
     rephrase to route around a decision already made.
2. **Approval attaches to an effect and a scope, not to command wording.** A
   build approval does not authorise an install, a re-sign, or a probe. If the
   next step changes the blast radius, re-ask even when the goal is identical;
   if it does not, proceed without re-asking (re-asking identical things trains
   the user to click yes).
3. **Decision rule:** not "does this look like the blocked command?" but "does
   this change the set of things that can go wrong?" Same blast radius →
   proceed. Different → ask.
4. **Self-check:** if the justification is "this is technically a different
   command," that technicality is the tell to stop and ask.

**Open question A — are all rules actually needed?** The store gives evidence
for pruning: families with 1-2 distinct events in 6 days (Codemode 2, Re-run 1,
Toolchain pnpm 4) never reach any threshold, while `Anchor Guard` (103) and
`Search (node_modules)` (59) dominate — and both were *tooling* friction the
model hit while following the rules, not violations of intent. Audit each rule
for: (a) does it prevent a real, observed harm? (b) is the harm cheaper than its
friction? (c) is the rule mechanically checkable, or is it prose the model must
remember? Rules that fail all three should go.

**Why prose rules in AGENTS.md / SYSTEM.md do not stick (observed this round).**
The question "the rule is written down, why does the model break it again
anyway" has five concrete answers, all visible in the data above:

1. **A prose rule is broader than the check it triggers.** `Search
   (node_modules)` fired on commands whose *text* contained `node_modules`,
   including `--glob '!node_modules'` where the exclusion is the correct
   behavior. The rule "do not crawl node_modules" cannot distinguish crawling
   from excluding, so it fires on the pattern. A rule is only as good as the
   narrowest checkable predicate behind it.
2. **Rules compete, and ties are resolved by whatever is most immediate.**
   `Anchor Guard` (103 hits) is "oldText is exact bytes from a read this
   session"; the competing pressure is "answer now". Skipping the read is not
   defiance of the rule, it is the rule losing a tie-break nobody specified.
   Rules without stated precedence lose to urgency.
3. **Nothing removes rules, so salience decays.** Four families never passed
   any threshold in six days. Every dead rule costs prompt budget on every call
   and dilutes the live ones; 20 rules is not 20x safer than 5, it is 5% as
   salient each.
4. **A derived justification defeats an unwritten rule.** The build-approved /
   install-performed incident had no rule saying "re-ask when the effect
   differs". A general Safety section was *reasoned from* into a permission it
   did not grant. Missing structure, not missing text.
5. **Two instruction files with no precedence rule.** `SYSTEM.md` appeared
   (commit 84657fe) after AGENTS.md was established. If both carry
   instructions, contradictions have no defined resolution.

**What works better, in priority order:** (a) mechanical guards over prose —
the gate blocking a real command beats any sentence asking not to run it;
(b) fewer, higher-salience rules, pruned with the (a)/(b)/(c) audit above;
(c) explicit precedence for when rules conflict; (d) a single instructions
file, or an explicit SYSTEM.md-overrides-AGENTS.md statement; (e) structural
reminders ("read before edit" as a gate) rather than repeated admonition.

**The structural limit:** nothing durable carries a lesson forward except the
prompt. Chat corrections are compacted away, so a rule absent from the prompt
at the moment of action will be broken again — precisely what the (since
removed, `177f3d4`) violation-memory store existed to mitigate.

**Open question B — time-based relaxation.** Proposal to review: allow
re-writing a file that was already written if ≥60 s have passed, on the
grounds that a re-write after a real interval is normally evidence-driven (new
information arrived) rather than churn. Plausible, but it needs the gate to
distinguish "same content" from "revised content", and it must not become a way
to launder a destructive rewrite past H4/H5. Needs a concrete rule plus a test
before adoption.

**Next step:** decide A and B, then encode the accepted parts in AGENTS.md
Safety and add gate tests for the mechanical-vs-approval split.

## 8. Anchor Guard: certify own-inserted spans, not just matched spans

2026-10-18 session (dropx-admin user forms): three consecutive blocks fired on
lines the same session had *authored* one edit earlier. Certification is
line-span based; each edit that inserts or removes lines shifts every later
span, so the stored span no longer names the bytes it certified. The guard is
right to distrust stale spans — but the remedy it forces (re-read one line the
session itself wrote) is pure friction with no corruption risk removed.

**Fix shape:** when an edit applies, certify the inserted `newText` spans in
addition to the matched `oldText` span, and rebase stored spans by the delta of
every later edit (or switch to content-hash anchors so line shifts are
irrelevant). Keep the disk-change (mtime/size/hash) invalidation as is.

**Test:** apply edit → line-shifting second edit elsewhere → third edit whose
oldText is the first edit's inserted text → must pass without a fresh read.

**Resolved 2026-10-25** (`shiftSpansForEdit` per-edit regions, permission-gate):
the post-edit result now rebases prior certified spans by the cumulative
delta of the regions ABOVE each span (not one call-total delta) and SPLITS
straddling spans into unchanged head + shifted tail instead of dropping them
— the drop had wiped a write's `[1,∞]` on the first edit and false-blocked
the next edits on lines already in context. newText spans were already
certified via the post-application `edited` spans; the gap was the rebasing
math. Two legacy R1 cases flipped expectation (their "allowed" verdicts were
the collateral of the drop): redundant re-reads of still-certified content
now correctly block. `permission-gate` 276/277 (PB1 pre-existing, fails on
HEAD), `read-coverage` 6/6, `piedit-parity` 58/58, microbench unchanged.

## Closed this round (for context)

- `piread`/`piedit` event-loop drain: they ref'd `stdin`/`stdout` but not
  `proc`, so the loop drained mid-await → unsettled top-level await (exit 13).
- `piread`/`piedit` exit-path leak: `maybeUnrefStreams` unref'd the pipes but
  never the `proc` that `refWhilePending` ref'd, pinning the host forever
  (`model-visible-baseline.mjs` hung after printing its report).
- Daemons inherited the client's process group, so any group-wide signal
  (`pibash`'s own `kill_tree`, job control, CI timeout) killed them.
- `piread` shipped ~9 KB per oversized read with no shaping at all.
- `piedit` had the `proc`-not-ref'd variant of the same bug; `pibash` was
  already correct.
