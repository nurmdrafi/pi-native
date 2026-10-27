# pibash large-output — implementation plan

> **Historical record.** Paths below are the ones the plan proposed at the time; several
> module splits never happened (`bounded.rs`, `capture.rs`, `linesplit.rs`, `spill.rs`) and
> the tests now live under `tests/parity/` and `tests/integration/`. Read it as the decision
> trail, not as a map of current files.

Converts the approved 8-step checklist (`research/pibash-large-output.md` §6) into a file-by-file plan: target files, function-level targets with signatures, test names, ship criteria, and revert mechanisms. Every step lands as one independently shippable, independently revertible commit.

## Source material and conventions

Verified repo facts (from the task brief; this plan did not read the repo):

- pibash source: `rust-tools/pibash/src/main.rs` — Rust, std-only. No Tokio, Clap, regex, or libc; a raw `extern "C"` for `setpgid` is accepted precedent.
- Dispatch ladder: `--serve` NDJSON daemon → one-shot CLI → built-in TS oracle.
- Byte-exact behavior is pinned by `tests/pibash-parity.test.mjs`.
- Perf reference: `rust-tools/pibash/bench-seq50000.mjs` (the `seq 50000` case).
- Architecture doc: `docs/rust-tools-architecture.md` § pibash.
- Envelope regression history: 2026-10-17 payload shipped twice (`content[0].text` + `structuredContent.output`); fixed 2026-10-19 via single-materialization + copy-on-write compression stages + one shared line split.

`[uncited]` marks anything beyond that material: proposed identifiers, thresholds, fixture paths, and existing function names inside `main.rs` (unknown to this plan — verify with `rg -n` before editing and substitute real names). All signatures below are proposals; the checklist mandates only `bounded::Ring` with `capacity` + `push_bounded`.

Scoped verification per step: `cargo test` for the pibash crate [uncited invocation, e.g. `cargo test --manifest-path rust-tools/pibash/Cargo.toml`], plus `node --test tests/pibash-parity.test.mjs` [uncited runner]. `npm run check` (includes doc check) once before tagging any step done. Doc updates to `docs/rust-tools-architecture.md` § pibash land in the same commit as any behavior change.

## Design target (§1 recap — drives every step)

- Spill file becomes the ONLY full-stream copy of child output.
- Envelope carries `{spill: {path, bytes, lines, truncated} | null, …}` — string + counters, never spilled text.
- Steady-state RSS bounded by candidate budgets + one read chunk + BufWriter capacity.
- Wall time bounded by pipe read rate + spill throughput.
- Serialization cost O(envelope), not O(output).
- Every failure degrades to capture-without-spill (envelope reports `spill: null, truncated: true`); the command itself never fails because of spill/capture machinery.
- `panic=abort`: all counter/length math is checked `Result` math in production paths; no `assert!`/`unwrap()` that can panic — a panic kills the daemon mid-session.
- EINTR (`ErrorKind::Interrupted`) retried in a loop at every raw read/write site.
- Budgets satisfy `head_bytes + tail_bytes + error_bytes <= model-visible budget`, enforced at construction as a returned error, not a panic.
- Spill files: per-request deterministic names in a session-scoped dir; TTL + total size-cap + oldest-first eviction.

---

## Step 1 — `bounded::Ring`

**Target files**
- `rust-tools/pibash/src/bounded.rs` — new module `[uncited]`.
- `rust-tools/pibash/src/main.rs` — add `mod bounded;` only. No behavior change.

**New code**
```rust
pub struct Ring<T> { /* VecDeque<T> + counters, [uncited] */ }
impl<T> Ring<T> {
    pub fn with_capacity(cap: usize) -> Self;          // cap == 0 legal: stores nothing
    pub fn push_bounded(&mut self, item: T) -> Option<T>; // evicts oldest when full, returns it
    pub fn len(&self) -> usize;                        // live items, always <= capacity
    pub fn capacity(&self) -> usize;
    pub fn total_pushed(&self) -> u64;                 // checked_add; overflow -> saturate + flag [uncited]
    pub fn into_iter(self) -> impl Iterator<Item = T>; // oldest → newest
}
```
Invariant enforced by construction: `len() <= capacity()` after every `push_bounded`.

