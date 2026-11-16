# pi-native: Product Strategy, Packaging, Adoption, and Community Research

**Research snapshot:** 11 November 2026  
**Project:** https://github.com/nurmdrafi/pi-native  
**Update:** Includes the product/adoption analysis, repository findings, package and extension strategy, Reddit discovery plan, full source inventory, and the newly scheduled weekly ecosystem scan.

> This is a strategy and research document, not a claim that every recommendation has been implemented. Installation commands and package names shown as future examples must not be advertised as working until the package is published and tested.

---

## Executive recommendation

Make pi-native **easy to try as a Pi package, useful one capability at a time, and valuable as a complete harness**.

Recommended direction:

1. Keep one GitHub monorepo. Separate distributable Pi resources from the full workstation profile and development tooling.
2. Publish one installable Pi package first. Bundle related extensions and skills; make resources configurable. Do not split everything into separate npm packages before observing demand.
3. Use Pi's native package manager. Target `pi install npm:@nurmdrafi/pi-native` only after creating and publishing a valid package.
4. Keep the complete workstation bootstrap as a separate, optional path.
5. Distribute prebuilt Rust executables for supported platforms so regular users do not need Cargo. Keep source compilation for contributors and unsupported platforms.
6. Lead with user outcomes: bounded context, policy enforcement, session diagnosis, and native execution performance.
7. Validate demand in r/PiCodingAgent before a major launch. Start with a transparent discovery post, then publish a feature-focused showcase.
8. Publish reproducible end-to-end evidence. Microbenchmarks are useful, but task time, token usage, actual cost, correctness, and wasted calls determine whether users benefit.

### Recommended positioning

> pi-native makes long-running Pi coding sessions more efficient, predictable, and observable without replacing the coding agent.

**Short description:**

> A performance and policy harness for the Pi coding agent, combining native Rust tools, tool-call policy enforcement, context management, session auditing, and selectively loaded skills.

### Positioning correction

Do not claim that no one has solved agent permissions, context management, or usage visibility. Existing Pi packages and projects already address parts of these problems. Your defensible distinction is the **specific implementation and measured engineering of native tool execution, bounded output, tool-call policy enforcement, and session diagnostics in one Pi-oriented setup**.

---

# 1. What problem does pi-native solve?

The strongest framing is operational: Pi is extensible, but developers who use it intensively still have to manage execution cost, context, tool permissions, session visibility, and configuration.

## 1.1 Tool execution overhead and context waste

Long coding sessions involve repeated file reads, edits, shell commands, and command output. Excessive output consumes model context that could otherwise be used for reasoning. Repeated process startup and parsing can add execution overhead.

### What pi-native provides

The current repository documents five Rust tools:

| Tool | Role | Documented behavior |
|---|---|---|
| `piread` | Text-file reads | Windowed reads and output shaping |
| `piedit` | File edits | Native edit pipeline and bounded diff/patch output |
| `pibash` | Shell execution | Command-aware output shaping and spill-file support |
| `piwrite` | File writes | Content piped as raw stdin bytes rather than argv |
| `pidx` | Session-log inspection | Compact session extracts, incremental indexing, usage reports and lifecycle analysis |

`docs/native-tools.md` says the tools register as first-class Pi tools. It documents a persistent daemon for `piread`, `piedit`, and `pibash`, with a one-shot CLI spawn as the transport fallback. It explicitly says there is no third automatic built-in fallback: terminal failure becomes a tool error. `piwrite` uses a one-shot spawn; `pidx` incrementally processes session logs using a size/mtime cache.

### Why developers may care

The meaningful benefit is not that a Rust function is intrinsically faster. It is whether a real coding task completes with:

- Less tool execution overhead.
- Less unnecessary model-visible output.
- Fewer repeated or unproductive calls.
- No loss of relevant information.
- No reduction in task correctness.

### Current repository-reported measurements

The current root README reports, among other things:

- **1.4× to 3.5×** faster p50 dispatch latency across five matched workloads in its performance chart.
- **1.88× to 18×** throughput gains on selected workloads, while also showing losses for `pibash` pipe at 0.70× and `pidx` cold index at 0.68×.
- **48× to 171×** lower peak RSS on three matched workloads in its footprint chart.
- Model-visible context bytes reduced from **273,312 to 15,569**, a reported **94.3% reduction**.
- `pidx` session-log re-scan: **2.1 seconds cold to 28 milliseconds warm**, described in the README as roughly 17× payback.

These are measurements reported by the project, not independently reproduced results. The `piread` microbenchmark is explicitly a single-machine sanity benchmark; its note says the adoption verdict uses a separate S2 pair. Link each published claim to the exact test and methodology. Do not turn 94.3% less model-visible output into a 94.3% reduction in API cost.

## 1.2 Unintended or unsafe tool calls

An agent can misunderstand instructions, make destructive changes, or be influenced by malicious instructions in repository files, comments, command output, or other untrusted content.

### What pi-native provides

The root README and extension documentation describe a fail-closed permission gate with checks including:

- Read coverage before editing.
- Edit-anchor validation.
- Destructive-command analysis and confirmation.
- Shell output limits.
- Repeated execution protection.
- Search and toolchain discipline.
- Configurable policy modules.
- Corrective feedback when a call is blocked.

Describe this as **tool-call policy enforcement**, **guardrails**, or **safer defaults**.

### Security boundary

