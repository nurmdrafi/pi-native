---
description: Draft a non-technical ticket from a commit range — product-manager voice, user-visible outcome, saved as markdown
argument-hint: "[<repo-path>] [<commit-range>]"
---

Arguments: $ARGUMENTS — optional repo path (default: session repo) and commit range (default: last commit).

## 1. Gather
- Repo facts: `git -C <repo> log --oneline <range>` · `git -C <repo> show <sha> --stat`; read the diff for user-visible changes only.
- Group related commits into one ticket when they serve one outcome; separate outcomes = separate tickets.

## 2. Draft — product-manager voice
- Non-technical: capabilities and outcomes the user sees; never mechanism (module names, keys, hooks, migrations) unless explicitly requested.
- No "I need", "we need", "should": state what the product now does — "The image gallery groups photos by person."
- Per ticket: Title (outcome, 10 words or fewer) · What changed (user-visible behavior, bullets) · Why it matters (one line) · Acceptance (checkable by a non-engineer).
- Ambiguous user impact → one batched question, never a guessed ticket.

## 3. Save
- One markdown file per ticket at `<repo>/tickets/<slug>.md` (or the path the user names); report the path, never restate the ticket body.
