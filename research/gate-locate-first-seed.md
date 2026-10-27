# R1c Locate-first: the seed predicate ignores what searches actually name

Research doc — 2026-10-27. Scope: diagnose and solve ONE verified false positive — the
Locate-first guard (R1c, `locateFirst` rule) blocking a `piread` on a path that prior `rg`
output in the same session named repeatedly. No code changed.

## 1. The incident (verified session evidence)

Session: `sessions/--Users-nur-Barikoi-dropx-merchant--/2026-10-26T12-26-36-935Z_01a1782d-4c07-7786-a229-257cb772f87a.jsonl`
(one JSON message per line; `.type == "message"` carries both assistant content and toolResults;
toolResults are `.message.role == "toolResult"` with `.message.toolName` and `.message.content[0].text`).

- Lines 10–45: nine `toolResult` lines (`toolName: "pibash"`) whose text contains the relative
  path `__tests__/redux/features/order/orderApi.test.ts:` in rg's `path:line:content` output
  format (the task brief's seven rg outputs, plus two more that repeat it). The producing
  commands, from assistant `toolCall` blocks in the same range, were directory-scoped searches:
  - `cd /Users/nur/Barikoi/dropx-merchant && rg -n --no-heading '\bany\b' __tests__ --stats -g '!node_modules' | tail -5`
  - `cd /Users/nur/Barikoi/dropx-merchant && rg -c --no-heading '\bany\b' __tests__ -g '*.ts*' | sort -t: -k2 -rn`
  - …and four more variants scoping `__tests__` (never the file itself as an operand).
- Line 87: one assistant message with four `piread` toolCalls. The first:
  `{path: "/Users/nur/Barikoi/dropx-merchant/__tests__/redux/features/order/orderApi.test.ts", offset: 85, limit: 140}`.
  The other three (40/45/80-line windows on sibling test files) passed — under the 100-line
  threshold, so only the seeding of the 140-line read is in question.
- Line 88: result blocked — `Locate-first: 140-line window on '…merchant/__tests__/redux/features/order/orderApi.test.ts', which no search has named this session. rg -n <term> orderApi.test.ts, then read the hit's range.`
- Path-form fact: zero lines before 87 contain the absolute form of the path; every mention is
  the relative `__tests__/…` form inside toolResult text.
- Cascade (lines 88–212): the block forced narrower windows; one subsequent piread result was
  head-tail compacted with a 45-line gap (`[… omitted 1304 chars / 45 lines …]`); line 211's
  `piedit` (5 edits, `edits[2]` = the `catch (error: any)` hunk at line 164) landed in that gap
  and line 212 blocked it: `Anchor Guard (Unread): … edits[2] targets lines 164–164, not in
  certified context`. One false positive cascaded into a second block.

## 2. The mechanism today (source-confirmed)

The guard is extension code, not native:

- `extensions/permission-gate/search-guard.ts:170-210` — `searchedPathsFrom(segments, cwd,
  resolvePath, exists)`: for each command **segment** containing a token in
  {rg, grep, egrep, fgrep, fd, find, ag, ack}, every remaining token that (a) does not start
  with `-`, (b) contains no `=`, (c) contains none of `| > < ; $ \``, and (d) **exists on disk**
  after `resolvePath(tok, cwd)` is pushed; glob tokens expand to matched directory entries
  (added after the 2026-10-18 glob incident, per the header comment in
  `tests/search-guard-locate.test.mjs:5-15`). Command **output is never parsed**.
- `extensions/permission-gate/index.ts:151-156` — `searchedPaths: Set<string>` of absolute
  paths; `recordSearchedPaths(segs, cwd)` inserts from the function above.
- `extensions/permission-gate/index.ts:888` — populated on every pibash toolCall:
  `if (ruleEnabled("locateFirst")) recordSearchedPaths(normSegs, ctx?.cwd);`
- `extensions/permission-gate/index.ts:556-567` — the block:
  `win ≥ LOCATE_MIN_WIN (100, index.ts:112) && !searchedPaths.has(path) && !coverage.has(path)`.
  **Exact string membership** on normalized absolute paths — a seeded directory does not credit
  files under it.

Incident replay: rg's operand was the directory `__tests__`. At most the directory string
entered the set (whether even that happened depends on `ctx?.cwd` resolving the relative
operand — the `cd` target lives inside the command string, in a separate segment the
rg-token gate skips). The file rg's output named nine times never entered the set, because
the predicate reads command **argv**, not search **hits**. Exact-match `has()` then failed.
The block message — "which no search has named this session" — describes a promise
(hit-based) the predicate (operand-based) does not keep.

Note the divergence from SYSTEM.md: "Only `rg` seeds a path (`fd`/`ls`/`cat` don't)"
(SYSTEM.md:8) — the implementation actually credits grep/egrep/fgrep/fd/find/ag/ack too
(search-guard.ts:177), i.e. wider than the rule, yet still blind to hits.

## 3. Hypotheses: what the predicate keys on, vs. what the evidence says

| # | Hypothesis | Verdict |
|---|---|---|
| H1 | Exact-string path match; relative-vs-absolute mismatch between rg output and piread | **Refuted as root cause.** The gate normalizes argv tokens to absolute (`normPath`), and never reads output text at all — the rel/abs difference in toolResult text is never even reached. |
| H2 | Seed = command argv operands only; toolResult text ignored | **Confirmed** (search-guard.ts:170-210; no toolResult parse anywhere in the seed path). |
| H3 | Directory operand seeds only the directory string; membership is exact, so contained files get no credit | **Confirmed** (index.ts:562 `has(path)`; the block occurred despite `__tests__` being the operand). |
| H4 | Only a hypothetical native rg tool seeds; pibash rg does not | **Refuted** — there is no native rg; pibash commands are parsed (index.ts:888). |
| H5 | Basename matching somewhere | **Refuted** — no basename logic exists; and the block fired while the basename appeared in output nine times. |

## 4. Prior art: how production agents treat search-then-read

Production coding agents use "which files were searched/read" as **bookkeeping that lowers
cost and drives freshness/compaction** — none of the surveyed systems makes it a hard
precondition for a read:

- **Aider** builds a PageRank-ranked, tree-sitter-derived repo map (files + key symbols)
  sent with every request; the LLM uses the map to decide which files to open, and aider
  "offers to add them to the chat context" — the map justifies reads, it never blocks them.
  https://aider.chat/docs/repomap.html
- **OpenDev / terminal coding agents** (arXiv:2603.05344): old file reads are compacted to
  metadata ("✓ Read file (142 lines, 4,831 chars)") and "search results report match counts
  rather than matched lines"; full content stays available **through re-reading** — cost is
  managed by compaction, not by refusing justified-looking reads.
  https://arxiv.org/abs/2603.05344
- **SWE-agent** collapses stale reads (`ClosedWindowHistoryProcessor`): only the latest view
  of a file keeps full fidelity; re-reads are allowed and replace older copies.
  https://www.matthewaberham.com/writing/how-production-agent-systems-manage-context/
- **Claude Code** tracks referenced-file state (files show as "Referenced") and re-reads are
  permitted — the reported bug is *too many* re-reads, not reads being refused for lacking a
  search justification. https://github.com/anthropics/claude-code/issues/11487 ;
  https://code.claude.com/docs/en/memory

Lesson for this gate: pi's hard-block stance is the outlier. If it is kept, the seed
predicate must at least honor its own message ("a search has **named**") — which means
crediting what searches print, not just what they take as arguments. This also matches the
audit's own direction: `research/permission-gate-audit.md:17` flags R1b/R1c's predicate
source as undisclosed, and F5 (audit.md:310-315) proposes a session-scoped path set — but
F5 as written ("populated on the command, not on parse output") would **not** have prevented
this incident: the file was never a command operand. F1's seed-based allow (audit.md:266-278)
inherits the same blind spot.

## 5. Candidate fixes

| Candidate | False positives (blind-read blocks on genuinely searched paths) | False negatives (unjustified reads slipping through) | Cost | R1/AG interaction |
|---|---|---|---|---|
| **C1** Parse `path:line:` prefixes from the toolResult text of rg-family pibash calls; resolve against the call's cwd; seed `searchedPaths` | Eliminates this incident class: every file rg prints becomes readable | Low if parsing is restricted to results whose originating command was rg/grep/fd — a plain `echo path` result is not parsed | One bounded regex pass per search toolResult (cap at first ~4 KB) | Neutral-to-positive: reads allowed once, then `coverage` (R1) governs repeats |
| **C2** Expand directory operands recursively into the seed set | Zero for directory-scoped searches | **Guts the guard**: `rg term .` or `rg term __tests__` (the norm) would seed the whole tree — every file then readable blind | One readdir walk per directory operand (can be huge) | Neutral |
| **C3** Containment match: allow reads under any seeded directory | Zero for directory-scoped searches | Same gutting as C2 via one cheap string prefix test instead of a walk | Near zero | Neutral |
| **C4** Hit-anchored seeding (C1 plus recorded hit lines): seed `Map<path, Set<hits>>`; allow a ≥100-line window iff it overlaps a recorded hit line of that path (path-only results, e.g. `rg -l`, seed the path without lines → any window) | Lowest: a compliant "read the hit's range" flow is allowed **by construction** — exactly what SYSTEM.md asks | Strongest: a named path read at an unrelated offset still blocks; never-named paths still block; text echoes don't parse | Same bounded pass as C1 + a Map insert | Positive: reads naturally cover anchor lines, reducing AG-Unread cascades like line 212 |

C2/C3 fail the guard's purpose (any scoped search unlocks the tree). C1 fixes the incident
but still allows a 140-line read anywhere in a named file. C4 is the only candidate whose
allow-condition is literally the rule text — "read the hit's range".

## 6. Recommendation (details)

**Adopt C4.** Concrete changes:

1. **Where it lives**: the extension (`extensions/permission-gate/`), not native piread —
   the seed set, `coverage`, and the R1c check already live there; piread has no session
   history. Add a `toolResult` handler mirroring index.ts:888's toolCall hook.
2. **Predicate logic**:
   - On a pibash **toolCall** that matches the rg-family test (search-guard.ts:177), record
     `{toolCallId → cwd}` where cwd = `ctx?.cwd` overridden by any `cd <dir> &&` prefix
     resolved from the command string itself (the incident's commands all carried one).
   - On the matching **toolResult**, scan its text (first 4 KB) for
     `^([^\s:]+\.?[A-Za-z0-9_-]*):(\d+)(?::\d+)?:` (rg/grep hit lines) and bare
     `^\S+$`-path lines for `rg -l`/`fd` output. For each hit: `normPath(path, cwd)` →
     insert into `searchHits: Map<string, Set<number>>`; path-only matches insert with an
     empty set (any window).
   - R1c check becomes: block iff window ≥ 100 AND path ∉ `coverage` AND
     path ∉ `searchHits` AND NOT (window overlaps a hit line of path). Keep existing
     argv/glob seeding (`searchedPathsFrom`) as an additional seed source for
     explicitly-named file operands.
   - Normalization: both sides absolute via `normPath` — removes the relative-output vs
     absolute-read mismatch class entirely.
3. **SYSTEM.md rule-text edit** (SYSTEM.md:8), replacing the parenthetical:
   "A search seeds the paths its output names (`rg`/`fd` hits, `path:line:` form); a ≥100-line
   window on a seeded path is allowed when it covers a hit line; a path no search has named
   stays blocked." Also reconcile the tool list — the implementation already credits more
   than rg, and the rule should say which.
4. **Validation plan** — extend `tests/search-guard-locate.test.mjs` (it already pins the
   2026-10-18 glob fix; same file, same style, `node --test`):
   - rg output naming `__tests__/…/orderApi.test.ts:158:` → 140-line window covering line
     158 **allowed** (the exact incident, replayed from the session log fixture).
   - Same file, window covering lines 400–540 (no hit) → **blocked** (C4's tightness).
   - Never-named path → blocked (guard's purpose intact).
   - Basename-only mention in output (`orderApi.test.ts:158:` with no directory) → not
     seeded unless it resolves under cwd (no accidental seeds).
   - Relative rg output + absolute piread path → allowed (normalization).
   - `rg -l` result (path, no line) → any window on that path allowed.
   - `echo <path>` toolResult from a non-search command → not seeded (FN guard).
   - `rg term __tests__` (directory operand) → only files the result named are seeded,
     never siblings (C2/C3 rejected).
   - Regression: the four-piread batch from session line 87 — first call allowed, siblings
     unchanged (under-threshold pass-through).

Bottom line: the guard blocked a read that followed its own documented workflow nine-times-
named; the fix is to make the seed predicate credit what a search's output names, anchored
to hit lines so the allow-path and the rule text finally say the same thing.

## Sources (web)

1. Aider — Repository map (first-party docs): https://aider.chat/docs/repomap.html
2. Building Effective AI Coding Agents for the Terminal (OpenDev paper): https://arxiv.org/abs/2603.05344
3. How Production Agent Systems Manage Context (SWE-agent stale-read collapsing): https://www.matthewaberham.com/writing/how-production-agent-systems-manage-context/
4. Claude Code issue #11487 (repeated reads of "Referenced" files): https://github.com/anthropics/claude-code/issues/11487
5. Claude Code memory/context docs: https://code.claude.com/docs/en/memory
