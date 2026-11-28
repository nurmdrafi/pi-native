# Harness-watch — the self-healing loop for the whole harness

Invariant: every harness error/warn/incident is evidence. The loop turns each
into a fix, a standing rule, or a revert — never silence. A block teaches one
call; a standing rule with condition, action, and why prevents the class
(AGENTS.md "Instruction rules").

## Sources → classes → actions

| Source | Harvests | Classes |
|--------|----------|---------|
| `gate` | permission-gate blocks/warns from session logs | misfire, contradiction, rule-gap, watch |
| `tool` | non-gate tool failures (recurring shape) | rule-gap, watch |
| `lesson` | new `lessons/harness.ndjson` records | lesson |
| `suite` | test failures (`--suite-log FILE` or `--with-suite`) | test-fail |

| Condition | Class | Action |
|-----------|-------|--------|
| gate block on a read-only command head | misfire | regression test + judge fix |
| gate block on a shape [AGENTS.md](../AGENTS.md), the [tool-use rules](../rules/tool-use.md), or scout mandates verbatim (a literal named only inside a prohibition line is not a mandate) | contradiction | carve gate or fix doc + canary test |
| same source:id+shape recurs ≥3 | rule-gap | invariant line in the tool rules |
| new lesson record | lesson | fix/doc/test that retires it |
| suite failure | test-fail | suite green (or flake fix) closes it |
| anything else | watch | tracked in events, no task |

## Two halves

| Half | What | Where |
|------|------|-------|
| Deterministic sentinel | harvest, classify, ledgers, metrics, status | `scripts/harness-watch.mjs` |
| Judgement | reproduce, fix via TDD, commit, monitor, revert | `prompts/harness-watch.md` (`/harness-watch`) |

The sentinel never edits code or git. The repair session never harvests by
hand — it reads the ledgers, so evidence and action cannot drift.

## Commands

    npm run harness:watch              # one harvest pass (cron-able)
    npm run harness:watch -- --daemon  # always-on: fs.watch sessions + lessons, 2 s debounce
    npm run harness:status             # health snapshot from the ledgers
    node scripts/harness-watch.mjs --with-suite        # full-suite check + gate:eval (persists eval:* metrics)
    node scripts/harness-watch.mjs --suite-log FILE    # parse an existing test log

Suggested wiring (machine schedulers stay out of the repo):

    # sentinel (launchd/cron) — keep the queue fresh within seconds
    cd "$HOME/.pi/agent" && node scripts/harness-watch.mjs --daemon >> "$HOME/.pi/agent/.cache/harness-watch/daemon.log" 2>&1
    # nightly suite evidence
    23 3 * * * cd "$HOME/.pi/agent" && node scripts/harness-watch.mjs --with-suite >> "$HOME/.pi/agent/.cache/harness-watch/cron.log" 2>&1

Repair runs on demand: open a session and invoke `/harness-watch`.

## Ledgers (`~/.pi/agent/.cache/harness-watch/`, append-only NDJSON)

- `events.ndjson` — one record per event, deduped by session+call; command
  text reduced to a ≤64c head — secrets never persist.
- `tasks.ndjson` — one record per task state change; latest per key wins;
  `open → fixed(sha) → reverted(sha)`; a fixed task reopens on recurrence.
- `metrics.ndjson` — per run per source:id:kind counts, plus `eval:<name>`
  records from each gate:eval run (manual or nightly `--with-suite`): one
  `{ts,key,n}` per scalar of the final metrics object, so series like
  `eval:pre_edit_read_rate` accumulate; the revert check diffs these across a
  fix commit's date.
- `state.json` — cursors: session files (mtime) and lessons (ts).

## Revert policy

A fix is judged by recurrence, not by its tests: if `metrics.ndjson` shows
the source:id still firing a week after the fix commit, the fix was wrong
for the real distribution — `git revert` the recorded sha (only shas this
loop recorded; never reset/clean), reopen the task, and record why.