**Tests** (`#[cfg(test)]` in `bounded.rs`)
- `ring_len_never_exceeds_capacity_across_10m_pushes` — 10^7 pushes into cap = 1024; assert `len() <= capacity()` on every push (or sampled); proves O(capacity) memory regardless of stream length.
- `ring_evicts_oldest_first` — push `1..=cap+3`, drained contents equal the last `cap` items in order.
- `ring_zero_capacity_is_noop` — every push returns the item, nothing stored.
- `ring_total_pushed_counts_evictions` — `total_pushed()` distinguishes live vs dropped; feeds later `truncated` detection.

**Ship criteria** — all four unit tests green; parity test untouched and green; `npm run check` green; no daemon behavior change (module unwired).

**Revert** — single commit deleting `bounded.rs` and the `mod` line; nothing depends on it yet.

---

## Step 2 — byte-level line splitter with capped pending buffer

**Target files**
- `rust-tools/pibash/src/linesplit.rs` — new module `[uncited]`.
- `rust-tools/pibash/src/main.rs` — add `mod linesplit;` only.

**New code**
```rust
pub enum SplitEvent<'a> {
    Line(&'a [u8]),          // newline-terminated, or the final unterminated line on finish()
    OverflowChunk(u64),      // bytes of an overlong line dropped from pending [uncited shape]
}
pub struct LineSplitter { pending: Vec<u8>, pending_cap: usize, /* counters */ }
impl LineSplitter {
    pub fn new(pending_cap: usize) -> Self;            // default cap 64 KiB [uncited]
    pub fn feed<'a, F: FnMut(SplitEvent<'a>)>(&mut self, chunk: &'a [u8], sink: F);
    pub fn finish<F: FnMut(&[u8])>(&mut self, sink: F); // flush unterminated tail line
    pub fn line_count(&self) -> u64;                   // checked math [uncited]
}
```
Rules: split on LF (0x0A) only, byte-exact, no UTF-8 validation, no CRLF normalization — semantics must match the current shared line split [uncited: confirm against the 2026-10-19 single-split code before landing]. A line longer than `pending_cap` is never fully buffered: pending is capped, overflow bytes are counted and reported, and the line is delivered in pieces so candidate capture marks it truncated. Byte counters are `u64` checked math.

**Tests** (`#[cfg(test)]` in `linesplit.rs`)
- `splits_on_lf_only_keeps_cr` — `"a\r\nb\n"` → lines `"a\r"`, `"b"`; proves no normalization.
- `non_utf8_bytes_survive_split` — chunk `[0xFF, 0x0A, 0xFE]` → lines `[0xFF]`, `[0xFE]`; counters exact.
- `chunk_boundary_splits_correctly` — feed `"ab"` then `"c\n"` → one line `"abc"`.
- `ten_mb_single_line_never_buffers_over_cap` — feed 10 MB with no newline in 64 KiB chunks; assert `pending.len() <= pending_cap` throughout and total reported bytes == 10 MB + 1 after `finish`.
- `consecutive_newlines_emit_empty_lines` and `no_trailing_newline_emits_final_line`.

**Ship criteria** — all unit tests green; parity green; splitter unwired (wiring happens in steps 3–4).

**Revert** — single commit; module has no callers yet.

---

## Step 3 — candidate capture alongside the accumulator, behind a flag (equivalence gate)

**Target files**
- `rust-tools/pibash/src/capture.rs` — new module `[uncited]` holding candidate capture.
- `rust-tools/pibash/src/main.rs` — wire a shadow path into the existing read loop [uncited: locate the post-2026-10-19 single-materialization read loop and compression stages with `rg -n` first]. Gate: env/CLI flag `PIBASH_CAPTURE_V2` `[uncited name]`, default off. Sub-modes: `shadow` (compute both old and candidate compaction, compare, report mismatch without changing output) then `exclusive` (candidate only).
- `rust-tools/pibash/tests/capture_equivalence.rs` or `tests/pibash-capture-equivalence.test.mjs` — new `[uncited: pick the form that can drive the daemon end-to-end]`.
- Corpus: the fixtures already exercised by `tests/pibash-parity.test.mjs` `[uncited location]`.

**New code**
```rust
pub struct CandidateCapture {
    head: ByteRing, tail: ByteRing,     // thin byte-budget wrappers over bounded::Ring [uncited]
    lines: u64, bytes: u64, truncated: bool,
}
impl CandidateCapture {
    pub fn new(head_bytes: u64, tail_bytes: u64, error_bytes: u64, model_budget: u64)
        -> Result<Self, BudgetError>;   // asserts head+tail+error <= model_budget HERE, as an error
    pub fn on_line(&mut self, line: &[u8]);       // head until full, then tail ring; truncated=true on drop
    pub fn on_bytes(&mut self, n: u64);           // checked_add
    pub fn finalize(&self) -> CaptureSummary;     // head/tail bytes, lines, bytes, truncated
}
```
Byte-budget ring: evicts oldest lines until under budget; all arithmetic checked (panic=abort).

