# piedit — native edit pipeline (S8)

Rust crate behind the `piedit` tool: read → LF/BOM normalize → exact/fuzzy match →
uniqueness/overlap/no-change validation → apply → write → **native diff/patch render**,
with the result returned as `{diff, patch, firstChangedLine}` over a JSON envelope
(byte-identical jsdiff port, `src/diff.rs`; `renderDiff: true` requests it). The legacy
`{baseContent, newContent}` envelope remains for mixed-version compatibility, and the
extension renders it with the exported TypeScript `generateDiffString`/
`generateUnifiedPatch` helpers — either way `details` is byte-identical to the built-in
`edit`, pinned by the parity suite and the differential fuzz.

- Spec: `docs/specs/2026-10-16-s8-piedit-design.md`
- Plan: `docs/specs/2026-10-16-s8-piedit-plan.md`
- Extension: `extensions/piedit/index.ts`
- Tests: `../..//tests/piedit-parity.test.mjs`, `../../tests/piedit-bench.mjs`
- Bench: `../../benchmark/runs/piedit-microbench-*.md`

Status: shipped, default-on, opt out with `PI_NATIVE_EDIT=0`. Parity 40/40, crate 25/25,
permission-gate 246/246 unchanged, `doc:check` 4/4.

---

## Implementation walkthrough — every step tried

Records what was actually attempted, in order, including dead ends and corrections, so a
later session can retrace the path without re-deriving it.

### Phase 0 — Reconnaissance and the abort-gate discovery

1. Read spec + plan. Found Step 0 had **already run** (commit `906a480`,
   `benchmark/runs/s8-hotpath-2026-10-16.md`): match+apply 20.2%, diff+patch 58.6%,
   write 13.5%. The spec's abort condition (D7/R1) fired; `MASTER.md` §3 marked S8
   **aborted** and no Rust had been written.
2. Offered options (leave aborted / amend spec / build anyway). User: "try again"
   (same result), then "skip spec and plan, continue build piedit following existing
   tool like pidx, piread" — an explicit override of the gate.
3. Noted the small-file hot path was a **spawn-cost** story, not a matching-cost story —
   the seed for the later daemon work.

### Phase 1 — Studying the precedent (pidx, piread)

4. Read `rust-tools/piread/src/{main,cli,envelope,pipeline,serve}.rs`, `Cargo.toml`.
5. Read `extensions/piread/index.ts` (individual registration, fail-open ladder, daemon
   client, `__resetDaemonForTest`) and `extensions/pidx/index.ts`.
6. Read the built-in contracts to mirror exactly: `edit.js` (schema,
   `prepareArguments`, `validateEditInput`, executor, write call), `edit-diff.js`
   (matching, six error builders, diff/patch helpers), `file-mutation-queue.js`
   (re-entrant-hostile on the same path), and the permission-gate edit branch /
   file-path scrape / `tool_result` handler.
7. Verified SDK exports at runtime: `createEditTool`, `createEditToolDefinition`,
   `generateDiffString`, `generateUnifiedPatch`, `withFileMutationQueue`.

### Phase 2 — Crate skeleton

8. Wrote `Cargo.toml` (edition 2024; serde, serde_json, unicode-normalization; release
   profile mirroring pidx/piread; `tempfile` dev-dep).
9. Wrote `src/cli.rs` — `--path` required, `--serve`/`--version`/`--help`.
10. Wrote `src/envelope.rs` — request `{edits:[{oldText,newText}]}`, success
    `{ok, baseContent, newContent}`, failure `{ok, error:{kind,message}}`, hand-rolled
    JSON writer pinned byte-equal to serde by test.
11. Wrote `src/main.rs` — exit 0/2/3 mapping.

### Phase 3 — Match + apply + write pipeline

12. Wrote `src/pipeline.rs` porting `applyEditsToNormalizedContent` exactly:
    `normalizeToLF`, `detectLineEnding`, `restoreLineEndings`, `splitBom`,
    `normalizeForFuzzyMatch` (NFKC + per-line trimEnd + quote/dash/space maps),
    `fuzzyFindText`, `countOccurrences`, `applyReplacements`,
    `applyReplacementsPreservingUnchangedLines`, all six error builders.
13. First `cargo test` failed: `Applied` missing `Debug` → derive added.
14. Second failure: `ErrorKind` not `Serialize` (byte-parity tests use serde derives)
    → `#[derive(Serialize)]` with variant renames.
15. Third failure: `fuzzy_trailing_whitespace_preserves_untouched_lines` — my test
    expectation was wrong. Checked the oracle directly: `"  target"` matches exactly
    (index 10), so it takes the exact-apply path and keeps trailing spaces. Fixed the
    test and added a genuine fuzzy-path test.
