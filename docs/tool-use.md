# Tool-use conventions

These conventions apply in every project and session, not only the pi-native repository; `~/.pi/agent/AGENTS.md` holds the behavior rules that point here.

This file defines tool invocation mechanics; `AGENTS.md` defines agent behavior. Registered tools and extensions are authoritative for controls they enforce; do not restate those controls here. Hold only how to call tools; put behavior rules (safety, communication, workflow, verification, lessons) in `AGENTS.md`. One rule, one home.

## Call economy
- Batch independent calls into one block; one search covers every target a question needs.
- Search where the target sits — the conversation first, files only for what context lacks; locate the file before probing its contents.
- A call needs a gap: no path → locate; no region → one `piread` window; no exact lines → read them.
- One edit call per file: all regions together, bottom-up; blocked edit → resend only that region.
- Continue a stopped read at its named offset, never a printed range.
- Don't widen: locate the next symbol; probe size first (line count, counting search) when unsure.
- A span already read this session stays cited, not re-read — a re-send re-pays its tokens.

## File lookup
- Resolve unknown paths before reading them; do not guess filenames.
- Edit anchors come from this session's reads, never memory — an unread `oldText` is a guess; if anything may have written the file since the read (a command you ran, another session, a build), re-read the region first — the anchor must match the file as it is now. An anchor miss means the file moved past the read: re-read the region and rebuild the anchor — resending the same `oldText` re-pays the failure.
- Default searchers: `rg PATTERN path/` for text, `fd PATTERN path/` for files — both skip gitignored noise and print matching paths; `grep`/`find` only after rg/fd actually errored, and a path argument starting with `-` needs a `./` prefix or the tool reads it as a flag. Never search `node_modules/`, `vendor/`, or `dist/` trees — they are vendored copies measured in hundreds of megabytes; find the source path and search it.
- `rg -r` is `--replace` (rewrites matched text in the output), not recursion: rg recurses by default, so never reach for `-r` to mean "search everywhere" — the run succeeds silently with rewritten results.
- File views go through `piread` windows (offset/limit, hits) — a window keeps line numbers addressable and later calls can continue from them; `cat`/`head`/`tail`/`sed -n` only trim command output, never open files: they dump bytes without offsets and force a full re-read to see more.
- Open files in windows of tens-to-hundreds of lines; a whole-file read only after confirming the file is small (a line count, not a guess) — a large dump crowds out context and hides the part you needed.
- Use semantic search or LSP for symbols, `piread` hit mode for one literal, and `outline --show <file> <symbol>` for whole units.
- Use `piread` for raw ranges and continue a stopped read from its named offset.
- Many targets in one file: `outline` once, then `--show` each; never re-walk an outlined file.

## Bash
- Never re-send an identical command with no intervening edit or write — its output is already in context.
- For long lines, use a targeted window or search. For output needing a second look, save it and inspect bounded windows.
- Respect repository-declared toolchain versions.
- Each shell call is a fresh process at the session cwd: use absolute paths, never a path relative to an earlier `cd`.
- `nvm` is absent from non-interactive shells: `source "$HOME/.nvm/nvm.sh"` in the same call as the node/npm work — an export in one call never reaches the next.
- Before any `>>` append, probe the target's final byte with `tail -c 1 <file>` and prepend a newline when missing — a missing final newline glues the append onto the last line. The bare probe is the sanctioned read shape, never a bypass.
- `/tmp` and `$TMPDIR` are scratch: writes, redirects, and scratch copies there need no confinement detour — but executing a file written there still confirms, because scratch placement never upgrades a script to trusted.
- `pnpm` in a worktree whose `node_modules` symlinks the main checkout trips verify-deps-before-run and stalls: run from the main checkout or disable that hook.

## Recovery
- Follow a tool block's corrective instruction; do not resend an unchanged call.
- After two non-block failures, change approach. After three probes of one fact, combine remaining checks or report it unresolved.

## Delegated calls
- Read `~/.pi/agent/docs/subagent-orchestration.md` before the first spawn. Avoid invoking missing CLIs through `npx`, which may fetch packages.

## Lesson-log calls
- Before planning from lesson records, inspect the log tail; compose new records with `jq -c -n`. Appends follow the `>>` final-byte probe rule in Bash.

## Commit calls
- Gate-checked route (default): inline `git commit -m` is acceptable because the commit-message gate is a hard floor — it enforces the shape (no `#` anywhere, <=100 chars per line). On rejection, rewrite the message only; never resend it unchanged, never commit past the gate. A rejected compound command (add + commit in one call) never ran — the index is untouched, so re-stage together with the rewritten message.
- Message-file route (no gate active): write the message to a file and validate every line with:
  `awk 'length>100 || index($0,"#") {print "line " FNR ": " length " chars or contains #"; exit 1}' <msgfile>`
  then run `git add` and `git commit -F <msgfile>` in one shell call.

## Portability
- Apply `~/.pi/agent/docs/portability.md` before shell or path work.
