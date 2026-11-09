---
name: tmux-panes
description: "Runs user-facing temporary tmux task panes in subagent-enabled sessions: session bootstrap, POSIX countdown self-close, handover quoting. Use only after `/subagents on`, when creating or handing over a task pane, writing its command string, or when a pane handover is refused by the destructive gate. NOT for harness-spawned panes or general tmux management."
disable-model-invocation: true
---

# Tmux temporary panes

User-facing task panes for subagent-enabled sessions only; harness-spawned panes are exempt.

## Bootstrap

Before the first handover, ensure the session exists:

```bash
tmux has-session -t tasks 2>/dev/null || tmux new-session -d -s tasks
```

A missing tmux server prints only an exit code (stderr is silenced); `new-session -d` boots detached. Identical on macOS and Linux. Never reference socket paths.

## Pane command

- Never put `tmux kill-pane` in the process string — it races ("can't find pane").
- Chain commands with `;`, not `&&`, so the countdown runs either way.
- End with a visible countdown; the pane closes itself (`remain-on-exit` off = default; a config turning it on keeps dead panes).

## Countdown

POSIX only — `printf`, `while`, `$((…))`; brace ranges and `echo -ne` break `/bin/sh`:

```sh
i=5; while [ "$i" -ge 1 ]; do printf 'Closing pane in %s seconds...\r' "$i"; sleep 1; i=$((i-1)); done
```

## Handover

- Hand over two forms: double-quoted (direct execution), single-quoted escaped (aliases/scripts).
- Children never run the countdown — the gate refuses shell loops; the parent hands over the string or spawns the pane.
- Shell loops embedded in a tmux split-window string trip the destructive gate (known false positive) — when refused, spawn the pane, then hand over the string.
