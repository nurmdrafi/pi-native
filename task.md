# Task tracker

Living tracker for the harness-improvement program. One line per task; details live in the linked doc. Updated in real time as each task/research/subagent changes state.

Legend: `[ ]` todo · `[~]` in flight · `[x]` done · `[!]` blocked · `[…]` subagent name

**last-updated: 2026-10-20 02:40** — PHASE COMMITS LANDED (user-approved): 6531e42 · 2692e37 · 21bc31b · 9a0593a · 66e8da3 · f51cfc2. **TWO OUTCOMES THIS SESSION, BOTH NET NEGATIVE — see "Bad outcomes" below.** (1) pibash P0 capture/stream chain: ~2.5 h, REVERTED — measurably slower than HEAD. (2) Observability emitter: REMOVED — never enabled, never ran. pibash is back on the old accumulator path; verified byte-identical output, 140/0/1 cargo, parity 61/61, typecheck clean. NOTHING COMMITTED. NEXT: stop rebuilding pibash/or adding instrumentation; the −94.4% model-visible win was already banked at f51cfc2. (User: no further A/B work — time and money already spent.)

## Done

- [x] Research corpus (8 reports) → `research/` — readme-repo-metadata, pibash-large-output, daemon-protocol, process-groups-cancellation, benchmark-observability, permission-gate-audit (+adjustment plan), security-boundary, subagents
- [x] README restructure 438 → 133 lines; detail migrated to `docs/{native-tools,skills,subagents,design-rules,development}.md` — per `research/readme-repo-metadata.md` revision plan
- [x] pibash P0 step 5 — serialization A/B, run by worker `bench-ser`; artifacts (examples/bench-serialization.rs, bench-serialization.mjs) DELETED with the revert. Result was a wash for the goal — see "Bad outcomes" above.
- [x] GitHub About + 16 topics applied via `gh` (glm-verified repo metadata)
- [x] Subagent tool-surface fix — first-party `-e` paths hardcoded in `getToolExtensionPath` (`extensions/subagents/index.ts`); regression test added; suite 156/156 — activates on next orchestrator-session restart
- [x] Subagent model pin verified — explicit `model` spawn param → child runs `zai/glm-5.3` (probe3 session evidence)
- [x] `research/changelog-proposal.md` — ready-to-paste 2026-10-19 block (4 entries, what/why/risk/delta); awaiting approval
- [x] `research/pibash-implementation-plan.md` — per-step plan (targets, signatures, tests, ship/revert criteria) from worker `pibash-plan`
- [x] doc-check inventory families re-pointed at canonical docs — skills table: README.md → docs/skills.md; extensions catalog: README.md → extensions/README.md (whole-file); `rust-skills` + `sdk-development` rows restored; `self-heal/` row added; NON_EXTENSION_DIRS prose-filter (bin/npm/git); README demo fence console→text; all 4 families PASS
- [x] `npm run check` full gate green — 184/184 tests
- [x] `benchmark/observability/SCHEMA.md` — written by worker `bench-schema` (24m run, needed a ship-it nudge): envelope table, write-time rules, aggregates, fixtures; OTel sources verified live
- [x] README: ASCII architecture diagram → fancy Mermaid flowchart (styled ladder, subgraph, classDefs); badge in-page anchors fixed (#portability/#subagents/#skills/#extensions → real docs targets); links re-verified 0 broken; doc:check 4/4 PASS — review per documentation-writer skill: numbers verified (24 rules via RULE_IDS, 7.0×, −94.3% docs/native-tools.md:108, .nvmrc=24); installer URL + `pi update` claim verified against installed pi package README (web-check); mermaid v3: full request-lifecycle (closed loop turn→gate→ladder→shaping→model, skills/subagents sidebar) after two parser fixes (`:::`/`call` keyword removed, v11.3)

## Bad outcomes (read before planning anything pibash-related)

- [!] **pibash P0 capture/stream rebuild — FAILED, reverted.** ~2.5 h of work, never committed, deleted.
  - **Bad output:** measured ~18% SLOWER than the version it replaced (1M lines 167 ms vs 142 ms; 2M 303 ms vs 278 ms) and no envelope-size gain. It traded a working fast path for a slower streaming one.
  - **Why it looked done:** every step was verified for byte-equality, never for speed or size. "DONE+VERIFIED" meant "goldens match", not "better than yesterday". The goal metric was only checked at the very end.
  - **The verification layer was itself broken** (this is the bigger lesson): cargo tests never loaded the goldens; `RSS_CAP_BYTES: 0` was a stub that made the RSS gate unfailable; tests read `truncation.total_bytes` while the emitter emits `totalBytes`; goldens asserted the old `spillUsed` field. Three node tests had been failing the whole time while the tracker reported green.
  - **Root cause of the slowdown, for the record:** `capture.rs` `FeedMode::PreEsc` copied every line into a `pre_esc` buffer (4×max_bytes) to support retroactive ANSI strip — a second full copy of the stream, discarded in the common no-ESC case. New-only cost; the old accumulator never did this. Also the newline scan was per-byte rather than `memchr` (that fix helped, was not enough, and was itself reverted).
  - **Where it went?** Backup: /tmp/pibash-new-chain-backup.tar.gz — volatile, /tmp does not survive reboot. Treat as gone.
- [!] **Observability emitter — REMOVED.** Never enabled in settings, never wrote a single event; ~1176 lines plus 305 lines of `oc` plumbing in all four tool extensions. Runtime cost was negligible; it was pure unproven weight. Deleted.
- **Lesson for this repo:** do not start a rewrite before the metric you expect to improve has been measured on the current code. A correctness-only gate cannot detect a regression — pair every structural change with one number taken before and after, or do not start.

## In flight

- (nothing in flight) — all pibash work closed this session; see "Bad outcomes" above. Do not restart without an explicit user instruction.
- [x] README tail PI_* env keys — DONE [readme-envkeys], VERIFIED in main: README.md +17 lines only (3-col table + plumbing line), every key rg-verified at source (pibash index.ts CONTEXT_ENV_KEYS, subagents index.ts, pidx); doc:check all 4 families PASS pre+post; note: README is now 173 lines (grew since the 133-line restructure).
- [x] Observability emitter — REMOVED (never enabled, never ran; deleted on user request to cut overhead). Deleted: extensions/observability/{lib,index}.ts, benchmark/observability/{aggregate,fixtures}.mjs, tests/observability.test.mjs, plus the `oc`/CallObs plumbing reverted out of all four tool extensions. benchmark/observability/SCHEMA.md kept (already committed). ~1176 lines removed, 305 lines of hot-path plumbing restored to HEAD. Note: runtime overhead was already negligible (one cached bool per call; hooks never registered) — the gain was maintenance/diff weight, not CPU.

## Next (recommended order)

- [ ] README tail: document forwarded `PI_*` context keys (PI_SESSION_FILE, PI_PROVIDER, PI_MODEL, PI_REASONING_LEVEL, PI_CODING_AGENT_DIR, PI_PIDX_MAX_INLINE) → doc:check env-vars family green
- [ ] README demo block: decide format (no GIF tooling available; console-transcript fallback) and replace the TODO placeholder
- [ ] Session restart → verify subagents spawn TOOLED + glm; then implementation fleet can run as subagents
- [ ] Benchmark/observability schema — 23-field JSONL envelope + tool×rung×size matrix (`research/benchmark-observability.md`) — build before the items below so impact is measured
- [!] pibash large-output fix (P0) — DROPPED. Attempted and reverted (see In flight); user declines further A/B work. Do not reopen without explicit instruction.
- [ ] Daemon protocol v1 + process groups — hello/version handshake, acked cancel + SIGTERM→SIGKILL ladder, ping health (`research/daemon-protocol.md`, `research/process-groups-cancellation.md`)
- [ ] Permission-gate adjustments — gated on 3-day session evidence; then security-first (write/pidx path ladder), then read-ladder friction relief (`research/permission-gate-audit.md` §Adjustment plan)
- [ ] Security hardening — write.path reuses piedit's normPath+symlink+H2 ladder; pidx path containment (`research/security-boundary.md`, `research/permission-gate-audit.md`)

## Blocked / open bugs

- [x] Child default model — VERIFIED post-restart: probe child session record shows `model_change provider=zai modelId=glm-5.3` (settings default governs; convention holds: never pin `model` on spawns).
- [x] Toolless spawns — CLEARED post-restart: probe worker executed native piread/pibash via `-e` loadout (extensions/subagents/index.ts map fix active).

## Awaiting user approval

- [ ] Push of the six phase commits (push NOT yet approved; commits are local)
- [ ] feedback.md — personal log, deliberately uncommitted; decide policy

## Verify

```sh
npm run check        # typecheck → agents lint → doc check → tests
npm run daemons:kill # after rebuilding native tools
```
