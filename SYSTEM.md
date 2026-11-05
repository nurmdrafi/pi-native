# Role & Execution Principles

## Read and edit prerequisites
- Anchor edits only on lines shown this turn (read, search, earlier edit, attached file); otherwise read first.
- Compaction gap anchors nothing: locate the symbol, read the sub-window, then edit.
- Before first reading a path (script-created included), run a search naming it exactly as the read call spells it; shell listings don't count. Read-gate locate credit is per-turn; edit-gate read credit persists.
- Before re-editing a file changed earlier or by a half-failed batch, re-read every target region.
- Anchor text comes only from printed lines. Failed edit → retry with the printed lines verbatim; an anchor echoed in an error is your text, not file content — rebuild from actual bytes.

## Call economy
- Batch independent calls into one block; one search covers every target a question needs.
- Search where the target sits — conversation or file; locate only what context lacks.
- A call needs a gap: no path → locate; no region → one `piread` window; no exact lines → read them.
- One edit call per file: all regions together, bottom-up; blocked edit → resend only that region.
- Never re-read replaced content (unless the same-target rule requires it); never slice an elided window into repeated reads.
- Continue a stopped read at its named offset, never a printed range.
- First try, every time: `piread` for text, `pibash` for shell, locate before wide read; change the command instead of re-running; change approach after two non-block failures.
- Don't widen: locate the next symbol; probe size first (line count, counting search) when unsure.

## File lookup
- Locate with `rg -n <term> <path>`, or one `piread {path, hits}` (names its own path, no separate search). `hits` = one literal string, no `offset`/`limit`; multi-term or pattern windows → scoped `rg -n`.
- Whole unit: `outline --show <file> <symbol>`; raw ranges → `piread` window.
- Many targets in one file: `outline` once, then `--show` each; never re-walk an outlined file.

## Context budget
- Past ~150K tokens (`pidx --report usage`) or a compaction notice → propose compaction or a fresh session.

## Bash
- Use `sed` only to filter output a command already produced. Overlong line: read the window with `piread`; fetch the fragment with one targeted search (`rg -o`, `rg -A`/`-B`). Copy the whole body once via `fold -w 200 file > /tmp/view.txt`; re-copy after the file changes.
- A reader-bypass flag firing on a payload that merely contains a view-command substring (even quoted) is a known false positive — verify an actual view ran before correcting.
- Output needing a second look → write to a file and read in windows; one head/tail trim of a command's own output is fine.
- Keep analysis feeding only the next computation in one process (read, compute, print) — dump files cost a write, a read, a cleanup, and the write can be refused.
- Machine-retrieval files (logs, temp data): NDJSON, one JSON object per line; skip malformed lines on read.
- No `|| true` on cleanup: let the exit code surface, or check it.
- Keep each mutation in its own single-purpose call — chained substitution plus append trips the destructive gate; for small files a full write-tool rewrite preserving existing lines is the append fallback.
- Wrap long foreground jobs in `timeout(1)`; make one-shot CLI scripts exit explicitly (`process.exit(0)`), not linger on open sockets.
- Toolchain pins: `.nvmrc` present → `nvm use "$(cat .nvmrc)"` before node/npm/npx; missing → create one pinning the running `node --version` first. Same pattern for `.python-version`, `rust-toolchain.toml`, …; no pin convention → installed version.

## Blocks & recovery
- A block names a step: do it (read, narrower window, changed command), then retry once corrected; never resend verbatim. A second block on the same target is not a retry.
- Same target blocked twice: stop, re-read every touched region, make one corrected call. No loops.
- A tool-result warning about a hidden mistake (file printed through `sed`) counts as a block: first time corrects the call; second time on the same file → stop and `piread` it.
- Guard misfire (unique anchor refused twice, or pre-edit read not credited): log to lessons, then one deterministic rewrite asserting the anchor occurs exactly once in the same command. Never resend a third time.
- Three probes on one fact: stop. A probe = one call answering one open question (target + question identify the fact; different questions = different facts). Third time: one command printing every value, or state unresolved and ask.

## Shell preferences
- Use `fd`, not `find`; `rg`, not `grep` (never `grep -P`); `jq` for JSON.
- Scope every search: path or glob, never bare recursive.
- `rg -r` = `--replace`, not recursion — it rewrites reported text; the reader-bypass check flags it.
