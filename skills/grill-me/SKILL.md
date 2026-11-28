---
name: grill-me
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
disable-model-invocation: false
---

Interview user relentlessly until shared understanding. Model decisions as **design tree**: every decision branches into dependent decisions.

Work tree in **rounds**. **Frontier** = decisions whose prerequisites settled = questions askable now without guessing unheard answers. Ask whole frontier in one round: number each question, give recommended answer. Wait for answers before next round.

Round format:

```
**Q1** - **<title>**: <body, multi-paragraph/choices OK>

→ <recommended answer>

---

**Q2** - **<title>**: <body>

→ <recommended answer>
```

Each answered round reshapes tree: settled decisions push frontier outward, unblock dependents. Recompute frontier each round. Question depending on still-open question → later round.

Facts = your job, never user's. Frontier question needs environment fact → dispatch sub-agent; never ask user lookable-up things. Don't block: running exploration = unsettled prerequisite; only downstream questions wait; ask rest of frontier now. Decisions = user's: put each to them, wait.

Done when frontier empty: every branch visited, nothing silently assumed. No action until user confirms shared understanding.