16. Clippy `-D warnings`: dead field `MatchResult.content_for_replacement` → removed.
17. `cargo test` 25/25, clippy clean, release build, copied to `bin/piedit`. Smoke:
    success, missing-file, duplicate, malformed-input envelopes.
18. **Error-message divergence.** Mine used the numeric errno (`Error code: 2`); the
    built-in uses Node's string code (`Error code: ENOENT.`) and directory targets
    propagate raw (`EISDIR: illegal operation on a directory, read`), unwrapped.
    Added `node_code`/`node_io_message`/`access_error`; verified against the oracle for
    missing/dir/dup/ro. Removed a stray ` (path …)` suffix to match exactly.
19. Added `.gitignore` (`/target`).

### Phase 4 — Extension + parity suite

20. Wrote `extensions/piedit/index.ts` — individual registration, spread definition,
    overrides, `withFileMutationQueue`, diff/patch via exported helpers, fallback +
    violation log.
21. **`execFileAsync(..., { input })` hung.** `execFile` has no `input` option (that is
    `execFileSync`); the child blocked on stdin. Rewrote as raw `spawn` +
    `child.stdin.end(request)`.
22. Wrote `tests/piedit-parity.test.mjs` (oracle = `createEditTool`, fresh copies per
    arm, compare bytes + error message + `content` + `details`).
23. Debug cycle: `replace` → `replaceAll` in `mapPath`; deep JSON-map all strings
    before compare (paths appear in `content`/`patch`); rebuilt the `large-1mib` body.
24. **Deadlock.** Fallback re-entered `withFileMutationQueue` on the same path (the
    built-in executor takes the same queue). Restructured: native dispatch returns a
    `{fallback}` sentinel under the queue; the built-in runs **after** it releases.
25. Suite **37/37 PASS**; typecheck clean.

### Phase 5 — Gate compatibility

26. `extensions/permission-gate/index.ts`: `piedit` added to the edit-kind branch, the
    file-path scrape, and the replay edit path.
27. Added gate lock-ins: unread block identical, overlap identical, missing-anchor
    identical, read→piedit region requirement, protected-path block-before-execute.
28. **Protected-path test premise was wrong**: `node_modules` is read-kind, not
    edit-kind. Rewrote with a fake `HOME` + `~/.ssh/id_rsa` and headless ctx
    (H2 fail-closed). `permission-gate` 246/246 unchanged.

### Phase 6 — Build wiring + docs

29. `scripts/bootstrap.sh` step 5 builds `rust-tools/piedit` → `bin/piedit` (cargo-missing
    prints the fallback note); health check renumbered.
30. `scripts/after-pull.sh` step 4 staleness-gated rebuild. `sh -n` both.
31. README: Custom-tool-binaries table, Rust requirement line, `rust-tools/` tree line,
    Extensions section, `PI_NATIVE_EDIT`.
32. `doc:check` initially failed twice (README must mention the extension dir and the
    env var) → fixed to 4/4.
33. Added a CHANGELOG `[1.41.0]` entry.

### Phase 7 — Micro-bench

34. Wrote `tests/piedit-bench.mjs` (corpus × arms × N, spawn floor, RSS, report).
35. First run crashed: `multiline-block` anchor not unique → fixed to
    `block1000/1001/1002`.
36. Result: one-shot arm ~3.2–4.2 ms on small files vs the built-in's sub-millisecond —
    **4–7× slower**; only the raw 1 MiB pipeline beat the built-in (35.9 vs 90.8 ms),
    and the JSON round-trip ate it (111.6 ms).

### Phase 8 — The daemon optimization ("improve then update")

37. Reported the honest "not faster" picture; offered (a) document the truth or
    (b) build a `--serve` daemon. User chose (b).
38. Added `src/serve.rs` (NDJSON over stdio, id echo, reused buffer), daemon envelope
    writers, `Usage`/`Protocol` kinds, `--serve` in the CLI, dispatch in `main.rs`.
39. Wrote the extension daemon client (lazy start, id matching, ref/unref hygiene, lazy
    restart, `__resetDaemonForTest`) with the ladder **daemon → one-shot → built-in**.
40. **Relative-path parity bug.** The daemon resolved the relative path against its own
    cwd, and error messages must use the caller-supplied path. Threaded both: request
    carries `path` (display) + `resolved` (I/O);
    `pipeline::edit_file(path, resolved, edits)`.
41. Parity fixes for the daemon: import `resetDaemon`, reset before fallback cold-start
    cases, add daemon lock-ins (concurrent id matching, lazy restart, pre-abort). Two
    of my own test bugs (different paths compared for `content`/`details`) → compare
    path-independent fields.