A permission gate is not an OS sandbox. It can only enforce policy on the operations and execution paths it intercepts. Pi extensions, package code, child processes, and other tools may have the host user's operating-system permissions unless a separate OS or virtualization boundary restricts them.

Therefore:

- Do not claim complete system security.
- Do not claim the gate prevents every malicious or unintended action.
- Explain exactly which calls are intercepted.
- Document bypasses and limitations.
- Recommend containers, VMs, dedicated accounts, or OS-level isolation where stronger containment is required.

A credible threat model is more valuable than the phrase “real security.”

## 1.3 Limited visibility into agent usage and cost

A developer may see the final code change without understanding the path the agent took to produce it. Useful questions include:

- How much did this session cost?
- How many input and output tokens were used?
- What proportion of input came from cache?
- Which tools consumed the most time?
- Did the agent repeat calls or retry after a blocked call?
- How much work did subagents perform?
- Is the session approaching its budget?

The repository describes a dashboard with overview, sessions, subagents, permission-gate and live tabs over SSE, plus token spend, cache hit rate, tool/subagent/gate metrics and per-session USD budget alerts.

`pidx` provides usage reports with model, turns, tokens, cache share and cost, plus lifecycle records and waste detectors such as `dupCall`, `resendAfterBlock`, `probeRepeat`, and `proseOnly`.

The current docs state that session discovery excludes sessions modified in the last five minutes. Do not describe the normal `pidx` audit as live coverage of the currently active session. The dashboard's live SSE behavior is a separate capability; explain precisely what it streams and what data can be delayed.

Position this as **session auditing and diagnosis**, not merely a token counter.

## 1.4 Configuration and workflow maintenance

Power users accumulate tools, extensions, skills, prompts, scripts, model settings, and environment-specific setup. That configuration can become difficult to reproduce and maintain.

The current repository treats `~/.pi/agent/` as an engineered workstation and provides bootstrap/after-pull scripts, skills, extensions, native tools, tests, and dashboard code. The adoption opportunity is to make useful capabilities reproducible without requiring every user to adopt the author's entire personal configuration.

---

# 2. What is already available in the Pi ecosystem?

Do not claim that individual features are unprecedented.

Pi supports extensions and a package system. Its package format can distribute extensions, skills, prompt templates, and themes through npm, Git, or local paths. The package catalog contains projects for permissions, context, usage statistics, subagents, sandboxing and workflow integration.

## 2.1 Relevant existing projects inspected

| Project | What it demonstrates | Implication for pi-native |
|---|---|---|
| `pi-subagents` | Delegation and multi-agent workflows | Subagents are an established package category |
| `context-mode` | Context-window savings for coding agents | Context efficiency has competing tools |
| `pi-stats-ext` | Local-first usage dashboard for tokens, costs, models, projects and sessions | A dashboard alone is not a unique differentiator |
| `@mtrojnar/pi-usage` | Usage and rate-limit monitoring, startup reports and live updates | Usage tracking already has alternatives |
| `pi-usage-dashboard` | Web dashboard for tokens, costs, sessions, resources and extension management | Dashboard breadth is already competitive |
| Apache Magpie Pi harness | Permission rules, action guard and OS sandbox integration | Compare actual isolation boundaries, not only rule counts |
| CodePi | VS Code integration for Pi, with workspace context, edit review, sessions and safety controls | Users also value editor/workflow integration |
| One Code | Bundled Pi workflow with extensions, permissions, subagents, hooks, MCP and cache-oriented design | Integration alone is not unique |
| `pi-context-paging` | Rolling context window and history retrieval | Context retention and paging have dedicated solutions |
| Pi-Bolt | Rust-oriented Pi tooling/performance claims | Native implementation alone does not establish differentiation |

These are adjacent projects, not identical replacements. Their implementation, security boundaries, compatibility and maintenance quality differ. Review current source and releases before making competitive claims.

### Defensible distinction

> pi-native focuses on measured native-tool execution, bounded model-visible output, policy enforcement across its native tool path, and session diagnostics, while preserving the official Pi agent.

Your benchmark methodology, tool parity, failure behavior, context footprint, and installability become the evidence.

## 2.2 Product differentiation test

Before claiming a unique feature, ask:

1. Does another Pi package already provide it?
2. Does it provide the same behavior or only a similar label?
3. Does it run on the same tool path?
4. Does it measure the same outcome?
5. Is its security boundary comparable?
6. Does pi-native combine the capability with something materially different?

A comparison matrix should cite exact versions and release dates. Do not compare only README marketing phrases.

---

# 3. Who is most likely to use pi-native?

The strongest initial audience is developers who use Pi intensively and encounter operational friction.

| Audience | Why they may adopt pi-native |
|---|---|
| Heavy Pi users | Reduce repeated tool overhead and unnecessary context |
| Developers working in large repositories | Use bounded reads, edits, output shaping and indexing |
| Developers running autonomous workflows | Apply consistent rules before tool execution |
| Cost-conscious API users | Inspect token usage, cache share and session costs |
| Developers running multiple agents | Inspect subagent activity and constrain tool use |
| Pi extension developers | Reuse measured native tooling and policy infrastructure |

A casual user who opens Pi occasionally may not need a full harness. A developer who uses Pi for hours daily across several repositories is more likely to appreciate it.

---

# 4. Installation: make adoption easy

## 4.1 Use Pi's native package manager

Pi supports package installation from npm, Git, and local paths. The intended experience after publishing the package should be:

**Install permanently**

