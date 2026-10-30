# PRODUCT.md

## What this is

`pi sessions` — a local, single-user observability dashboard for pi coding-agent
sessions. It indexes session logs (via the pidx indexer), derives cost/token/tool/
subagent/permission-gate metrics, and streams live turn activity over SSE.

- **Repo:** `<project-root>` (`scripts/dashboard.mjs` server, `dashboard/` UI).
- **Run:** `npm run dashboard` (default port 8787; `PI_DASH_PORT`,
  `PI_DASH_SESSIONS_DIR`, `PI_DASH_SESSION_BUDGET`).

## Users

The operator of the agent: a developer watching their own machine. Technical,
keyboard-comfortable, often leaves the Live tab open on a second monitor and
glances at spend several times a day. Single-tenant; no login; no sharing.

## Jobs to be done

1. Trust spend at a glance: today / 7d / projected, per-day trend, per-project
   and per-model split, per-tool attribution.
2. Catch runaway sessions: budget alerts (near/over), failure streaks, loops.
3. Inspect one session: cumulative cost, tokens per turn, timeline, tool calls,
   prompts, subagents.
4. Watch subagent health: spawns, messages, errors, latency — per agent type
   (names come from raw spawn arguments) and per session.
5. Understand permission-gate behavior: blocks by family and tool, rule
   severities, and an avoided-spend estimate for blocked calls.
6. Tail live activity: which session files are writing now, what just happened.

## Non-goals

Editing sessions, remote/multi-user access, auth, history older than the local
session tree, mobile-first flows (mobile must stay readable, not optimized).

## Constraints

- Server stays zero-dependency Node (`dashboard/scripts/dashboard.mjs` + `data.mjs`).
- UI: React 19 + Vite + Tailwind 4 + shadcn/ui, bundled and served by the same
  server; no runtime cloud calls.
- Data freshness is near-real-time via SSE re-broadcast; nothing pushes to disk
  from the UI.

## Platform

Web. Operate mode. Desktop-first (1280–1920px primary), light and dark themes,
reduced-motion respected.

---

_Assumptions (inferred from the explicit brief and code, not interviewed):_
_single-tenant local tool; operator is the repo owner; spend accuracy follows
the indexer's extract granularity; budgets are per-session USD alerts only._