**Tests**
- `candidate_output_equals_compaction_output_on_corpus` — THE equivalence gate: for every corpus fixture (all three output shapes), candidate compaction bytes == current compaction bytes, asserted in shadow mode; proves the flag-on path is a drop-in.
- `capture_construction_rejects_over_budget` — head+tail+error > model budget returns `BudgetError`, does not panic.
- `capture_truncated_flag_set_when_lines_dropped` — long stream exceeds budgets; `truncated == true`, counters still exact.
- Node side: `tests/pibash-capture-equivalence.test.mjs` runs the daemon in shadow mode over the corpus and fails on any reported mismatch `[uncited]`.

**Ship criteria** — equivalence gate green over the full corpus on Linux AND macOS, repeatedly (CI), with the flag still default-off; parity green (flag off must be a no-op); old path untouched. Do NOT delete the old path here or until this gate passes.

**Revert** — flag default stays off; revert = flip default back, or `git revert` the wiring commit. Shadow computation adds cost only when explicitly enabled.

---

## Step 4 — lazy spill writer

**Target files**
- `rust-tools/pibash/src/spill.rs` — new module `[uncited]`.
- `rust-tools/pibash/src/main.rs` — wire into the read loop: every chunk read from the child pipes goes to (a) splitter/candidate capture and (b) spill writer. Read-loop order preserves the invariant that spill (post-step-7) is the only full-stream copy.

**New code**
```rust
pub struct SpillMeta { pub path: PathBuf, pub bytes: u64, pub lines: u64, pub truncated: bool }
enum SpillState { InMemory(Vec<u8>), OnDisk { writer: BufWriter<File>, path: PathBuf, bytes: u64 } }
pub struct SpillWriter { state: SpillState, in_memory_cap: usize /* [uncited] */ }
impl SpillWriter {
    pub fn new(session_dir: &Path, request_id: &str, in_memory_cap: usize) -> Self;
        // deterministic per-request name, e.g. "{request_id}.spill" [uncited scheme];
        // session dir provided by the harness [uncited mechanism — env var/arg]
    pub fn write_chunk(&mut self, chunk: &[u8]) -> Result<(), SpillError>;
        // promotes InMemory -> OnDisk lazily once cap exceeded (BufWriter::with_capacity);
        // EINTR: loop on ErrorKind::Interrupted at every raw write
    pub fn finish(self) -> Result<SpillMeta, SpillError>;
    pub fn abandon(&mut self);   // best-effort remove; used by degradation path
}
pub fn sweep_spill_dir(dir: &Path, ttl: Duration, total_cap: u64) -> io::Result<()>;
    // oldest-first eviction (mtime), TTL expiry, size cap; runs at request start [uncited cadence]
```
Degradation contract: any `SpillError` (disk full, unwritable dir, eviction failure) → `abandon()`, switch mode to capture-without-spill, envelope reports `spill: null, truncated: true`, child keeps draining, command exit status unaffected.

**Tests** (`spill.rs` unit tests + integration `[uncited]`)
- `spill_bytes_equal_child_bytes_stdout` / `..._stderr` / `..._interleaved` — all three shapes; assert `SpillMeta.bytes == child total bytes` and spilled file content hash == captured child bytes hash.
- `small_output_creates_no_spill_file` — under `in_memory_cap`, no file, meta reports in-memory.
- `spill_write_error_degrades_to_capture_without_spill` — failing-writer seam `[uncited: cfg(test) wrapper returning errors]`; command still succeeds, envelope `spill: null, truncated: true`.
- `eintr_write_retries` — writer seam returns `Interrupted` k times, then succeeds; chunk lands exactly once.
- `spill_dir_evicts_oldest_first_under_size_cap` and `spill_ttl_expiry_removes_stale_files`.
- `deterministic_names_per_request` — same request id → same path; different ids → distinct; names contain no clock/nondeterminism.

**Ship criteria** — three-shape byte-equality green on Linux AND macOS; degradation test green; parity green with spill disabled; sweep tests green.

**Revert** — spill behind its own flag `[uncited: e.g. PIBASH_SPILL=0]`; revert = disable flag (code stays) or `git revert` the commit.

---

## Step 5 — serialization A/B (four cells)

