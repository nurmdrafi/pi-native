---
name: linkedin
description: "Write LinkedIn content in the user's voice — posts from 21 hook formulas, comments, replies, DMs, carousels, weekly engagement plans, profile scoring/rewrites, content repurposing, and a mandatory humanizer pass (slop lexicon + five-check detection scoring). Use when the user asks for LinkedIn posts, comments, replies, DMs, carousels, profile help, or a posting plan. NOT for posting anything (the user always posts), NOT for other platforms."
license: MIT (github.com/Jakeschincariol/linkedin-agent-skill)
disable-model-invocation: true
---

Run a LinkedIn account's writing side: draft, comment, reply, plan, score — the user posts. Nothing gets published by this skill, ever.

Scope steering: `/skill:linkedin post` / `human` / `plan` … — read only the matching reference.

## Universal rules (every task)

1. Voice first: read `~/.pi/agent/linkedin/voice.md` if it exists (user's voice profile). Missing → offer to create it from `references/voice.md` template before writing anything.
2. Humanizer last, always: every draft shown to the user passes `references/human.md` — run the detectors, do not eyeball. No exceptions for "short" pieces.
3. Log: after delivering a post/comment, append date + hook formula used to `~/.pi/agent/linkedin/log.md` if it exists (create on first use).
4. Nothing auto-posts. Drafts + options only; the user publishes.

## Task routing

| Task | Reference | Core mechanic |
| ---- | --------- | ------------- |
| Write a post | `references/post.md` | hook formulas in `assets/hooks.json`, line-1 survival |
| Comment on someone's post | `references/comment.md` | paste target text; no restating, no filler praise |
| Reply under own post | `references/reply.md` | |
| DMs | `references/dm.md` | |
| Carousel | `references/carousel.md` | |
| Weekly plan | `references/plan.md` | reads voice + log; writes `~/.pi/agent/linkedin/plan.md` |
| Profile score + rewrite | `references/profile.md` | 100-point rubric in `assets/rubric.json` |
| Account audit | `references/audit.md` | reads log history |
| Inbox triage | `references/inbox.md` | |
| Repurpose existing content | `references/repurpose.md` | assigns hook formulas per piece |
| De-slop / detect AI text | `references/human.md` | `scripts/detect.py`, `scripts/humanize.py` |

Source: Jakeschincariol/linkedin-agent-skill (MIT), adapted to this layout — upstream sub-skills li-* became references; full clone at `git/linkedin-agent-skill`.
