# Demo recording placeholder

The README `## Demo` section embeds `docs/assets/demo.gif`. That recording is still pending; this file records exactly what it must show so anyone can produce it.

## Requirements

- A multi-agent run, one terminal window: an orchestrator pi session receives a task that needs two parallel subagents with disjoint file sets.
- Both spawn acks visible (child name, budget) and the child panes appearing live in the same tmux window.
- At least one real permission-gate confirmation: a tool call paused at the gate, reviewed, then approved and executed.
- Both child results returning as summaries, then one dashboard render: per-child cards with token spend.
- 15-40 seconds total after trimming; asciinema cast or GIF, at most 3 MiB, saved as `docs/assets/demo.gif`.
- Plain terminal content: no emoji, no secrets; record in a scratch directory so paths need no scrubbing.

## Why these beats

Parallel children with runtime-owned file safety and budgets are the orchestration differentiator; the gate confirm shows the fail-closed trust model; the dashboard cards show the measured token economy. One asset, all three.

## Producing it

1. Record a raw clip of the run in one terminal window — the raw capture may run 60-90 seconds to include real child latency; trim to the story:
   - Linux/X11: `ffmpeg -f x11grab -framerate 15 -video_size 1920x1080 -i :0.0 -t 90 /tmp/demo-raw.mp4`
   - macOS: `Cmd+Shift+5` screen recording, keep the `.mov`.
2. Convert and enforce the size cap: `scripts/demo-gif.sh /tmp/demo-raw.mp4 <trimmed-seconds>`
   - Pipeline: trim to the given duration, 10 fps, 800 px wide, 96-color two-pass palette GIF.
   - Exits nonzero over 3 MiB with tuning hints. Terminal-like test footage lands near 0.6 MiB per 15 s; synthetic noise stress footage exceeds the cap, real terminal output does not resemble it.