```bash
pi install npm:@nurmdrafi/pi-native
```

**Try for one invocation without adding it to settings**

```bash
pi -e npm:@nurmdrafi/pi-native
```

**Install from a versioned Git ref during development**

```bash
pi install git:github.com/nurmdrafi/pi-native@vX.Y.Z
```

Replace `vX.Y.Z` with a real tag. Do not publish these as working commands until the package is correctly structured and tested.

Pi's package documentation says:

- Personal package installs are written to `~/.pi/agent/settings.json`.
- `pi -e` tries a package for one invocation without permanently adding it to settings.
- Packages can contain extensions, skills, prompt templates and themes.
- npm packages need the `pi-package` keyword to be eligible for the Pi package gallery.
- `pi remove <source>` removes a package.
- `pi update --extensions` reconciles package installations.
- Package resources can be selected or filtered in settings.
- Project packages are loaded only after project trust is resolved; third-party package code should be reviewed before installation.

Official reference: https://pi.dev/docs/latest/packages

## 4.2 Current installation friction

The current README asks users to:

1. Install Git.
2. Install Node.js 22.19 or newer; `.nvmrc` currently pins Node 24.
3. Install Pi.
4. Install Rust/Cargo.
5. Clone the complete repository into `~/.pi/agent`.
6. Run the bootstrap process.
7. Optionally install tmux for subagents.
8. Add the repository's generated `bin/` directory to PATH for terminal access to the same tools.

This is reasonable for a development workstation but creates friction for a user who only wants to try one feature.

The current root `package.json` contains `"private": true`, so the root repository package is not ready to publish directly as a public npm package. A dedicated package directory/workspace is a practical approach.

## 4.3 Separate package install from full workstation install

| Path | Intended user | What it installs |
|---|---|---|
| Pi package | Someone who wants to try or adopt selected features | Distributable extensions/skills and required native runtime |
| Full workstation setup | Someone who wants the opinionated environment | Full profile, scripts, instructions, optional workflows and developer tooling |

Do not silently replace `~/.pi/agent`. Preserve existing settings, explain changed paths, back up files before changes, and provide rollback.

## 4.4 Rust binary distribution

Do not require ordinary users to install Cargo just to try pi-native.

Recommended direction:

- Build binaries for each supported OS/architecture in CI.
- Publish versioned release artifacts and SHA-256 checksums.
- Verify downloaded artifacts before execution.
- Clearly list supported platforms.
- Retain Cargo compilation for contributors and unsupported platforms.
- Define what happens when a prebuilt binary is unavailable.

Possible approaches include platform-specific optional npm packages or a small bootstrap mechanism that retrieves a pinned release. Test npm package lifecycle, offline behavior, update behavior, binary permissions and checksum verification before choosing. Avoid an opaque installer that silently executes arbitrary remote code.

---

# 5. Should pi-native become an extension monorepo?

## Recommendation: keep a monorepo and publish one Pi package first

An **extension** is a runtime customization Pi loads. A **package** is a distribution unit that can bundle extensions, skills, prompt templates and themes. They are complementary concepts, not alternatives.

The current `extensions/README.md` describes in-tree TypeScript extensions auto-discovered from `~/.pi/agent/extensions/`. It also states that this repository currently has no package configured in settings.

### Important model-context nuance

The current project documentation says in-tree runtime extensions do not enter the model-visible prefix, but package-provided tool definitions do add to that prefix. The official Pi package manager can filter which resources load from a package.

Therefore:

- Do not assume packaging an extension makes it context-free.
- Measure the prefix/tool-definition cost of each enabled package resource.
- Keep optional tools disabled or excluded when not needed.
- Use manual skills for knowledge/workflows that do not need a persistent tool definition.
- Explain resource filters and their defaults in the install guide.

## 5.1 Suggested monorepo layout

This is a target architecture, not a statement that these folders already exist:

```text
pi-native/
├── packages/
│   └── pi-native/
│       ├── package.json
│       ├── extensions/
│       ├── skills/
│       └── README.md
├── rust-tools/
│   ├── piread/
│   ├── piedit/
│   ├── pibash/
│   ├── piwrite/
│   └── pidx/
├── profiles/
│   └── full-workstation/
├── scripts/
├── benchmark/
├── docs/
└── tests/
```

Adapt this to the existing project rather than moving everything at once:

- `packages/`: public Pi package resources.
- `rust-tools/`: native implementations and build source.
- `profiles/`: optional full workstation configuration.
- `benchmark/`: reproducible performance evidence.
- `docs/` and `tests/`: contributor and quality infrastructure.

If package files must be built/copied from existing directories, create a deterministic staging step for `npm pack`. Avoid relying on symlinks or paths outside the published tarball. Keep credentials, personal `auth.json`, machine-specific paths, private skills and private model settings out of the public package.

## 5.2 Start with one package, not many

Start with one package such as `@nurmdrafi/pi-native`, containing related resources. Make features configurable through Pi's resource-selection settings.

Later, split only if real users repeatedly want independent installation and the features have stable boundaries:

| Potential package | User intent |
|---|---|
| `@nurmdrafi/pi-native-tools` | Native file and shell tools |
| `@nurmdrafi/pi-native-guard` | Tool-call policy enforcement |
| `@nurmdrafi/pi-native-audit` | Session usage and lifecycle analysis |
| `@nurmdrafi/pi-native` | Integrated bundle |

These are name ideas, not published packages. Check npm availability before using them.

