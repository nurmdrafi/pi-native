# Tool Calling

This file defines tool invocation mechanics; `AGENTS.md` defines agent behavior. Registered tools and extensions are authoritative for controls they enforce; do not restate those controls here. Hold only how to call tools; put behavior rules (safety, communication, workflow, verification, lessons) in `AGENTS.md`. One rule, one home.

## Call economy
- Batch independent calls into one block; one search covers every target a question needs.
- Search where the target sits — conversation or file; locate only what context lacks.
- A call needs a gap: no path → locate; no region → one `piread` window; no exact lines → read them.
- One edit call per file: all regions together, bottom-up; blocked edit → resend only that region.
- Continue a stopped read at its named offset, never a printed range.
- Don't widen: locate the next symbol; probe size first (line count, counting search) when unsure.

## File lookup
- Resolve unknown paths before reading them; do not guess filenames.
- Use semantic search or LSP for symbols, `piread` hit mode for one literal, and `outline --show <file> <symbol>` for whole units.
- Use `piread` for raw ranges and continue a stopped read from its named offset.
- Many targets in one file: `outline` once, then `--show` each; never re-walk an outlined file.

## Bash
- For long lines, use a targeted window or search. For output needing a second look, save it and inspect bounded windows.
- Respect repository-declared toolchain versions.
- Each shell call is a fresh process at the session cwd: use absolute paths, never a path relative to an earlier `cd`.
- `nvm` is absent from non-interactive shells: `source "$HOME/.nvm/nvm.sh"` in the same call as the node/npm work — an export in one call never reaches the next.
- `pnpm` in a worktree whose `node_modules` symlinks the main checkout trips verify-deps-before-run and stalls: run from the main checkout or disable that hook.

## Recovery
- Follow a tool block's corrective instruction; do not resend an unchanged call.
- After two non-block failures, change approach. After three probes of one fact, combine remaining checks or report it unresolved.

## Delegated calls
- Read `~/.pi/agent/docs/subagent-orchestration.md` before the first spawn. Avoid invoking missing CLIs through `npx`, which may fetch packages.

## Lesson-log calls
- Before planning from lesson records, inspect the log tail; compose new records with `jq -c -n`. Check the final byte before appending with `>>`; add a newline first if the file is non-empty and lacks one.

## Commit calls
- Write the commit message to a file and validate every line with:
  `awk 'length>100 || index($0,"#") {print "line " FNR ": " length " chars or contains #"; exit 1}' <msgfile>`
- Run `git add` and `git commit -F <msgfile>` in one shell call.

## Portability
- Apply `~/.pi/agent/docs/portability.md` before shell or path work.
