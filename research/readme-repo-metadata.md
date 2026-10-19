# README & Repository Metadata Research — `pi-native`

Research brief for presenting `github.com/nurmdrafi/pi-native` (a personal pi coding-agent harness) as the work of a "harness engineer." Synthesized from Tavily search output only; claims not traceable to that material are tagged **[uncited]**.

## Answer

The fetched material supports a clear, conservative revision path for `pi-native`. The strongest evidence-backed signals are: (1) a README is judged in the first screen — contributors "need to immediately see a clear README" and a clear value statement (Codacy); (2) structure should lead with a one-line intro naming role + niche, then a "Getting started" path, then depth (drknzz checklist, jehna template); (3) GitHub itself owns the About/topics rules — lowercase, hyphens, ≤50 chars per topic, max 20 topics (GitHub Docs); and (4) the most credible niche peer in-hand, `Dicklesworthstone/pi_agent_rust`, wins attention with a concrete, falsifiable one-liner ("High-performance AI coding agent CLI written in Rust with zero unsafe code") and inline sourcing for performance claims.

For this repo specifically, the material argues for *narrowing*, not expanding. The README is 438 lines with a repo tree, tool table, skills roster, subagent section, and design rules — that is a strong second half and a weak first half. The evidence-consistent move is to compress the top into: one-line positioning that names the niche ("harness engineering"), a 30-second demo, an install/quickstart block that works verbatim, and then push the tool table / skills roster / design rules below the fold or into `docs/`. The one existing peer at this exact intersection demonstrates the payoff of specificity over scope.

Positioning is the area where the material is thinnest and most generic — the personal-branding sources are low-specificity advice (define positioning, quality over quantity, proof of work). Treat those as directional only. The genuinely transferable, cited signal is "clear authorship + evidence of work + community", not any specific formula. Given that, the highest-leverage uncited judgment call is to make the README explicitly *personal and opinionated* — "why this exists" — because a personal harness's differentiator is the author's taste, which no generic guide will tell you.

## Key Findings

### README structure
- A checklist for profile/README structure starts with "One-line intro (role + niche)" before anything else — the snippet truncates there, so treat the rest of that list as unverified. (drknzz discussion)
- The author of the Daytona README (≈4000 stars in week one) audited the 100 most popular GitHub READMEs and found them "surprisingly underwhelming," noting successful projects often already had large followings, so "the basics seem less critical to them." Actionable subset he lists: license present, code of conduct, no broken links, no empty sections. (daytona.io)
- A minimal template pattern exists with a "Getting started" section as the core block. (jehna/readme-best-practices)
- Using the repo description as a pitch with achievement + colon + value props is an observed pattern. (owengretzinger/hackmate)
- A README section for a flow chart / architecture diagram is explicitly recommended. (Medium, filipespacheco)