Split when a capability has a distinct audience, dependency/release cadence, standalone value, and enough demand to justify another package's maintenance burden. Do not split merely to increase catalog entries.

## 5.3 Illustrative package manifest

```json
{
  "name": "@nurmdrafi/pi-native",
  "version": "0.1.0",
  "description": "Performance and policy tools for the Pi coding agent",
  "keywords": ["pi-package"],
  "type": "module",
  "pi": {
    "extensions": ["./extensions/*.ts"],
    "skills": ["./skills/*/SKILL.md"]
  }
}
```

This is illustrative, not publish-ready. Validate paths, package contents, runtime compatibility, `peerDependencies`, runtime dependencies and resource filtering against the current Pi package documentation. Pi supplies its own host packages; do not bundle host-provided Pi packages as ordinary dependencies.

---

# 6. How to highlight existing features

Do not lead with a long list of Rust crates or rule IDs. Lead with a problem, show the behavior, then provide implementation details and evidence.

## 6.1 Native tools and context efficiency

**Problem:** Large file and command outputs can consume context the model does not need.

Demonstrate:
- A large file read before and after output shaping.
- A shell command with excessive output and the bounded result.
- Omission markers and a clear way to retrieve more context.
- A read/edit benchmark with the exact workload.

Suggested message:

> Keep the agent focused on relevant output instead of flooding its context with entire files and command logs.

Use the README's 94.3% model-visible output reduction only with the benchmark scope and baseline beside it. Do not claim an equivalent API-cost reduction.

## 6.2 Permission gate

**Problem:** The agent can issue a call that violates project workflow or safety policy.

Show an actual example:

```text
Agent proposes an edit
        |
        v
Permission gate evaluates it
        |
        v
Required read/context is missing
        |
        v
Call is blocked with a reason
        |
        v
Agent inspects the target
        |
        v
Agent retries with the required context
```

This demonstrates behavior enforcement better than “24 security rules.” Name the exact condition, what the gate intercepts, and what can bypass it.

## 6.3 Session auditing

**Problem:** Developers cannot explain why a session used so many tokens or repeated work.

Show:
- A real `pidx --report usage` result.
- Token and cache usage.
- Session cost.
- A lifecycle report.
- One repeated-call or retry pattern detected by `pidx`.

Suggested message:

> Understand where a coding-agent session spends tokens and where repeated tool calls create avoidable work.

Distinguish completed-session auditing from dashboard live updates.

## 6.4 Progressive-disclosure skills

The current `docs/skills.md` says skills are manually invoked using `/skill:<name>` and their bodies do not enter context until invoked.

Suggested message:

> Keep specialized workflows available without loading their full instructions into every session.

Show one concrete skill and invocation. Do not claim every full-workstation capability is active by default.

## 6.5 Subagents

The README describes subagents as gated off by default. The subagent conduct file defines task scope, facts, verification commands, allowed file sets and reporting formats.

Suggested message:

> Make delegation opt-in and define each worker's scope, write surface, budget and deliverables.

Show how the parent and child session share policy enforcement. Do not claim tmux alone is a security sandbox.

## 6.6 Dashboard

The root README describes overview, sessions, subagents, permission-gate and live tabs over SSE.

A short recording should show token spend/cache rate, session cost, tool activity, permission-gate events, subagent health/spend, and a budget alert. A real walkthrough is more persuasive than a feature list.

## 6.7 Recommended README structure

1. One-paragraph problem statement and value proposition.
2. `pi install` / `pi -e` commands after package publication.
3. Dashboard screenshot or short recording.
4. Three focused demonstrations: native tools, permission gate, session audit.
5. Benchmark summary linking to exact methodology.
6. Security model and limitations.
7. Architecture and detailed docs.
8. Configuration and feature selection.
9. Contributor guide and benchmark instructions.

A new visitor should understand why the project matters before reading the architecture.

---

# 7. Benchmark and evidence strategy

Microbenchmarks are useful engineering evidence. They are not a substitute for end-to-end results.

## 7.1 Current evidence shown in the README

The README reports:
- Dispatch latency p50 gains of 1.4×–3.5× across five charted workloads.
- Throughput gains of 1.88×–18× on some workloads, with measured losses shown for `pibash` pipe and `pidx` cold index.
- 48×–171× lower peak RSS on three matched workloads.
- Model-visible context bytes from 273,312 to 15,569 (−94.3%).
- Session-log re-scan: 2.1 seconds cold versus 28 milliseconds warm.

The separate `piread` microbenchmark file records Linux x64, Node v24.21.0, `piread` 0.2.0, N=200 per arm and 10 warm-ups. It compares built-in read (in-process), persistent daemon dispatch and one-shot dispatch. It is a single-machine sanity benchmark; its note says the adoption verdict uses an S2 pair (Step 7), not this table alone.

## 7.2 Recommended end-to-end experiment

Compare official Pi with built-in tools against official Pi configured with pi-native. Keep constant the model/settings, repository/starting commit, task prompt/acceptance criteria, machine/environment, network conditions where practical, and verification commands. Repeat tasks enough times to account for model and runtime variability.

## 7.3 Metrics to publish

| Metric | What it tells users |
|---|---|
| Task completion time | End-to-end productivity |
| Input tokens | Context efficiency |
| Output tokens | Model output overhead |
| Actual API cost | Financial impact |
| Tool-call latency | Tool execution performance |
| Number of tool calls | Interaction complexity |
| Repeated/failed calls | Avoidable inefficiency |
| Task correctness | Whether speed preserved quality |
| Policy blocks and approvals | What the gate actually enforced |
| Cache-read/write tokens | Cache behavior |