**Target files**
- `rust-tools/pibash/bench-serialization.mjs` — new measurement script `[uncited name]`; alternatively a mode flag on `bench-seq50000.mjs`. No production code changes.

**Cells** (measure all four, both OSes):
- A1 `to_writer`-into-Vec × small envelope; A2 same × large envelope (envelope at maximum post-change size: head+tail at budget — NOT full output text).
- B1 `to_string`-then-write × small; B2 same × large.
- [uncited: if the envelope builder is hand-rolled rather than serde-based, the cells become incremental-writer vs `format!`-then-write; cell semantics unchanged.]

**Tests** — none (measurement step); the script self-checks that both cells emit byte-identical JSON for the same envelope, so the comparison is fair.

**Ship criteria** — all four cells measured with numbers recorded (PR description or a short results block in the bench script); winner chosen on evidence (allocations, peak RSS during serialization, wall time); no daemon change in this step.

**Revert** — nothing to revert; the bench script can be dropped independently.

---

## Step 6 — envelope construction switches to the single-pass winner

**Target files**
- `rust-tools/pibash/src/main.rs` — the envelope builder introduced/fixed on 2026-10-19 [uncited: locate via `rg -n` for the single-materialization path]. Keep the old builder callable until step 7; select via flag `[uncited]`, default old, flip after tests pass.

**New/changed code**
```rust
pub struct Envelope { /* existing fields + spill: Option<SpillMeta>, [uncited exact JSON shape] */ }
fn build_envelope(capture: &CaptureSummary, spill: Option<SpillMeta>, exit: /* ExitInfo [uncited] */)
    -> Result<Envelope, BudgetError>;                       // checked math, no panics
fn write_envelope(env: &Envelope, out: &mut impl Write) -> io::Result<()>;
    // implements the step-5 winner; O(envelope); EINTR-safe at the raw write
```
Envelope carries `{spill: {path, bytes, lines, truncated} | null}` — string + counters only, never spilled text. When spill is absent (small outputs) the rendered JSON must be unchanged from the old builder.

**Tests**
- `envelope_byte_identical_old_vs_new_small_fixture` and `..._medium_fixture` — for spill-absent fixtures the new builder's output is byte-identical to the old builder's; this is what keeps `tests/pibash-parity.test.mjs` green through the flip.
- `envelope_spill_field_shape` — spilled case renders `path`/`bytes`/`lines`/`truncated` counters and no output text `[uncited fixture]`.
- `envelope_omits_spill_text_entirely` — grep-level assertion that no fixture line of child output appears in a spilled envelope.
- Then measure: `bench-seq50000.mjs` before/after; record wall time and `envelope_bytes`.

**Ship criteria** — byte-identical assertions green; parity green after flipping the default; bench shows no regression on seq 50000; doc updated (§ pibash).

**Revert** — flip the builder-selection flag back (one line) or `git revert`; both builders still exist until step 7.

---

## Step 7 — delete the old path

**Target files**
- `rust-tools/pibash/src/main.rs` — remove the old full-stream accumulator, the legacy tail serializer, the step-3 equivalence flag, and the step-6 builder-selection flag. Delete any module only the old path used.

**Changed code** — deletions only, plus: retire the shadow dual-run equivalence test by repinning candidate output against recorded golden bytes `[uncited: keep the golden comparison, drop the dual-run]` so parity remains byte-exact after the old path is gone.

**Tests** — existing parity + step-3/4/6 tests must remain green with the old code gone; no new tests beyond the repinned goldens.

**Ship criteria** — build with zero `dead_code` warnings; parity green; bench re-run; equivalence gate (step 3) had been green on both OSes for consecutive CI runs before this commit merges; doc updated.

**Revert** — `git revert` the deletion commit; it is self-contained precisely because steps 3–6 kept both paths coexisting and revertible.

---

## Step 8 — fixtures + RSS/envelope assertions in the benchmark harness (Linux AND macOS)

**Target files**
- `rust-tools/pibash/bench-seq50000.mjs` — extend, or add `rust-tools/pibash/bench-large-output.mjs` `[uncited]`.
- `tests/pibash-large-output.test.mjs` — new regression test `[uncited]`.
- CI config to run the harness on both OS jobs `[uncited file]`.