### About description
- The About panel should be updated with *canonical terms*; description plus topics are what drive discoverability. (EPAM dmtools discoverability playbook)
- Topics function as keyword labels; a repo supports up to 20. (NHS RAP community of practice)
- Classifying repos with topics and writing the description are listed as standard repo-level hygiene. (dev.to, pwd9000)
- A real growth case study attributes part of steady star growth to topic optimization. (owncast discussion #3854)

### Topics — official rules
- Official GitHub rules: topics must use lowercase letters, numbers, and hyphens only; each topic ≤50 characters; maximum 20 topics per repository. (docs.github.com — classifying your repository with topics)
- Observed topic vocabulary across coding-agent repositories: `agent`, `rust`, `tmux`, `cli`, `terminal`, `ai`, `devtools`, `tui`, `developer-tools`, `multiplexer`, `workspace-manager`, `codex`, `ai-agents`. (github.com/topics/coding-agents)

### Anti-patterns
- Changing functionality without updating docs causes confusion — doc staleness treated as a core open-source mistake. (dev.to, helloquash)
- "When a possible contributor opens your project page and scrolls down, they need to immediately see a clear README." (Codacy blog)
- Framing: the README is the gateway to open-source success. (Ben Hall/Katacoda video)

### Positioning
- Positioning should be defined first: values, target audience, unique value. (educative.io)
- "Proof of Work" as a phase — evidence of skills, digital footprint, community building. (abdessamadbettal guide)
- Open source: quality over quantity — one substantial contribution beats many small ones. (dev.to, thebitforge)
- Brand-building is ongoing, not one-time. (nexton.dev)
- Portfolio projects confer credibility. (YouTube, 5wNAOU59RCQ)

## Example repos worth emulating

1. **[Dicklesworthstone/pi_agent_rust](https://github.com/Dicklesworthstone/pi_agent_rust)** — closest peer (pi + Rust agent); its one-liner makes three falsifiable claims ("high-performance", "Rust", "zero unsafe code") and the README cites sources inline for performance claims.
2. **[owncast/owncast](https://github.com/owncast/owncast/discussions/3854)** — documented, measured account of topic optimization contributing to star growth.
3. **[jehna/readme-best-practices](https://github.com/jehna/readme-best-practices)** — minimal template with a single "Getting started" spine; a good length ceiling reference rather than a floor.
4. **[owengretzinger/hackmate](https://github.com/owengretzinger/hackmate)** — shows the description-as-pitch pattern (achievement, colon, value props).
5. **[contextstream/mcp-server](https://github.com/contextstream/mcp-server)** — one-sentence value prop followed by concrete enumerated capabilities.

## Actionable patterns by area

### Structure (cited unless marked)
- Order: one-line intro naming role + niche (10) → demo screenshot/GIF → install/quickstart that works copy-pasted → what problem it solves → architecture diagram (22) → depth sections → license [license placement uncited].
- Keep no empty sections and no broken links (2) — worth running a link check before publish [mechanism uncited].
- 438 lines is well past what the cited sources describe as the getting-started spine (3); move tool table, skills roster, design rules into `docs/` and link from the README [split threshold uncited].

### About description
- Restate canonical niche terms in the About field, not creative phrasing (5).
- Pattern observed: capability, colon, concrete value props (4, 19, 20).
- Niche vocabulary available for reuse: `harness`, `coding-agent`, `ai-agents`, `cli`, `rust`, `developer-tools`, `devtools`, `tui` (21).
- Character-count sweet spot is **not** established by these sources — gap.

### Topics
- Respect the hard rules: lowercase, hyphens, ≤50 chars, ≤20 topics (9).
- Practical set derived from (21) + official rules (9): `coding-agent`, `ai-agents`, `agent-harness`, `ai`, `rust`, `cli`, `developer-tools`, `devtools`, `tui`, `subagents`, `llm`. `agent-harness` is a judgment call [uncited whether it has traffic].
- Topic optimization is not cosmetic — a measured case attributes growth to it (8).

### Anti-patterns
- Stale docs after behavior changes (12) — direct risk for a personal repo with fast-moving extensions/subagents.
- Vague positioning above the fold (11).
- Buzzword soup, dead badges, walls of text: **not documented in the fetched material** — [uncited], though consistent with (2)'s broken-links/empty-sections finding and (11)'s clarity requirement.

### Positioning
- Define audience and unique value explicitly (14); show proof of work, not claims (15); quality over quantity (16).
- Highest-leverage uncited move for this repo: a short "why this exists" section, since a personal harness's differentiator is the author's specific opinions — none of the guides address personal-harness repos directly [uncited].
- `pi` badge already present is consistent with the niche-peer convention (19) [whether the badge is meaningful to readers: uncited].

## Sources

1. [drknzz — profile README checklist](https://github.com/drknzz/GitHub-Achievements/discussions/789) — one-line intro (role + niche) first; rest truncated in material.
2. [Daytona — How to write a 4000-star GitHub README](https://www.daytona.io/dotfiles/how-to-write-4000-stars-github-readme-for-your-project) — audit of top-100 READMEs; license/CoC/broken-links/empty-section checks.
3. [jehna/readme-best-practices](https://github.com/jehna/readme-best-practices) — minimal template, Getting started section.
4. [owengretzinger/hackmate](https://github.com/owengretzinger/hackmate) — description-as-pitch pattern.
5. [EPAM GitHub repository discoverability playbook](https://dmtools.lab.epam.com/docs/references/workflows/github-repository-discoverability-playbook) — About panel canonical terms drive discoverability.
6. [NHS RAP — making code discoverable](https://nhsdigital.github.io/rap-community-of-practice/training_resources/git/making-code-discoverable) — topics as keyword labels, up to 20.
7. [dev.to — GitHub repository best practices (pwd9000)](https://dev.to/pwd9000/github-repository-best-practices-23ck) — topics for classification, description practices.
8. [owncast discussion #3854](https://github.com/owncast/owncast/discussions/3854) — topic optimization tied to star growth.
9. [GitHub Docs — classifying your repository with topics](https://docs.github.com/articles/classifying-your-repository-with-topics) — official: lowercase/numbers/hyphens, ≤50 chars, max 20.
10. [GitHub community discussion #81370](https://github.com/orgs/community/discussions/81370) — GitHub SEO discussion (Pages-focused).
11. [Codacy — best practices to manage an open source project](https://blog.codacy.com/best-practices-to-manage-an-open-source-project) — README must be immediately clear to contributors.
12. [dev.to — 10 common mistakes contributing to OSS](https://dev.to/helloquash/10-common-mistakes-to-avoid-when-contributing-to-open-source-projects-1mna) — code changes without doc updates cause confusion.
13. [Ben Hall / Katacoda — README gateway](https://www.youtube.com/watch?v=-EaJEnFhwjs) — README as gateway to OSS success.
14. [educative.io — build personal brand as engineer](https://www.educative.io/blog/build-personal-brand-software-engineer) — define positioning first.
15. [abdessamadbettal — developer personal branding guide](https://github.com/abdessamadbettal/developer-personal-branding-guide) — "Proof of Work" phase.
16. [dev.to — personal branding for introverted developers](https://dev.to/thebitforge/personal-branding-for-introverted-developers-yes-its-possible-dbp) — quality over quantity in OSS.
17. [nexton.dev — build your personal brand as an engineer](https://blog.nexton.dev/build-your-personal-brand-as-an-engineer-stand-out-in-the-job-market) — brand-building is ongoing.
18. [YouTube — portfolio projects credibility](https://www.youtube.com/watch?v=5wNAOU59RCQ) — portfolio projects confer credibility.
19. [Dicklesworthstone/pi_agent_rust](https://github.com/Dicklesworthstone/pi_agent_rust) — closest niche peer; falsifiable one-liner; inline sourcing of perf claims.
20. [contextstream/mcp-server](https://github.com/contextstream/mcp-server) — one-sentence value prop + concrete capabilities.
21. [github.com/topics/coding-agents](https://github.com/topics/coding-agents) — real topic vocabulary in the niche.
22. [Medium — AI agent to build README files](https://medium.com/@filipespacheco/i-created-an-ai-agent-to-build-readme-files-here-is-what-i-learn-3ae207771d37) — recommends architecture/flow diagram section.

## Confidence & Gaps

**Solid:** GitHub's topic rules (official docs, 9); the topic vocabulary actually in use in this niche (21); the "clear README immediately" and doc-staleness claims (11, 12); the Daytona audit's concrete checklist items (2); the `pi_agent_rust` one-liner pattern (19).

**Weak or missing:**
- **Q3 was not captured** — three search results for topics/SEO specifics were lost. Topic-count and ranking behaviour beyond official rules is a gap; do not claim any traffic or ranking numbers.
- **No character-count guidance** exists in this material for the About field. The commonly repeated ~350-char figure is **[uncited]** and should not be printed as fact.
- Personal-branding sources (14–18) are low-specificity, largely vendor/creator content; they support direction, not tactics.
- Two Q4 results (code-review and platform-engineering anti-pattern papers) were flagged tangential and ignored.
- Item 10 is Pages-focused SEO, not general repo search — low weight.
- Nearly all sources are secondary (blogs, dev.to, Medium, YouTube) except GitHub Docs (9). No first-party GitHub statement on search ranking was in the material, so any claim about *how* GitHub ranks is unsupported.
- Snippets for items 1 and 4 were truncated; the missing text was not reconstructed.

## Revision plan for pi-native

Decision-ready spec derived from the findings above. Source tags: `[R#]` = numbered source above; `[repo fact]` = repo-verified fact supplied by the requester; `[uncited]` = author judgment.

### 1. New README outline

Length target: **120–160 lines** for the README (down from 438). Rationale: the cited sources describe a getting-started spine, not a manual [R3]; the split threshold itself is [uncited].

| # | Section | Content directive | Destination |
|---|---|---|---|
| 1 | Title + one-liner | `# pi-native` then one line: role + niche, naming "harness engineering" [R1]. No paragraph before it. | README |
| 2 | Badges (single row) | Keep only: release CI, latest release, MIT license, Node `.nvmrc` pin. Drop "pi coding agent" and OS badges [uncited: badge-noise is not documented in sources, only implied by R2's "no dead/empty" rule]. | README |
| 3 | Demo | One GIF or screenshot showing a native tool call in the TUI. Place above Quick start [R22 recommends an architecture visual; a demo visual is the same slot — placement [uncited]]. | README |
| 4 | Why this exists | 3–4 sentences: the harness is personal + opinionated; what the author wanted that stock built-ins did not give. [uncited — no source covers personal-harness repos; closest is R15 "proof of work"]. | README |
| 5 | What it does (3 bullets) | Falsifiable claims only, each traceable to a [repo fact]: (a) native Rust tools as first-class TUI tools replacing built-ins; (b) fail-open ladder daemon → one-shot → built-in TS oracle; (c) 24-rule fail-closed permission-gate. No adjectives without a number. | README |
| 6 | Quick start | Bootstrap script, `npm ci`, `npm run check` with expected output. Keep verbatim; it must be copy-pasteable [R3 "Getting started"]. | README |
| 7 | Architecture | One diagram + 5-line caption: TUI → permission-gate → native tools (daemon) → fallback oracle. Diagram explicitly recommended [R22]. | README (image + link to deep doc) |
| 8 | Native tools table | The four-crate table, trimmed to one row per tool (name, replaces, one-line purpose). Full daemon/parity/fail-open detail moves out. | README table stays trimmed; **full detail → `docs/native-tools.md`** |
| 9 | Skills & subagents (summary) | 3-line summary each + link. Subagents: tmux, gated off by default, zero prompt tokens until triggered [repo fact]. | **`docs/skills.md`, `docs/subagents.md`** |
| 10 | Design rules / permission-gate | The 24-rule gate and design principles are reference material, not onboarding. | **`docs/design-rules.md`** |
| 11 | Docs index | Bulleted links to every moved doc — this is how the split stays discoverable [R2: no empty sections, no broken links]. | README |
| 12 | Contributing / dev setup | Repo tree, `npm run check`, `npm run gate:eval`, `npm run daemons:kill` after rebuild. | **`docs/development.md`** |
| 13 | License | MIT, © nurmdrafi. Must be present [R2 lists license as a basic]. | README (last line) |

Moves out of the README: repo tree (→ `docs/development.md`), skills roster tables + skill layout validator (→ `docs/skills.md`), full native-tools daemon/parity ladder (→ `docs/native-tools.md`), CHANGELOG/README update table (→ `docs/development.md`), Design rules (→ `docs/design-rules.md`).

### 2. Candidate one-line value props

All claims below are [repo fact]; ordering/emphasis is [uncited].

- **A.** "A personal pi coding-agent harness: first-class Rust tools with a fail-open fallback ladder, a 24-rule fail-closed permission gate, and skills that pass a validator before they load."
- **B.** "Harness engineering for the pi coding agent — native Rust tools that replace the built-ins, daemon dispatch 0.03–0.18 ms faster than one-shot, and ≥94% model-visible byte reduction from deterministic, idempotent compaction."
- **C.** "pi-native: the harness I wanted — Rust native tools, gated subagents, and validator-enforced skills, on macOS and Linux with Node pinned via `.nvmrc`."

Selection note: A reads best as an About/one-liner because it makes four checkable claims with no unverifiable superlatives; B is strongest for the README's "What it does" block where the numbers belong [uncited]; C leans on authorship ("the harness I wanted"), which is the recommended positioning signal [R14, R15].

### 3. About description

```
Personal pi coding-agent harness: Rust native tools replacing built-ins, fail-closed permission gate, gated tmux subagents, validator-enforced skills.
```

Rationale: leads with canonical niche terms (personal, pi, coding-agent, harness, Rust, permission gate, subagents, skills) [R5, R21]; every clause is a [repo fact]; no superlatives. Length is ~150 characters — **within** any plausible GitHub limit, but no source in this brief establishes the field's max or sweet spot, so no character target is asserted [uncited].

### 4. Topics

Rules applied: lowercase, hyphens, ≤50 chars, ≤20 total [R9]. Vocabulary drawn from [R21] plus repo-niche terms.

| Topic | Rationale |
|---|---|
| `coding-agent` | Canonical niche term; present in observed vocabulary [R21]. |
| `coding-agents` | Plural tag used by the topic page itself [R21]. |
| `ai-agents` | Observed in vocabulary [R21]. |
| `agent-harness` | Names the niche the repo claims; **not** shown as high-traffic [uncited]. |
| `harness-engineering` | Matches the positioning goal; traffic unknown [uncited]. |
| `pi` | Project identity; also the existing badge [repo fact]. |
| `rust` | Observed in vocabulary [R21]; four Rust crates [repo fact]. |
| `cli` | Observed [R21]. |
| `developer-tools` | Observed [R21]. |
| `devtools` | Observed [R21]. |
| `tui` | Observed [R21]; tools are first-class TUI tools [repo fact]. |
| `tmux` | Observed [R21]; subagents run on tmux [repo fact]. |
| `subagents` | Feature term, [repo fact]. |
| `skills` | Feature term, [repo fact]. |
| `permission-gate` | Differentiator, [repo fact]; traffic unknown [uncited]. |
| `ai` | Broad but observed [R21]. |

16 topics — within the 20 cap [R9]. Dropped `codex` and `multiplexer` from [R21]: neither describes this repo [repo fact].

### 5. Migration map

| Current section | New location |
|---|---|
| Badge rows (6 badges) | README, trimmed to 4 |
| Contents | Deleted — README is short enough not to need one [uncited] |
| Quick start | README (unchanged) |
| Repo tree | `docs/development.md` |
| Native tools (4 crates, daemon `--serve`, fail-open ladder, byte-exact parity) | Summary row per tool in README; detail → `docs/native-tools.md` |
| Skills roster tables + skill layout (validator-enforced) | `docs/skills.md`; 3-line summary in README |
| Subagents (tmux, gated by default) | `docs/subagents.md`; 3-line summary in README |
| Design rules | `docs/design-rules.md` |
| CHANGELOG/README update table | `docs/development.md` |
| License | README (unchanged) |
| — | New: demo, Why this exists, What it does (3 bullets), Architecture, Docs index |

### 6. Post-edit link/anchor checklist

- [ ] Every link in the new Docs index resolves to a file that exists (`docs/native-tools.md`, `docs/skills.md`, `docs/subagents.md`, `docs/design-rules.md`, `docs/development.md`). [R2: no broken links]
- [ ] No empty or placeholder sections remain. [R2]
- [ ] Surviving badges: their workflow badge URLs and shields.io targets still resolve — release CI workflow name, latest release, MIT license, Node pin. The dropped badges' URLs must not be referenced anywhere else.
- [ ] Internal anchors used by the README (Architecture, Quick start, What it does) use headings that exist verbatim.
- [ ] Any anchor previously pointing at a moved section now points at the new doc path, not `#section`.
- [ ] License line present at end of README. [R2]
- [ ] `.nvmrc` and Node ≥22.19 claim in Quick start still agree with the badge. [repo fact]
- [ ] Run a markdown link check before publish — mechanism [uncited].