Publish raw results, scripts, task prompts, hardware details, tool versions, commit hashes, repetitions, warm-up conditions, medians/percentiles and failed runs.

### Claims discipline

Use scoped statements such as “Selected file operations were X times faster in this benchmark” and “Model-visible output was reduced by X% under the tested workload.” Avoid claims that every coding task is faster, API costs fall by the same percentage, or the project provides complete security.

---

# 8. What community research suggests

These Reddit discussions are qualitative examples, not representative surveys. Treat them as signals to validate, not proof of community consensus.

## 8.1 Always-on tools and context bloat

A discussion titled “some tools bloat the context. Why” describes concerns about extensions registering many active tools and injecting tool descriptions/reminders into every turn. The author reports an anecdotal extra context cost from a small number of packages and suggests keeping less-used capabilities out of the always-on path.

**Implication:** Make optional resources genuinely optional; measure prefix/tool-definition cost; explain which extensions register model-visible tools; prefer manual skills for instructions that do not require permanent tool definitions; do not load every capability just because it ships in one bundle.

https://www.reddit.com/r/PiCodingAgent/comments/1tyzsk6/some_tools_bloat_the_context_why/

## 8.2 Context retrieval and token efficiency

A discussion asks for a context engine or retrieval tool that fetches relevant files and saves tokens.

**Implication:** The problem is not simply retrieving more context. It is retrieving relevant context without increasing the always-on footprint. Demonstrate bounded reads and output shaping, while acknowledging dedicated context-management competitors.

https://www.reddit.com/r/PiCodingAgent/comments/1w4hefn/extensionstools_for_context_retrieval/

## 8.3 Manual context/output shaping

A heavy Pi user describes restricting files the agent can see and grouping tool output to reduce unnecessary search calls and context.

**Implication:** Developers already use manual constraints. Show how pi-native makes these practices measurable and less labor-intensive.

https://www.reddit.com/r/PiCodingAgent/comments/1wps5ha/i_use_ai_models_at_least_4_hours_per_day_and_i/

## 8.4 Subagent architecture and permission boundaries

A discussion about subagent extensions compares in-process and out-of-process approaches, specialization, tool allowlists, complexity, UI clarity and permission boundaries.

**Implication:** Keep subagents opt-in; make tool allowlists and write scopes visible; explain process boundaries; do not treat tmux alone as a sandbox; demonstrate the gate inside child agents; do not require subagents to use native tools or session auditing.

https://www.reddit.com/r/PiCodingAgent/comments/1vsl06f/subagent_extensions/

## 8.5 Minimal extension showcases

A community showcase presents a set of smaller extensions and demonstrates them individually.

**Implication:** Users can understand and adopt individual capabilities more easily than a large personal workstation. A single package can still deliver modular resources.

https://www.reddit.com/r/PiCodingAgent/comments/1xd9oj7/a_set_of_minimal_extensions_i_built_for_pi/

## 8.6 More recent overlap in the community

The r/PiCodingAgent feed also surfaced discussions about `pi-context-paging`, `One Code`, `Pi-Bolt`, and visibility into context consumption. These are reasons not to position “integrated harness” or “context efficiency” as unique categories by themselves. Your evidence needs to be specific: native tool throughput/latency, memory footprint, bounded tool output, stateful policy behavior, and the exact semantics of session auditing.

Community feed: https://www.reddit.com/r/PiCodingAgent/

---

# 9. Reddit strategy: research first, showcase second

## Recommendation

Yes, post in r/PiCodingAgent. Start with product discovery rather than asking for stars or immediately pitching pi-native.

Find out:
- Which problems occur repeatedly during real coding sessions?
- Which workarounds have developers built?
- Which extensions have they installed and later removed?
- Which tool definitions or extension behaviors create context overhead?
- How do they handle permission boundaries?
- What do they need from subagent workflows?
- Which existing features are difficult to discover or configure?

Read current community rules before posting: https://www.reddit.com/r/PiCodingAgent/about/rules

## 9.1 Suggested first post: product discovery

**Title:**

> What recurring friction have you experienced while using Pi for real coding work?

**Post:**

```text
I use Pi as my coding agent and have been exploring ways to improve the
 developer experience around it.

Before investing further in my own tooling, I want to understand what
other Pi users actually struggle with.

Think about your last 5–10 coding sessions:

1. Where did you repeatedly lose time or have to intervene manually?
2. What workaround did you create for yourself?
3. Have you installed an extension or built your own to solve a particular
   problem?
4. What still feels unnecessarily difficult or remains unsolved?

I'm particularly interested in problems you've encountered repeatedly,
rather than hypothetical feature requests.

For transparency, I'm developing an open-source project called pi-native.
But I don't want to assume that the problems I'm trying to solve are
necessarily the problems other developers have.

I'd rather understand the community's needs before deciding what to build
next.

Concrete examples and existing workarounds would be especially helpful.
```

Be transparent that you are building a project. Do not disguise promotion as neutral research. Follow subreddit rules and do not add a repository link if the current rules or post format do not permit it.

## 9.2 How to analyze replies

