# Portability
- No absolute user/machine paths anywhere (code, tests, fixtures, docs, generated files). Derive paths at runtime (`import.meta.url`, `$HOME`/`env.HOME`, argv, `command -v`); tracked files byte-identical on all machines; roots via argv/env, never baked.
- Target: macOS+Linux — portable BSD/GNU subset only; where they differ, branch explicitly.
- Written output: `~`/`$HOME` or script-relative, never absolute user paths.
- No single-quoted `python3 -c` with embedded quotes — use `rg` or a heredoc.
- No hardcoded `/bin/sh`: probe (`process.platform !== 'win32' && existsSync('/bin/sh')`), fall back to `PATH` resolution (see `skills/pidoc/scripts/pidoc.mjs`). Windows unsupported, but the health check and Node scripts degrade, never crash.
- `scripts/bootstrap.sh` and `scripts/after-pull.sh`: POSIX `sh`. `pidx`: OS-agnostic Rust (std + mtime, no watchers); store is explicit little-endian — macOS and Linux share one path/format.
- Directory walks sort per directory: Node `readdirSync` sorts (libuv qsort); Rust `read_dir` and shell globs return raw OS order — unsorted ports silently diverge between implementations.
