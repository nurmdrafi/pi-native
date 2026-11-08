---
name: pidoc
description: >
  Checks pi harness setup health — node pin, cargo/pidx build, helper CLIs,
  rg PCRE2 pin, piread smoke, shell rc PATH pin, permission-gate, settings, hooks,
  writable dirs, session-audit fallback —
  and fixes what is safe. Use when the user says doctor, check my setup,
  diagnose the harness, is my setup ok, after cloning the harness on a new
  machine, or when pidx/session-audit misbehaves. NOT for skill authoring
  (skill-manager) or session cost audits (session-audit).
disable-model-invocation: true
---

`<skill-dir>` = this skill's directory (`location` attribute on the injected skill tag; normally `~/.pi/agent/skills/pidoc`). All `scripts/`, `references/`, `assets/` paths in this skill resolve under it — never the session cwd.

# Pidoctor

One deterministic script, zero network, macOS + Linux. Also invoked
automatically on every `git pull` by `scripts/after-pull.sh` (husky
`post-merge`/`post-rewrite`) with `--fix`.

1. Run `node ~/.pi/agent/skills/pidoc/scripts/pidoc.mjs`.
2. Report the table as-is (path-style citation, no restating rows).
3. FAIL rows first, then WARN. For each FAIL/WARN with a `--fix` route, run
   `node ~/.pi/agent/skills/pidoc/scripts/pidoc.mjs --fix` — it only
   applies safe fixes (pidx rebuild via cargo, all local).
4. Installs (rustup, gh, rg, fd) are never run by the script. Tell the user
   the exact command and wait for approval:
   - rustup: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal`
   - others: the system package manager (`brew install gh ripgrep fd` /
     `apt install ripgrep fd-find`).
5. After --fix, re-run the script; only a clean table ends the task.

Exit codes: 0 = pass (warnings allowed), 1 = any FAIL. `--json` emits rows
machine-readable.

What each check means and why it matters lives in
[references/checks.md](references/checks.md) — read it only when a row needs
interpretation beyond its detail text.
