# Writing guide — description and body craft

Read while drafting SKILL.md content. Best-practice source (opinionated community, not spec): [SKILL.md best practices](https://www.mdskills.ai/docs/skill-best-practices). Anti-pattern sweep: [anti-patterns.md](anti-patterns.md).

## Description formula (the part that matters most)

One sentence packing: **what it does + trigger phrases/keywords + when to use + what NOT for** (redirect to sibling skill). Follow existing skills' style — read sibling `~/.pi/agent/skills/*/SKILL.md` first for tone + negative-scope idiom.

Good: "Extracts text and tables from PDF files, fills PDF forms. Use when the user mentions PDFs, forms, or document extraction — even if they never say 'PDF' explicitly. NOT for images."
Bad: "Helps with PDFs."

Models undertrigger skills. Descriptions slightly pushy: cover casual phrasings + cases where user doesn't name the artifact but clearly needs it.

Always third person ("Extracts…", never "I can help…") — description lands in system prompt; first person confuses discovery. Pack concrete nouns/verbs a user would type (Excel work: both "Excel" + ".xlsx"). Quick test: 100 skills loaded — would agent know exactly when to pick this one?

## Body guidelines

- <500 lines, ideally <5000 tokens — loaded fully once activated. Three-level loading:
  1. metadata (name + description) — always in context
  2. SKILL.md body — on trigger
  3. bundled resources — on demand; scripts run without loading at all.
- Add only context the agent lacks — it knows coding, common formats, libraries. Challenge every paragraph ("does this need explaining?"); every filler token pushes out user's request.
- Match freedom to fragility:
  - creative/analysis → goal-level steps
  - established patterns → preferred shape, room to adapt
  - fragile operations (migrations, deploys, publish) → exact commands ("run exactly this, do not modify").
- Multi-step operations → numbered steps (sequences followed far better than prose); branching tasks → explicit conditional routing ("creating? §A; editing? §B"), large workflows in own reference file.
- Build feedback loops into procedures: do → validate → fix → re-validate, "only proceed when validation passes" — without explicit loop, agents validate once and move on.
- Sections: concise instructions, worked examples (commands/code), common pitfalls/checklist.
- Reference files **one level deep** from skill root (SKILL.md → A → B chains get partially read).
- Reference file >~100 lines → table of contents.
- Skill spans multiple domains/frameworks → split by variant (`references/aws.md`, `references/gcp.md`, …) so only relevant file read.
- Descriptive filenames (`form-validation.md`, not `doc2.md`) — filenames drive what agent reads.
- `scripts/` for deterministic/repetitive code, `assets/` for files used in output (templates, icons, fonts). Helper commands → `scripts/`; script security rules in [anti-patterns.md](anti-patterns.md).
- Prose only unless script truly needed; skills shipping scripts → self-contained. Placement per [skill-spec.md](skill-spec.md).

## Writing style

- Imperative ("Extract…", "Run…"), not "you should…".
- Explain why an instruction matters instead of stacking MUST/ALWAYS — models generalize from reasoning better than rigid rules. Heavy caps-lock MUSTs = yellow flag.
- Output formats → exact template; conventions → short Input → Output examples.
- Generalize: skill runs across many unseen prompts. Don't overfit to current examples; cut anything not pulling weight (lean beats exhaustive).
- One term everywhere — "endpoint" or "route", not both; inconsistent terminology confuses agent same as people.

## Common craft mistakes

- Explaining things agent already knows (JSON, REST, CSV) — pure token loss.
- Option lists ("use pypdf, or pdfplumber, or PyMuPDF…") — pick one default; mention alternative only when choice genuinely depends on context (scanned PDFs need OCR).
- Windows backslash paths — always forward slashes.
- Vague skill names (`helper`, `utils`, `tools`, `documents`) — name = routing signal; prefer gerund/action names (`processing-pdfs`, `process-pdfs`), consistent naming pattern across collection.
