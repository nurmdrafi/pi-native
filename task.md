# Task tracker

Living tracker for the harness-improvement program. One line per task; details live in the linked doc. Updated in real time as each task/research/subagent changes state.

Legend: `[ ]` todo · `[~]` in flight · `[x]` done · `[!]` blocked · `[…]` subagent name

**last-updated: 2026-10-20 01:12** — post-restart probe VERIFIED: worker spawn tooled (native piread/piedit/pibash executed in-child; `-e` map fix active), model `zai/glm-5.3` confirmed from child session record. pibash P0 delegation to workers begins (step 1: capture rework → worker `capture-v2`)

## Done

- [x] Research corpus (8 reports) → `research/` — readme-repo-metadata, pibash-large-output, daemon-protocol, process-groups-cancellation, benchmark-observability, permission-gate-audit (+adjustment plan), security-boundary, subagents
- [x] README restructure 438 → 133 lines; detail migrated to `docs/{native-tools,skills,subagents,design-rules,development}.md` — per `research/readme-repo-metadata.md` revision plan
- [x] pibash P0 step 5 — serialization A/B DONE by worker `bench-ser`: examples/bench-serialization.rs + bench-serialization.mjs, fairness guard PASS (byte-identical JSON), 158/158 green, no src/ touched; four-cell winner B (to_string) but diagnostics show to_writer-into-pre-sized-Vec strictly dominant (1 alloc/iter) → step-6 choice
- [x] GitHub About + 16 topics applied via `gh` (glm-verified repo metadata)
- [x] Subagent tool-surface fix — first-party `-e` paths hardcoded in `getToolExtensionPath` (`extensions/subagents/index.ts`); regression test added; suite 156/156 — activates on next orchestrator-session restart
- [x] Subagent model pin verified — explicit `model` spawn param → child runs `zai/glm-5.3` (probe3 session evidence)
- [x] `research/changelog-proposal.md` — ready-to-paste 2026-10-19 block (4 entries, what/why/risk/delta); awaiting approval
- [x] `research/pibash-implementation-plan.md` — per-step plan (targets, signatures, tests, ship/revert criteria) from worker `pibash-plan`
- [x] doc-check inventory families re-pointed at canonical docs — skills table: README.md → docs/skills.md; extensions catalog: README.md → extensions/README.md (whole-file); `rust-skills` + `sdk-development` rows restored; `self-heal/` row added; NON_EXTENSION_DIRS prose-filter (bin/npm/git); README demo fence console→text; all 4 families PASS
- [x] `npm run check` full gate green — 184/184 tests
- [x] `benchmark/observability/SCHEMA.md` — written by worker `bench-schema` (24m run, needed a ship-it nudge): envelope table, write-time rules, aggregates, fixtures; OTel sources verified live
- [x] README: ASCII architecture diagram → fancy Mermaid flowchart (styled ladder, subgraph, classDefs); badge in-page anchors fixed (#portability/#subagents/#skills/#extensions → real docs targets); links re-verified 0 broken; doc:check 4/4 PASS — review per documentation-writer skill: numbers verified (24 rules via RULE_IDS, 7.0×, −94.3% docs/native-tools.md:108, .nvmrc=24); installer URL + `pi update` claim verified against installed pi package README (web-check); mermaid v3: full request-lifecycle (closed loop turn→gate→ladder→shaping→model, skills/subagents sidebar) after two parser fixes (`:::`/`call` keyword removed, v11.3)

## In flight

- [~] pibash P0 implementation — DONE (main session): bounded::Ring, LineSplitter, CandidateCapture (byte-ring), SpillWriter+sweep, 158/158. IN FLIGHT [capture-v2]: (1) rework CandidateCapture to line-budget semantics matching compress.rs (head_tail/error_priority, 40/2048, 2/3–1/3, exact omission markers — spec compress.rs:225-390,788+). QUEUED: (2) shadow wiring PIBASH_CAPTURE_V2=1 (runner.rs:169-205 chunk loop, report-only sidecar); (3) serialization A/B (plan §5); (4) envelope → spill-reference {spill,bytes,lines,truncated}; (5) delete old accumulator full-stream path after equivalence gate; (6) 1/10/100 MB fixtures + RSS/envelope assertions (ru_maxrss unit trap).
- [~] Observability emitter implementation — IN FLIGHT [observability] worker: JSONL event schema per benchmark/observability/SCHEMA.md, config-keyed OFF by default, aggregate.mjs + fixtures, zero deps.

## Next (recommended order)

- [ ] README tail: document forwarded `PI_*` context keys (PI_SESSION_FILE, PI_PROVIDER, PI_MODEL, PI_REASONING_LEVEL, PI_CODING_AGENT_DIR, PI_PIDX_MAX_INLINE) → doc:check env-vars family green
- [ ] README demo block: decide format (no GIF tooling available; console-transcript fallback) and replace the TODO placeholder
- [ ] Session restart → verify subagents spawn TOOLED + glm; then implementation fleet can run as subagents
- [ ] Benchmark/observability schema — 23-field JSONL envelope + tool×rung×size matrix (`research/benchmark-observability.md`) — build before the items below so impact is measured
- [ ] pibash large-output fix (P0) — spill-as-single-copy, streaming accumulator, single serialization, 1/10/100 MB fixtures (`research/pibash-large-output.md` §1, §6 checklist)
- [ ] Daemon protocol v1 + process groups — hello/version handshake, acked cancel + SIGTERM→SIGKILL ladder, ping health (`research/daemon-protocol.md`, `research/process-groups-cancellation.md`)
- [ ] Permission-gate adjustments — gated on 3-day session evidence; then security-first (write/pidx path ladder), then read-ladder friction relief (`research/permission-gate-audit.md` §Adjustment plan)
- [ ] Security hardening — write.path reuses piedit's normPath+symlink+H2 ladder; pidx path containment (`research/security-boundary.md`, `research/permission-gate-audit.md`)

## Blocked / open bugs

- [x] Child default model — VERIFIED post-restart: probe child session record shows `model_change provider=zai modelId=glm-5.3` (settings default governs; convention holds: never pin `model` on spawns).
- [x] Toolless spawns — CLEARED post-restart: probe worker executed native piread/pibash via `-e` loadout (extensions/subagents/index.ts map fix active).

## Awaiting user approval

- [ ] CHANGELOG entry (once `research/changelog-proposal.md` lands)
- [ ] Commit + push of today's changes (README/docs, subagents fix, extensions README, research corpus, task.md)

## Verify

```sh
npm run check        # typecheck → agents lint → doc check → tests
npm run daemons:kill # after rebuilding native tools
```