| Signal | Interpretation |
|---|---|
| Multiple users independently describe the same issue | Potential shared pain point |
| Users have built workarounds | Existing workflow may be insufficient |
| Users tried and abandoned existing extensions | Usability or reliability gap worth investigating |
| Users ask to test a specific feature | Potential adoption signal |
| Users only say “cool project” | Encouragement, not evidence of demand |

Map responses to existing capabilities:

| Community problem | pi-native feature to demonstrate |
|---|---|
| Too much output in context | `piread`, `pibash`, output shaping |
| Too many tool definitions | Resource selection and progressive-disclosure skills |
| Repeated wasteful calls | `pidx` lifecycle report |
| Unwanted tool calls | Permission gate |
| Unclear session cost | `pidx --report usage` and dashboard |
| Subagent permissions/scope | Subagent policy and file-set restrictions |

Do not build a new feature until you understand whether the current implementation already addresses the problem.

## 9.3 Second post: project showcase

After collecting feedback and improving the most relevant part, publish a separate showcase containing:

1. The concrete problem.
2. The feature that addresses it.
3. A short screen recording or screenshot.
4. A one-command try/install command.
5. Reproducible benchmark results.
6. Known limitations.
7. A request for specific feedback.

Do not ask people to star the repository. Ask them to try the relevant functionality and report where it falls short. Stars should follow usefulness, not be the primary call to action.

---

# 10. How to improve conversion from README visitor to user

A developer should understand the problem before reading the architecture.

Recommended above-the-fold order:

1. One-sentence value proposition.
2. A problem statement in plain language.
3. `pi -e` try command and permanent install command, after publication.
4. A real screenshot or recording of dashboard/session audit.
5. Three feature summaries with links.
6. Benchmark highlights with methodology.
7. Security boundary and limitations.
8. Full installation and configuration details.

### Suggested README opening

```markdown
# pi-native

A performance and policy harness for the Pi coding agent.

Long-running coding sessions can waste context, repeat tool calls, and
make it difficult to understand what the agent is doing or spending.

pi-native combines native Rust tools, tool-call policy enforcement,
context management, and session auditing without replacing Pi.

- Native tools with bounded output
- Fail-closed tool-call policy enforcement
- Session usage and lifecycle auditing
- Skills that load only when invoked
- Optional, policy-aware subagent workflows

Built on the official Pi coding agent.
```

Do not present every feature as always-on. State which resources register tools, which are manually invoked, which are disabled by default and which affect the model-visible prefix.

---

# 11. Current repository findings to resolve before promotion

These observations are based on public files inspected on or around 11 November 2026.

## 11.1 Root package is private

The current root `package.json` has `"private": true`. It is not ready to publish directly as a public npm package. Use a dedicated package directory/workspace or deliberately change the root package strategy.

## 11.2 Workstation-style extension discovery is the current model

`extensions/README.md` says TypeScript extensions are auto-discovered from `~/.pi/agent/extensions/`. It also says the repo currently has no Pi packages declared in settings. Add a publishable Pi package manifest and resource layout for package-manager adoption.

## 11.3 Model-visible prefix must be measured after packaging

The project documentation says the in-tree runtime extensions do not add to the model-visible prefix, while package-provided tool definitions do. Pi's package settings allow resource selection/filtering.

Measure the exact prefix/tool-definition cost for:
- No pi-native package.
- Package installed with default resources.
- Package installed with each resource filtered.
- Only selected extension(s) enabled.

This can become a useful adoption feature: provide a measured minimal profile and a full profile.

## 11.4 Fallback documentation needs reconciliation

`docs/native-tools.md` says daemon → one-shot, with no third built-in fallback. The root README says there is no silent fallback and built-ins only by explicit configuration. The current `extensions/README.md` table also describes built-in `bash` as the fallback for the `pibash` extension.

Clarify exact failure/selection semantics per tool. Do not let “fallback” mean three different things in different docs.

## 11.5 Benchmark claims need direct links

The root README contains multiple performance charts. The separate `piread` microbenchmark is explicitly a single-machine sanity run. Link each headline number to the relevant test script and result file. Explain workload, baseline, machine/runtime, repetitions/warm-up, metric definition, and whether the result is a microbenchmark or end-to-end.

## 11.6 Security wording must match the threat model

Use “fail-closed tool-call policy gate” and explain intercepted operations. Make clear that this is not equivalent to a general OS sandbox. Compare actual containment claims against projects such as Apache Magpie, which explicitly describes an OS sandbox layer.

## 11.7 Feature counts and diagrams must agree

The README advertises a 24-rule gate. Verify that the list, tests and architecture diagram enumerate the same active rules. Avoid stale counts.

## 11.8 Package-versus-extension wording needs precision

A package is a distribution unit; an extension is a runtime resource. A Pi package can contain multiple extensions and skills. Resource selection can filter resources. Enabled extensions' tool definitions may still affect model-visible context. Document these distinctions in plain language.

---

# 12. Recommended execution order

## Phase 1 — Improve credibility

1. Reconcile fallback behavior and rule counts.
2. Link README claims to exact benchmark evidence.
3. Add a precise security model and limitations.
4. Add dashboard screenshots or a short recording.
5. Explain `pidx` completed-session scope and dashboard live data separately.
6. Add a minimal-feature profile and measure its prefix cost.

## Phase 2 — Make the package installable

1. Create a package workspace under `packages/`.
2. Add a valid Pi package manifest and `pi-package` keyword.
3. Separate distributable resources from personal workstation configuration.
4. Design prebuilt Rust binary distribution.
5. Add checksum verification and rollback.
6. Test clean install, update, removal, offline behavior, and an existing user's `~/.pi/agent`.
7. Test resource filters and package prefix cost.
8. Publish an npm prerelease and validate `pi -e` and `pi install`.

