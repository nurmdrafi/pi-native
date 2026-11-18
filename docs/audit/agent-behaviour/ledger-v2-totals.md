# Ledger v2 — corrected block totals, window 2026-11-04..18

AB-1 fix landed 2026-11-18: `tests/gate/gate-labels.mjs` now recognizes the
`Hygiene` label and `tests/tools/audit/session-blocks.mjs` FAMILIES has a
`hygiene` row, so Hygiene gate events count as blocks instead of non-gate
errors. Red-green proof: `tests/tools/audit/session-blocks.test.mjs` on
`tests/tools/audit/fixtures/hygiene-block.jsonl`.

## Corrected family totals (this sweep)

Sweep glob matched 200 session files (v1 ledger was built from 194/195; the
glob also picks up late-11-18 files and subagent sessions that kept appending
after the v1 sweep ran — the small permission delta below is file-set drift,
not reclassification).

| family | v1 | v2 | delta |
|--------|----|----|-------|
| permission (destructive + control-plane heads) | 172 | 183 | +11 (window drift) |
| **hygiene** | **0 (misfiled as errors)** | **42** | **+42** |
| re-read | 26 | 26 | 0 |
| commitlint | 11 | 11 | 0 |
| loop | 3 | 3 | 0 |
| token | 1 | 1 | 0 |
| anchor | 0 | 0 | 0 |
| **blocks total** | 213 | **266** | +53 |
| non-gate errors | 345 | **309** | -36 (42 reclassified, +6 from extra files) |

Validation: the AB-1 evidence session
(`sessions/--home-nurmdrafi-.pi-agent--/2026-11-18T19-51-11-427Z_01a1f036-9543-76e0-8d61-1ad568ca0d48.jsonl`)
now reports `blocks: 2 byFamily={"hygiene":2}`.

## Reproduce

    mkdir -p /tmp/behave-audit-v2
    for f in $(find ~/.pi/agent/sessions \( -name '2026-11-0[4-9]*.jsonl' -o -name '2026-11-1[0-8]*.jsonl' \) | sort); do
      node tests/tools/audit/session-blocks.mjs --session "$f" --json > "/tmp/behave-audit-v2/$(basename "$f").json"
    done

Aggregate with sparse-safe jq (family totals — NB: the `reduce` form from the
plan trips the destructive-confirm heuristic on its assignment-shaped jq; the
`group_by` form below is the compliant read-only equivalent that was used):

    jq -s '[.[] | (.blocks.byFamily // {}) | to_entries[]] | group_by(.key)
           | map({family: .[0].key, total: (map(.value) | add)}) | sort_by(-.total)' /tmp/behave-audit-v2/*.json
    jq -s '{sessions: length, blocks: (map(.blocks.total) | add),
            errors: (map(.errors.total) | add)}' /tmp/behave-audit-v2/*.json

## Notes

- Baseline restatement (T1.4): the permission-gates do-done criterion
  ("new events < 20% of the 2026-11-18 baseline of 186/day") must now be
  measured on v2 semantics — gate events include Hygiene. On v1 semantics
  the baseline silently excluded all hygiene events; any follow-up sweep
  (due >= 2026-11-21) must re-count the 2026-11-18 baseline day under v2
  before comparing.

- The 42 hygiene blocks are `Hygiene (Reader-bypass)` reader-bypass events
  (jq pipes over big files, read-position cat/sed); the extension also emits
  `Hygiene (native read|bash|write)`, `(view credit)`, `(error swallow)`
  variants, all covered by the new label.
- Downstream consumers of `gate-labels.mjs` (`tests/tools/audit/block-recovery.mjs`,
  `tests/gate/harness/stub.mjs`) pick up the fix automatically; no behavior
  assertions changed for them (no Hygiene strings in their fixtures).
