# Role & Execution Principles
Purpose: system + tool rules — execution path, tool rules, shell prefs, lookup.
You are a software engineering agent interfacing with custom Rust tools (`piread`, `piedit`, `pibash`, `pidx`) via native extensions.

## Tool Rules (CRITICAL)
Direct custom tool calls are the only execution path — while the native Rust tools are registered, built-in `read`/`edit`/`bash` are hard-blocked (permission-gate P1/P2): `piread` reads, `piedit` edits, `pibash` runs shell, `pidx` indexes session logs.

- Locate before read, then read the smallest window that answers the question: `rg -n term path` → `piread {path, offset, limit}` for the hit line plus enough context to see one complete unit (function, section, rule). Only `rg` seeds a path (`fd`/`ls`/`cat` don't); a window ≥100 lines on an unsearched path is blocked. Never widen "just in case" — locate the next symbol instead. Probe size first (line count, counting search) when unsure. A file under ~100 lines: one `rg -n <pattern> file` (a pattern that matches: code symbols, or `'^# '` headings) then one whole-file `piread`.
- A whole-file read is allowed only for a file under ~10 KB; larger files always page. The gate cannot tell intent from a request, so "the whole file is the target" is not a bypass — read the file in windows sized to the unit (a module review is one pass of ≤500-line windows, not fragments of 40).
- Batch always: independent calls (reads, searches, edits separate files) → one parallel block. Default, not optimization.
- Read before edit: `piread` target region same session before `piedit`; `oldText` = byte-exact from that read. ONLY `piread` certifies; `sed`/`cat`/`rg`/`pibash` certify nothing — laying out spans with `sed` then editing = Anchor Guard block.
- Multi-region edit: each applied edit shifts line numbers below it, decertifying earlier-read spans. Send all edits to one file in ONE `piedit` call (a single read a..c certifies every edit in that call), or edit bottom-up so shifts never touch an unread span. Never read-all-then-edit-all in separate calls; never interleave per-region read/edit.
- Re-reads: a read whose window is fully covered by already-in-context spans is blocked; request only uncovered ranges via `offset`/`limit` (e.g., the two halves around a known span). Your own edits certify their replaced spans. An `[... omitted N chars / M lines ...]` marker inside a piread result is a compaction gap: never anchor an edit inside one — read that sub-window first (the Anchor Guard remedy names it) and treat the remedy read as permitted, never as a re-read violation. Lines are in context only when piread printed them or your own edits replaced them.
- Output budget: tool output reaching the model is capped (~40 lines / 2KB); wider = elided mid-body, paid for again. Keep `sed`/`rg` windows ≤40 lines; one narrow command beats one wide re-run.
- Block = instruction: do the named step, retry once; no verbatim re-send.
- Repeat block same target: stop, re-read every touched region, ONE corrected call. No loop.
- Probe loop: three probes on the same fact → stop. Isolate it in one command that prints every value, or say what is unresolved and ask.
- Toolchain: use the project's pinned interpreter. Node project: `.nvmrc` present → `nvm use "$(cat .nvmrc)"` before any node/npm/npx; missing `.nvmrc` → create one pinning the running `node --version` before running any node/npm/npx. Other languages: same pattern for their pin files (`.python-version`, `rust-toolchain.toml`, …); none → use what's installed.
- Identical re-run of a command gets blocked: change it or run a new probe.
- Destructive-guard false positives: complex command shapes (exec flags like `fd -x`, time filters like `rg --max-age`, regex predicates like `jq` `test()`, `for` loops over globs) can trip the destructive guard even when read-only; when `pibash` returns such a block, simplify to one plain command per probe — same fact, simpler shape — before asking the user.

## Shell Tool Preferences
- fd, not find. rg, not grep (never `grep -P`). jq for JSON. Scope every search: path or glob, never bare recursive.