## Phase 3 — Validate demand

1. Publish the transparent Reddit discovery post.
2. Categorize replies by recurring problem.
3. Map reported pain to existing pi-native capabilities.
4. Ask interested users to test a prerelease.
5. Prioritize improvements based on actual friction.

## Phase 4 — Launch

1. Publish the npm package with the `pi-package` keyword.
2. Ensure it appears correctly in the Pi package gallery.
3. Publish a feature-focused Reddit showcase.
4. Share reproducible end-to-end benchmarks.
5. Invite external benchmark submissions and issue reports.

---

# 13. What to measure after launch

Stars are a useful discovery signal, but they do not prove lasting product value.

Track:
1. Repository visitors.
2. README-to-install conversion.
3. Successful first install.
4. Successful first run.
5. Repeat usage after one week.
6. Which modules are enabled or disabled.
7. Issues from real usage.
8. External benchmark submissions.
9. Pull requests and independent integrations.

A small number of repeat users and reproducible external reports are stronger evidence of value than stars alone.

---

# 14. Weekly Pi ecosystem scan — scheduled task

A weekly recurring task has been created successfully in ChatGPT.

- **Task:** Weekly Pi ecosystem scan
- **Cadence:** Every Monday
- **Scheduled local time:** 18:00
- **Timezone:** `Asia/Dhaka`
- **First scheduled occurrence:** Monday, 16 November 2026
- **Delivery mode:** Flexible schedule (the run may start slightly before or after the target time)

The scan is instructed to review:

- Official Pi documentation, releases/changelog and package catalog.
- Relevant GitHub repositories and releases.
- r/PiCodingAgent discussions.
- New or materially changed extensions/packages.
- Native tools and performance work.
- Context management and context-prefix overhead.
- Permission/security approaches.
- Session observability and cost tooling.
- Subagent workflows.
- Package-manager/distribution and compatibility changes.
- Repeated user pain points that may inform pi-native.

Each report should include the scan date and coverage, notable changes with dates and links, packages worth evaluating, relevant community pain points, implications for pi-native, prioritized actions (`now` / `next` / `later`), and items to monitor. It should distinguish verified facts from community anecdotes and analysis. It is instructed to deliver a report every run, including a note when no material change is found, and to perform research only (no posting, starring, installing, or repository modification).

---

# 15. Complete research source inventory

This inventory lists repository files and external resources opened or inspected while preparing the analysis. A link does not imply that the entire repository, site, or discussion was exhaustively reviewed.

## 15.1 pi-native repository files opened