42. **40/40 PASS.**
43. Re-ran the bench (two runs, within noise): small exact **0.335 vs 0.527 ms**, small
    fuzzy **0.326 vs 0.499 ms**, mid multi 0.688 vs 0.793 ms, mid exact/multiline
    parity, large 1 MiB 120.3 vs 89.4 ms (R6 regression). Relabeled the report arms
    (daemon / oneshot) and added honest notes.

### Phase 9 — Verification and docs update

44. Full battery: crate 25/25, clippy clean, parity 40/40, permission-gate 246/246,
    `doc:check` 4/4, typecheck clean.
45. Sabotage smoke: missing `bin/piedit` → fail-open to built-in (file edited, result
    complete, one stderr line); break the dash-normalization map → parity red; restore
    → green.
46. `gate:eval` `new_fail: 3`. **Verified pre-existing** by `git checkout` of just
    `extensions/permission-gate/index.ts` and re-running — identical on HEAD (the
    `grep`/`find` A-fixtures from the SS2/SS3 rg/fd posture). Not caused by this work.
47. Docs: README Extensions + Native-performance table (piedit rows), CHANGELOG entry
    rewritten for the daemon and real numbers, design spec status + D5 revised +
    "Implementation outcome" + §8 table, plan status + Step 6/7/8 outcome, MASTER §3
    (`done (gate overridden)`) + §7 outcome line.

### Side task (unrelated, requested mid-stream)

48. **DeepSeek thinking level off.** `settings.json` has `defaultThinkingLevel: high`;
    `models-store.json` is a regenerated cache (not editable). Per `docs/settings.md` /
    `docs/models.md`, `modelThinkingLevels` is keyed by exact `provider/modelId`. Set
    `deepseek/deepseek-flash` and `deepseek/deepseek-v4-pro` → `"off"`. Caveat: keys
    assume the catalog IDs; a custom provider needs different keys.

---

## Dead ends and corrections (summary)

- `execFile({input})` does not exist → raw `spawn` + `stdin.end`.
- Fallback deadlocked by re-entering the file-mutation queue → deferred fallback.
- `String.replace` vs `replaceAll` in the path normalizer.
- Numeric errno vs Node string error codes; directory errors unwrapped.
- `node_modules` is read-kind only; protected-path edits are system trees / `~/.ssh`.
- Three wrong test expectations (fuzzy trailing whitespace; path-bearing
  `content`/`details`) — corrected against the oracle.
- `Cargo.lock` is gitignored for pidx/piread too, so piedit's stays untracked.
- `gate:eval new_fail: 3` is pre-existing on HEAD, proven by reverting the gate file.

## Contract

CLI: `piedit --path <P>` reading `{"edits":[{"oldText":"…","newText":"…"}], "renderDiff"?:true}` on stdin;
`--serve` for the NDJSON daemon. Exit 0 ok · 2 usage · 3 I/O or validation error.

```jsonc
// success (renderDiff absent — legacy envelope, content pair crosses the boundary)
{ "ok": true, "baseContent": "<LF, BOM-stripped>", "newContent": "<LF, BOM-stripped>" }
// success (renderDiff true — native render; byte-identical to the TS helpers)
{ "ok": true, "diff": "…", "patch": "…", "firstChangedLine": 3 }
// failure
{ "ok": false, "error": { "kind": "ENOENT|EACCES|ENOTDIR|EMPTY_OLDTEXT|NOT_FOUND|DUPLICATE|OVERLAP|NO_CHANGE|io", "message": "<byte-identical to the built-in>" } }
```

Daemon request adds `id` (echoed) and optional `resolved` (absolute I/O path).
The extension always sends `renderDiff: true`; the legacy shape stays for
older-extension/older-binary mixed versions (the extension falls back to the
exported `generateDiffString`/`generateUnifiedPatch` when it receives it).

`src/diff.rs` (the native render) is a byte-identical port of the bundled
jsdiff v8 — line tokenizer, greedy Myers walk with jsdiff's exact tie-break
and component coalescing, `structuredPatch`/`formatPatch` with
`FILE_HEADERS_ONLY` — plus pi's `generateDiffString` rendering. One
`diff_lines` pass feeds both renders. Parity is pinned by the TS oracle:
`tests/piedit-parity.test.mjs` (51/51, diff-adversarial corpus) and
`tests/piedit-diff-fuzz.mjs` (deterministic differential fuzz).

## Not done

Step 7's S2 pair run and `s8-verdict-<date>.md` — no in-repo `s2-run/1` baseline exists
to compare against; latency evidence is the Step 6 bench. Follow-up: size-based routing
for >1 MiB files to the built-in (R6).
