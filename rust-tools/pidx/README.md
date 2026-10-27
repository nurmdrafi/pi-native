# pidx — incremental session-log indexer

Rust crate behind the `pidx` tool: parses pi session transcripts
(`<sessions-dir>/<project>/<ISO-ts>_<uuid>.jsonl`) into compact per-session extracts —
turns, tool calls with param hashes, tool results, compactions, skill loads.

- Session-audit's L0 fast path (the Node parser is the fallback).
- Incremental: files keyed by `(size, mtime_ns)`; unchanged files replay the cached
  extract from the store, so warm runs are **O(changes), not O(archive)**.
- Std-only + mtime (OS-agnostic, no watchers).

- Spec: none of its own — tracked under MASTER (S1 session-metrics / session-audit).
- Extension: `extensions/pidx/index.ts`
- Source: `src/main.rs` (single file, ~790 lines)

Status: shipped, default-on, opt out with `PI_NATIVE_PIDX=0`.

---

## Build walkthrough — steps tried

### Origin: `tools/pidx` → `rust-tools/pidx`

1. pidx first landed as `tools/pidx/` (a standalone crate). The layout was then
   consolidated under `native/` alongside the other Rust helper crates — commit
   `3edb2b6` (`chore: add pidx: Incremental index/extract for pi session logs`) moves
   `tools/pidx/{.gitignore,Cargo.toml,src/main.rs}` → `native/pidx/` with no code
   change, drops the committed `tools/pidx/Cargo.lock` (cargo locks are gitignored
   repo-wide), adds `native/pidx/Feedback.md` (since moved to
   `docs/reviews/harness-review.md` — it is a repo-wide design review, not pidx docs),
   and updates `scripts/bootstrap.sh` + `docs/token-economy.md` to the new path.
2. `native/` was later renamed to **`rust-tools/`** and became a Cargo workspace
   (`rust-tools/Cargo.toml`, members `pidx`/`piread`/`piedit`) with one shared
   `rust-tools/Cargo.lock` (tracked) and one `rust-tools/target/`.

### Skeleton and parity target

2. Chose `serde` + `serde_json` (`preserve_order`, `float_roundtrip`) + `sha1`;
   release profile `opt-level 3 / lto / codegen-units 1 / strip` — no `unsafe`.
3. The parity target is the pre-existing Node parser (`skill/pidoc`'s
   `parser.mjs` / `session-audit`). Every divergence-prone behaviour is ported with an
   inline `PARITY:` note next to it so a later reader can see *why* a branch exists:
   - `tsMs`: JS `NaN` semantics — numbers >1e12 used as-is else ×1000; all-digit
     strings likewise; otherwise an ISO parse (`Date.parse` subset:
     `YYYY-MM-DD[ T]HH:MM[:SS[.fff…]][Z|±HH(:MM|MM)|±HHMM]`, date-only = UTC midnight).
   - `ACTIVE_SESSION_MS = 5 min` (`discover.mjs` invariant 5).
   - `IMAGE_BYTES_ESTIMATE = 4000` for image tool-result byte accounting.
4. Extract schema fixed at `{v:1, sessionId, project, path, turns, calls, results,
   compactions, skills}` — this is the contract session-audit reads; it mirrors
   `parser.mjs` exactly.

### Store and incrementality

5. The state store keeps a small header of byte ranges plus the raw extract bytes, so a
   warm run replays unchanged sessions without re-parsing **or** re-serializing them —
   this is what turns the warm path into O(changes).
6. Output: one JSON line per session (newest first) to `--out` (default stdout); a
   summary JSON line to stderr. Exit 0 on success even with individually unparseable
   files (they yield an extract with zero turns) — a corrupt transcript must not fail
   the whole run.

### Verification and wiring

7. No in-crate unit tests were written (the parity oracle is the session-audit
   Node parser and the end-to-end pidx output). `cargo test` is 0 tests, green.
8. `scripts/bootstrap.sh` builds `rust-tools/pidx` → `bin/pidx` (cargo-missing prints the
   Node-fallback note); `scripts/after-pull.sh` / `pidoc --fix` rebuild it when
   missing/stale. README documents it as the session-audit fast path.
9. `extensions/pidx/index.ts` registers the first-class `pidx` tool; failures throw so
   the model can fall back to the Node parser.

### Measured

Recorded in README ("Native tool performance") from this repo's archive
(474 sessions / 85 MB): warm run **~28×** faster than the Node parser (~14 ms vs
~0.28 s), cold ~2×, warm peak RSS ~17× less (~17 MB vs ~290 MB). Warm runs are
O(changes), not O(archive).

## Notes / gotchas

- Single-file crate — no `cli.rs`/`envelope.rs` split (unlike piread/piedit); the
  parser needs the whole JSON pipeline in one place for the PARITY notes.
- `Cargo.lock` stays untracked (repo-wide gitignore), matching the other crates.
- Edition 2021 (pidx predates the 2024-edition crates piread/piedit).