**Assertions / metrics**
- Headline metric line per run: `child_bytes : spill_bytes : envelope_bytes`. Required relations: `spill_bytes == child_bytes` (when spilled); `envelope_bytes` is O(envelope) — constant-ish as `child_bytes` grows.
- Peak RSS via `ru_maxrss` with the unit trap handled explicitly: Linux reports KiB, macOS reports bytes. Normalize through one helper (`to_bytes(value, platform)`; Linux ×1024, macOS as-is) `[uncited: obtained via /usr/bin/time -v | -l or process.resourceUsage — verify which]`.
- Regression guards, hard assertions:
  - `seq50000_envelope_bytes_within_budget` — `envelope_bytes <= BUDGET_SEQ50000 * 1.1` (budget constant fixed in the script `[uncited value]`).
  - `seq50000_peak_rss_under_constant` — `peak_rss_bytes <= RSS_CAP_BYTES`, an absolute constant fixed from the first green run plus margin; never relative to the current run `[uncited value]`.
  - `spill_bytes_equal_child_bytes_all_shapes` — harness-level re-check of step 4's equality.
  - `rss_bounded_as_output_grows` — seq 50000 vs a larger case `[uncited size]`; RSS delta stays under a fixed allowance.

**Ship criteria** — green on Linux AND macOS CI; metrics table recorded in the PR; constants documented in the harness header.

**Revert** — assertions live only in bench/test files; `git revert` restores the previous harness; no production code touched.

---

## Sequencing and equivalence gate

- Dependency order: 1 and 2 are independent foundations (parallelizable). 3 needs 1 (ring) and 2 (splitter feeds candidates). 4 needs 2 (line counts) and can proceed in parallel with 3. 5 is measurement-only and can run any time, but must conclude before 6 picks the serializer. 6 needs 3 (candidate summary), 4 (spill meta), 5 (winner). 7 is last code step, gated. 8 lands after 7 so the guards pin the final shape (its spill-equality assertions can be drafted after 4).
- Main line: 1 → 3 → (4 ∥ 5) → 6 → 7 → 8.
- Gates (all must be green on Linux AND macOS before the next step merges):
  - G1 (step 3): candidate output byte-equals current compaction on the full corpus — blocks flipping step 6's default and blocks step 7. Per the checklist: do not delete the old path until it passes.
  - G2 (step 4): spill bytes equal child bytes on all three shapes.
  - G3 (step 6): byte-identical envelopes on small/medium fixtures; `tests/pibash-parity.test.mjs` green after the default flip.
  - Step 7 additionally requires G1 green across consecutive CI runs, not a single pass.
- Each flag default-flip is its own commit, separate from the code that adds the path — that is what makes every step independently revertible by flag or by `git revert`.
- Bench anchor: after any step touching the read loop (3, 4, 6, 7), re-run `bench-seq50000.mjs`; wall time must not regress beyond noise `[uncited threshold, e.g. 5%]`.

## Risks

- **panic=abort**: any panic in the daemon aborts the session mid-request. All counter/length arithmetic in production paths must be checked `Result` math (`checked_add` etc.); budget violations return errors at construction; `assert!`/`unwrap()`/indexing panics are forbidden outside `#[cfg(test)]`.
- **EINTR**: every raw read (child pipes, daemon input) and raw write (spill file, envelope output) must loop on `ErrorKind::Interrupted`; the 2026-10-19 code is the reference for existing raw-read sites [uncited].
- **Budget arithmetic**: `head_bytes + tail_bytes + error_bytes <= model-visible budget` enforced at `CandidateCapture::new` as a returned error; violations degrade (capture-without-spill semantics), never abort the command.
- **Scratch-buffer reuse / single-materialization**: the 2026-10-17 payload-shipped-twice regression is the precedent. Keep exactly one shared line split and one read chunk buffer feeding both candidate capture and spill; candidates must not clone per line into fresh allocations when the bounded rings can own the bytes (copy-on-write compression stages stay as-is). Any new full-stream materialization — accidental or intentional — is a design violation; step 8's `envelope_bytes` guard plus parity tests are the tripwire.
- **ru_maxrss unit trap**: Linux KiB vs macOS bytes; one normalization helper, asserted in a unit test with known values, before any RSS guard trusts it.
- **Spill disk pressure**: TTL/size-cap sweep runs before the write path can fail on a full disk; all spill IO failures degrade to capture-without-spill (`spill: null, truncated: true`) and never fail the command.
- **Non-UTF-8 output**: byte-level splitting end-to-end; `from_utf8_lossy` only at envelope render time; all counters stay in bytes.
- **Naming/nondeterminism**: spill names must be deterministic per request (no clocks) or the step-8 byte-equality assertions flake; eviction ordering uses mtime, which is coarse on some filesystems [uncited: verify both OSes in sweep tests].