| File | Why it was inspected |
|---|---|
| [README.md](https://raw.githubusercontent.com/nurmdrafi/pi-native/main/README.md) | Positioning, features, performance charts, installation, prerequisites, architecture, skills/subagents |
| [package.json](https://raw.githubusercontent.com/nurmdrafi/pi-native/main/package.json) | `private` flag, package name, scripts, dashboard and benchmark commands, dependencies |
| [.nvmrc](https://raw.githubusercontent.com/nurmdrafi/pi-native/main/.nvmrc) | Node version pin |
| [AGENTS.md](https://raw.githubusercontent.com/nurmdrafi/pi-native/main/AGENTS.md) | Repository-level agent instructions and workflow constraints |
| [SYSTEM.md](https://raw.githubusercontent.com/nurmdrafi/pi-native/main/SYSTEM.md) | Agent tool-use rules, read/edit prerequisites and context-budget instructions |
| [docs/native-tools.md](https://raw.githubusercontent.com/nurmdrafi/pi-native/main/docs/native-tools.md) | Native tool inventory, daemon/one-shot behavior, fallback details and `pidx` reports |
| [extensions/README.md](https://raw.githubusercontent.com/nurmdrafi/pi-native/main/extensions/README.md) | Extension discovery, runtime behavior, prefix note, permission gate, subagents and `pibash` fallback wording |
| [docs/skills.md](https://raw.githubusercontent.com/nurmdrafi/pi-native/main/docs/skills.md) | Manual skill loading and skill inventory |
| [docs/subagents.md](https://raw.githubusercontent.com/nurmdrafi/pi-native/main/docs/subagents.md) | Child-agent contracts, file scope, restrictions, verification and reporting |
| [benchmark/runs/piread-microbench-2026-10-15.md](https://raw.githubusercontent.com/nurmdrafi/pi-native/main/benchmark/runs/piread-microbench-2026-10-15.md) | Host/runtime, repetitions, read-dispatch p50/p95, daemon vs one-shot, memory and benchmark caveat |

### Repository paths attempted but not successfully retrieved

- `docs/custom-tools-architecture.md` at https://raw.githubusercontent.com/nurmdrafi/pi-native/main/docs/custom-tools-architecture.md returned 404. It is not used as evidence.
- GitHub directory pages for `docs/` and `extensions/` were attempted but were not retrievable as directory listings. No claim is made that every file in these directories was inspected.

### Repository links referenced by README but not opened as standalone files in this research

These are useful follow-up files, but they should not be represented as fully inspected:

- `docs/rust-tools-architecture.md`
- `docs/zero-init.md`
- `docs/design-rules.md`
- `docs/subagent-orchestration.md`
- `extensions/subagents/README.md`
- Dashboard documentation and implementation under `dashboard/`
- `docs/assets/benchmarks/bench-speed.svg`
- `docs/assets/benchmarks/bench-footprint.svg`

## 15.2 Official Pi documentation opened

| Resource | Why it was inspected |
|---|---|
| [Pi Packages](https://pi.dev/docs/latest/packages) | Package capabilities, install sources, one-shot `-e`, package manifest, `pi-package` keyword, dependencies and resource filters |
| [Pi Quickstart](https://pi.dev/docs/latest/quickstart) | Official getting-started documentation |
| [Pi Package Catalog](https://pi.dev/packages) | Package discovery model and examples of adjacent packages |
| [Pi Run Pi Safely](https://pi.dev/docs/latest/security) | Security and isolation documentation |
| [Pi Extensions](https://pi.dev/docs/latest/extensions) | Extension API reference and build guidance |

Specific package-doc sections followed include install/manage, source selection, package creation, dependency declarations, and resource selection.

## 15.3 Pi package catalog and competitor resources inspected

| Resource | Why it was inspected |
|---|---|
| [Pi package catalog](https://pi.dev/packages) | Package discovery, installation convention and current catalog examples |
| [pi-stats-ext](https://pi.dev/packages/pi-stats-ext) | Usage/cost/cache dashboard alternative |
| [Pi usage packages catalog query](https://pi.dev/packages?name=pi-usage) | Usage-statistics/reporting package alternatives |
| [pi-usage by mtrojnar](https://github.com/mtrojnar/pi-usage) | Provider usage/rate-limit monitoring and installation |
| [pi-usage-dashboard](https://github.com/mralifakbar/pi-usage-dashboard) | Web dashboard for token usage, cost, sessions and installed resources |
| [Stats for Pi / pi-extension-stats](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-stats/README.md) | Token/cost diagnostics and context composition reporting |
| [Apache Magpie Pi harness documentation](https://magpie.apache.org/docs/adapters/pi/) | Permission rules, action guard, OS sandbox and platform caveats |
| [Apache Magpie Pi adapter source](https://apache.googlesource.com/magpie/%2Bshow/5583fbdd25b21428af0840511beac5b92627ce13/docs/adapters/pi.md) | Source-level detail for the Pi adapter security model |
| [CodePi VS Code Marketplace page](https://marketplace.visualstudio.com/items?itemName=lutrarutra.code-pi) | Editor integration, workspace context, edit review, sessions and safety controls |

The live catalog also showed entries such as `pi-subagents`, `context-mode`, `pi-deltabox`, `cc-safety-net`, `pi-mcp-extension`, and `pi-lens`. The catalog is dynamic; use the live catalog to re-check current status rather than treating this list as exhaustive.

## 15.4 Reddit discussions and community resources opened

| Discussion | Why it was inspected |
|---|---|
| [Some tools bloat the context. Why](https://www.reddit.com/r/PiCodingAgent/comments/1tyzsk6/some_tools_bloat_the_context_why/) | Concerns about always-on tool definitions and context growth |
| [Extensions/tools for context retrieval](https://www.reddit.com/r/PiCodingAgent/comments/1w4hefn/extensionstools_for_context_retrieval/) | Demand for relevant file/context retrieval and token savings |
| [I use AI models at least 4 hours per day...](https://www.reddit.com/r/PiCodingAgent/comments/1wps5ha/i_use_ai_models_at_least_4_hours_per_day_and_i/) | User-described context/output shaping practices |
| [Subagent extensions](https://www.reddit.com/r/PiCodingAgent/comments/1vsl06f/subagent_extensions/) | Subagent architecture, permission scoping, complexity and UX |
| [A set of minimal extensions I built for Pi](https://www.reddit.com/r/PiCodingAgent/comments/1xd9oj7/a_set_of_minimal_extensions_i_built_for_pi/) | Modular extension showcase |
| [CodePi: integrated Pi into VS Code](https://www.reddit.com/r/PiCodingAgent/comments/1vkutbq/codepi_i_integrated_pi_coding_agent_into_vscode/) | Developer project-showcase example |
| [r/PiCodingAgent community feed](https://www.reddit.com/r/PiCodingAgent/) | Current topics, adjacent launches and user pain points |
| [r/PiCodingAgent rules](https://www.reddit.com/r/PiCodingAgent/about/rules) | Community requirements to check before posting |

The community feed also surfaced discussions about `One Code`, `pi-context-paging`, `Pi-Bolt`, and context usage. These are community signals; not every linked project was independently audited.

## 15.5 Research limitations

- Reddit comments are self-reported anecdotes, not a representative survey.
- The Pi package catalog changes frequently; examples are a point-in-time snapshot.
- Repository benchmarks are maintained by the project author and were not independently reproduced in this research.
- Search-result summaries are useful discovery evidence, but exact current implementation should be checked before making direct competitive claims.
- The public files/pages listed above were accessed on or around 11 November 2026. Re-check current versions before release decisions.

---

# Final recommendation

Build pi-native around this problem:

**Coding agents are easy to start using, but difficult to operate efficiently and predictably over long development sessions.**

Make useful components easy to adopt through Pi's package manager. Keep the full harness available for developers who want an integrated workstation. Prove the benefits with repeatable end-to-end measurements, describe the security boundary accurately, and use community feedback to decide what to improve.

The adoption path should be:

**Discover one useful feature → try it with one command → keep using it → adopt the complete harness → contribute evidence or code.**
