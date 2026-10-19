# Benchmark + Observability Design for Native Coding-Agent Tools

Scope: the four Rust tools in the pi harness (piread, piedit, pibash, pidx) and their
fail-open ladder — daemon (`--serve`) → one-shot CLI → built-in TS oracle. Every call
records `details.via`; terminal fallbacks emit one telemetry row.

Deliverables below are ordered as requested: metric schema, benchmark matrix, reliability
SLOs, then per-question findings.

---

## 1. Recommended metric schema

Design constraint: emit **one JSONL event per tool call** with zero dependencies, shaped so a
later OTel exporter is a mechanical field-map, not a rewrite. OpenTelemetry's GenAI
conventions model LLM work as spans with `gen_ai.*` attributes and one duration histogram
(`gen_ai.client.operation.duration`) — tool calls are the natural sibling span, so we mirror
that shape and keep our own names until a stable `gen_ai.tool.*` convention exists
(https://opentelemetry.io/blog/2026/genai-observability,
https://mastra.ai/blog/what-is-llm-observability).

### 1.0 Confirming the mapping against the GenAI agent-spans spec

The official GenAI agent-spans document settles the open question from an earlier draft of
this report: **tool calls are recorded as structured events on the span, not as standalone
spans with a bespoke attribute namespace**
(https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md).
The OTel blog states the same shape directly — "messages and tool calls are captured as
structured [events]"
(https://opentelemetry.io/blog/2026/genai-observability). Practical guides describe the same
three-tier split of spans / metrics / events
(https://openobserve.ai/blog/opentelemetry-genai-semantic-conventions), and the concept is
described as a portable trace schema that survives vendor swaps
(https://decagon.ai/glossary/what-are-opentelemetry-genai-semantic-conventions).

Consequences for our schema, which the table in §1.1 already satisfies:

- The **execution attempt** is the event; the enclosing span is the agent/model turn. Our
  `trace_id`/`parent_span_id` already express that nesting.
- The spec imposes **attribute MUST rules** — required attributes are normative, and an
  exporter that omits them produces spans that backends will down-rank or reject
  (https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md).
  This raises the stakes on keeping required fields populated at write time rather than
  synthesizing them at export.
- Because tool calls are events, event **cardinality per span is unbounded** in a multi-tool
  turn. Cap the number of recorded events per span and record a count of the remainder — a
  [uncited] engineering recommendation, not a spec requirement.

Practical effect: the JSONL row shape does not change. What changes is the export path — a
line becomes an *event* appended to the turn span, with only the small normative attribute set
promoted onto the span itself.

### 1.1 Event envelope (JSONL, one line per call)

| Field | Type | Dim/Measure | Notes / OTel mapping |
|---|---|---|---|
| `ts` | RFC3339 string | — | Span start time |
| `span_id` | string | — | OTel `span_id`; random 8-byte hex |
| `trace_id` | string | — | OTel `trace_id`; one per agent turn, shared by chained tool calls |
| `parent_span_id` | string \| null | — | The model-call span that requested the tool |
| `tool` | enum `piread\|piedit\|pibash\|pidx` | **dimension** | → `gen_ai.tool.name` |
| `via` | enum `daemon\|cli\|oracle` | **dimension** | Rung that **served** the call. Keep the existing name; exporter maps to `pi.tool.rung` |
| `attempts` | int | measure | Rungs tried before success (1 = first rung worked) |
| `duration_ms` | float | **measure** | → duration histogram, mirrors `gen_ai.client.operation.duration` (unit s on export) |
| `time_to_first_byte_ms` | float | **measure** | Time from invocation to first output byte; the tool-side analogue of TTFT |
| `queue_ms` | float | measure | Time waiting for daemon slot; separates contention from work |
| `work_ms` | float | measure | `duration_ms - queue_ms` |
| `ok` | bool | dimension | Success of the **served** call |
| `error_class` | enum \| null | dimension | `timeout\|refused\|nonzero_exit\|parse\|oversize\|internal` |
| `fallback_from` | enum \| null | dimension | Rung that failed, when `attempts > 1` |
| `consecutive_fallbacks` | int | measure | Counter value **after** this call |
| `breaker_state` | enum `closed\|open\|half_open` | dimension | Circuit state at call time; keeps `time_to_first_fallback` interpretable |
| `bytes_out` | int | **measure** | Bytes the tool actually produced (post-compaction) |
| `bytes_raw` | int | measure | Bytes before compaction; `bytes_raw == bytes_out` when no compaction |
| `bytes_saved` | int | **measure** | `bytes_raw - bytes_out` (derived, stored for cheap aggregation) |
| `tokens_out_est` | int \| null | measure | `ceil(bytes_out / 4)` — advisory only, see §5 |
| `output_lines` | int | measure | Cheap proxy for "did the model get a wall of text" |
| `truncated` | bool | dimension | Whether a cap was hit (pibash large-output regression) |
| `cold_start` | bool | dimension | pidx: index not resident this session |
| `input_bytes` | int | measure | Request payload size (arg text) — needed for per-call cost |
| `session_id` | string | dimension | Session correlation |
| `model` | string \| null | dimension | `gen_ai.request.model`; **never average across it** |
| `harness_version` | string | dimension | So metric shifts are attributable to releases |

Notes:

- **Do not log in a hot loop.** One row per call, appended with a single `write` to an
  append-only file; buffer in memory and flush on turn boundary to keep the 0.03–0.18 ms
  daemon dispatch win visible rather than eaten by telemetry I/O.
- **Separate failure rows.** A rung attempt that fails should be a field on the final row
  (`fallback_from`, `attempts`), not its own row, except when the ladder fully exhausts — then
  emit the terminal-fallback row you already have, flagged `error_class` + `via:"oracle"` and
  `ladder_exhausted: true`.
- **Derived-at-read, not at-write.** Store `bytes_raw`/`bytes_out`; compute ratios in the
  analysis layer so historical rows stay re-interpretable.

### 1.2 Aggregates (what dashboards actually read)

Per `(tool, via, model)` triple and per session:

1. `p50/p90/p99 duration_ms`, `time_to_first_byte_ms`, and `queue_ms` — latency.
2. `fallback_rate = calls(attempts>1) / calls` — reliability.
3. `max_consecutive_fallbacks` and `time_to_first_fallback` (ms from session start).
4. `share_by_via` — `%` of calls per rung; this is the ladder's "is the fast path actually
   carrying load" metric.
5. `bytes_saved_total` and `bytes_saved_ratio = Σbytes_saved / Σbytes_raw` per tool.
6. `tokens_saved_est` — advisory, never a billing figure.

Cross-model comparison is explicitly out of scope: latency and byte figures are reported
per model and per rung, never averaged (see §2.4).

---

## 2. Benchmark matrix

### 2.1 Axes

| Axis | Values | Rationale |
|---|---|---|
| tool | `piread`, `piedit`, `pibash`, `pidx` | Different cost profiles; pibash is process-bound, pidx is index-bound |
| rung | `daemon`, `cli`, `oracle` | The ladder is the product; a single average hides the cliff |
| output size | 1 MB / 10 MB / 100 MB (pibash only) | Locates the compaction regression knee |
| index state | warm / cold (pidx only) | Cold-start is a user-visible latency spike |
| concurrency | 1, 8 parallel calls | Agent harnesses issue parallel tool calls; contends the daemon |

Cells: `tool × rung × size × state × concurrency`. Empty cells are legitimate (oracle has no
daemon queue) — record them as `n/a`, not zero.

### 2.2 Fixture design

- **Deterministic inputs.** Fixed file trees generated by a checked-in script with a seed;
  same fixture bytes for daemon and oracle runs so `bytes_raw` is comparable.
- **Sized fixtures as real content**, not `/dev/zero`: 1/10/100 MB of line-structured text
  with repeated and unique regions, so compaction exercises both dedupe and truncation paths.
- **A "no-compaction" control** at each size, to isolate the compaction cost from I/O.
- **Failure injection fixtures**: a daemon that hangs (timeout path), a socket that refuses
  (refused path), and an oracle that errors — these produce the fallback rows and must be
  first-class benchmark cases, not an afterthought.
- **Cold pidx**: drop the OS page cache or use a fresh tmp index dir per run; record which
  mechanism was used.

### 2.3 Variance control

- N ≥ 30 iterations per cell; report p50/p90/p99 and the interquartile range, never the mean
  alone. Latency distributions in this regime are right-skewed (dispatch at 0.03–0.18 ms is
  sub-millisecond, so any GC/scheduler noise dominates the mean).
- **Discard warm-up iterations** (≥5) per cell; a "cold" cell must be explicitly reset between
  runs, not merely first-in-sequence.
- Pin CPU frequency / disable turbo where possible; record host fingerprint (kernel, CPU
  model, disk type) in the result header — a sub-millisecond benchmark without host context
  is not reproducible.
- Report **relative** numbers against the daemon rung as the baseline row, so runs on
  different hardware stay comparable.
- Interleave rungs within an iteration (daemon→cli→oracle) rather than running each rung's
  full block, so slow drift affects all rungs equally.

### 2.4 Reporting rules

- Per rung, per tool, per model. **Never** average across models: TTFT and tool latency are
  model-dependent and averaging destroys the signal
  (https://www.together.ai/blog/coding-agent-benchmarks).
- Always print the `via` distribution next to the latency table; a p50 measured on 90% daemon
  and 10% oracle traffic is a blend, and should be labelled as such.
- Include the byte-accounting columns in every latency table — cost is a first-class output,
  not a separate report (https://www.splunk.com/en_us/blog/artificial-intelligence/agent-benchmarks.html).

---

## 3. Reliability SLOs for the fail-open ladder

The ladder is fail-open by design: correctness is preserved by falling back, so the SLO is
about **degradation visibility**, not error rate.

| SLO | Target (proposed) | Alert shape |
|---|---|---|
| Daemon availability | ≥ 95% of calls served by `via=daemon` per session | Warn at <95%, page at <80% |
| Fallback rate (per tool) | ≤ 5% of calls with `attempts>1` | Per-tool, not global — a silent pidx regression must not hide under healthy pibash |
| Consecutive fallbacks | Trip circuit after 3 consecutive `via=cli`/`oracle` | Log once, then suppress until recovery — avoid log storms |
| Time-to-first-fallback | Report only; no target | Sudden drop (seconds after startup) = daemon startup race |
| Oracle share | ≤ 1% of calls | Oracle is correctness net, not capacity; >1% means a bug |
| Restart count | ≤ 1 per session | >1 per session = crash loop |
| pidx cold start | report p95 | Regression gate on release |

**Circuit-breaker mapping.** Three consecutive failures is the standard open-circuit threshold
class; use it as the point to stop *trying* the daemon for a cooldown window (e.g. 30 s or 5
calls) and serve directly from CLI. This converts a per-call timeout penalty into a single
fault at the moment the daemon dies — the user-visible difference is "one slow call" versus
"every call is slow". Reset the breaker on the first daemon success (half-open probe), and log
the transition via `breaker_state` so `time_to_first_fallback` stays interpretable.

**Signals users actually notice.** Ranked by perceived impact, and worth instrumenting
directly: (a) p99 latency of a single tool call, because TTFT/tool latency is what determines
whether a tool "feels fast or broken" (https://www.together.ai/blog/coding-agent-benchmarks);
(b) truncation, which silently degrades reasoning quality rather than erroring — hence
`truncated` as a first-class dimension; (c) repeated identical failures on the same file,
which surface as agent loops. Measure (c) as a streak on `(tool, path)` and alert on ≥3.

**Degradation is not failure.** Keep the ladder fail-open; make every rung change visible in
the row (`via`, `attempts`, `fallback_from`) so a "successful" session that never used the
daemon is still counted as degraded. Otherwise the success metric lies.

---

## 4. Per-question findings

### Q1 — Which latency metrics matter for agent tool calls

Agentic coding benchmarks have converged on reporting **sequence length, task duration, and
reward/verification rate jointly**, because agentic runs are long-horizon:
NVIDIA's write-up of the first agentic-AI coding benchmark emphasizes sequence lengths and
per-task duration as the primary measurement frame rather than per-token throughput
(https://developer.nvidia.com/blog/nvidia-achieves-leading-agentic-coding-performance-on-first-agentic-ai-benchmark).
Artificial Analysis frames coding agents by **real-world, end-to-end** measurement rather than
component micro-benchmarks (https://artificialanalysis.ai/agents/coding-agents).

Transferable to our tools: latency must be reported **at the granularity a user perceives** (a
single tool call, a single turn) and **conditioned on the model driving it**, since the model
determines how many parallel tool calls happen. TTFT is the canonical "feels fast vs broken"
threshold for tool invocation (https://www.together.ai/blog/coding-agent-benchmarks) — for our
native tools the analogue is time-to-first-byte of the tool's output, not total completion
time, because the model starts consuming as soon as bytes arrive.

So: measure `time_to_first_byte_ms` alongside `duration_ms`, and record `parallel_call_count`
per turn. The 0.03–0.18 ms daemon dispatch improvement only matters if it is measured at
dispatch granularity *and* shown not to be swamped by model-side scheduling.

### Q2 — End-to-end vs micro benchmark design for agent environments

Micro benchmarks (our matrix in §2) isolate rungs and reveal the regression knee; they do not
predict agent-level utility. ProjDevBench argues for **extended multi-turn agent–environment
interaction** as the benchmark unit, precisely because single-shot task success misses
accumulated context effects
(https://arxiv.org/html/2602.01655v1).

Design consequence — run both, and keep them separate:

- **Micro tier**: fixture-driven, deterministic, N≥30, no model in the loop. Answers "did rung
  X get slower / did compaction stop working."
- **E2E tier**: real agent sessions on a fixed task set, measuring task completion, turn count,
  tool calls per turn, and total bytes delivered to model. Answers "did the agent get more
  expensive or less reliable."
- **Variance control for E2E**: fixed seed/temperature=0 where available; fixed task ordering;
  repeat ≥3 runs per task because model non-determinism dominates; report per-run spread, and
  never compare E2E numbers across model versions without re-running both.
- **Task selection**: mix tasks that stress each tool — a large-file read, a large-output
  shell command, an index-backed search, a multi-edit session — so per-tool metrics are not
  diluted by tasks that never touch that tool.

Splunk's framing matches: track cost, task completion, and operational efficiency *alongside*
model metrics, not instead of them
(https://www.splunk.com/en_us/blog/artificial-intelligence/agent-benchmarks.html).

### Q3 — OTel GenAI conventions → tool-call observability

Answered normatively in §1.0. The operative points:

- Tool calls are **structured events**, with normative **attribute MUST rules**
  (https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md,
  https://opentelemetry.io/blog/2026/genai-observability).
- `gen_ai.client.operation.duration` remains the canonical **latency histogram**
  (https://opentelemetry.io/blog/2026/genai-observability).
- GenAI metrics include LLM call latency and token consumption
  (https://www.cbinsights.com/company/opentelemetry).
- The span/event schema is deliberately portable across backends, which is exactly why we
  mirror it rather than inventing our own taxonomy
  (https://decagon.ai/glossary/what-are-opentelemetry-genai-semantic-conventions,
  https://openobserve.ai/blog/opentelemetry-genai-semantic-conventions).
- Traces carry a span-per-model-call breakdown with tool calls visible alongside
  (https://mastra.ai/blog/what-is-llm-observability,
  https://www.getmaxim.ai/articles/opentelemetry-for-llm-observability-traces-and-metrics).

Mapping our schema (§1.1): `duration_ms` → duration histogram; `tokens_out_est` → the token
counter family (advisory only); `tool`/`via`/`model` → event/span attributes; `trace_id`/
`parent_span_id` → span linking so a tool call sits under the model call that issued it.

**Why JSONL first.** OTel's Rust SDK adds dependency weight and a runtime — a bad trade for
sub-millisecond dispatch. JSONL with the field names above is losslessly convertible later:
each line becomes one structured event (or a child span, if a backend prefers), `ts`/
`duration_ms` become timestamps, and remaining fields become attributes. Two rules keep that
path open: (1) all dimensions are low-cardinality enums (do **not** put file paths in span
attributes — they explode cardinality; keep paths in a separate, sampled log stream);
(2) durations are stored in ms as floats so unit conversion is a single multiply.

### Q4 — Fallback / reliability SLO patterns

Covered in §3. The pattern with the strongest support in the material is: benchmark autonomous
agents on **operational efficiency** alongside task success
(https://www.splunk.com/en_us/blog/artificial-intelligence/agent-benchmarks.html), which in our
terms means the ladder's rung distribution is itself a benchmark output. A tool suite that is
100% correct but 40% oracle-served is a failing benchmark, and only per-`via` accounting
reveals it.

### Q5 — Cost accounting: bytes/tokens saved as first-class outputs

Treat `bytes_saved` and `bytes_saved_ratio` as benchmark result columns next to latency, per
tool, per rung. Rationale: the ≥94% model-visible byte reduction is the headline win of the
compaction work; if it is not in the same table as latency, regressions trade off invisibly
(faster but bigger output reads as a pure win). Splunk's guidance to track cost alongside model
metrics supports this (https://www.splunk.com/en_us/blog/artificial-intelligence/agent-benchmarks.html).

**Token reduction is a real, measured lever — not just a proxy.** A study of state-in-context
agents on SWE-bench Verified evaluated code minification as a token-reduction technique,
reporting token savings [claim scope verified only at snippet level — see Gaps]
(https://arxiv.org/html/2606.01326v1). AlohaJet reports a 54% token cut measured in Aloha's own
benchmark (https://ppc.land/alohajet-cuts-ai-agent-token-use-54-in-alohas-own-benchmark). Bito
reports success-rate measurement via SWE-Bench Pro with a third-party evaluator
(https://finance.yahoo.com/news/bitos-ai-architect-achieves-highest-150000632.html).

Two caveats that follow from these sources rather than being settled by them:

1. **Report savings and task success together.** Each of these vendors pairs a token/efficiency
   figure with a task-success figure (or an independent evaluator). So should we: a bytes-saved
   number without a task-success number on the same page is not interpretable
   (https://finance.yahoo.com/news/bitos-ai-architect-achieves-highest-150000632.html).
2. **Vendor-benchmark claims are self-measured** unless an independent harness is named —
   AlohaJet's own benchmark is explicitly "Aloha's own"
   (https://ppc.land/alohajet-cuts-ai-agent-token-use-54-in-alohas-own-benchmark). Treat those
   numbers as directional; treat SWE-bench Verified / SWE-Bench Pro results with a named
   evaluator as stronger evidence.

`tokens_out_est` from `bytes/4` remains a proxy. Report bytes as the authoritative figure and
tokens as advisory; if the harness can count model-visible tokens exactly, replace the estimate
rather than maintaining two numbers. [uncited] — the /4 divisor is a rough English-text rule of
thumb, and is worse for code.

---

## 5. Gaps

Closed by this revision (previously open):

- ~~No primary OTel `gen_ai.tool.*` convention verified.~~ Closed: tool calls are structured
  **events** with normative attribute MUST rules
  (https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md).
  Residual: the exact required-attribute list should be transcribed from the spec page into an
  exporter checklist before any export code is written.
- ~~Compaction's effect on agent quality unaddressed.~~ Partially closed: token-reduction
  techniques are now empirically evaluated against SWE-bench Verified
  (https://arxiv.org/html/2606.01326v1), with commercial systems pairing token cuts to
  task-success figures (https://ppc.land/alohajet-cuts-ai-agent-token-use-54-in-alohas-own-benchmark,
  https://finance.yahoo.com/news/bitos-ai-architect-achieves-highest-150000632.html). Residual:
  none of these evaluate *our* compaction, and the arXiv figure was read at snippet level only
  (see below).

Remaining open:

- **arXiv 2606.01326 claims are snippet-level only.** The paper was read as a snippet, not in
  full; the specific token-reduction magnitude should be quoted only after reading the
  abstract/results directly. Do not cite a number from it in a results table yet.
- **Sub-millisecond measurement methodology unverified.** The 0.03–0.18 ms dispatch figures
  need a stated measurement harness (clock source, warm-up policy, host) before they are
  defensible; no source here addresses benchmarking at that scale.
- **TTFT framing is LLM-side.** Applying it to tool output is an analogue, not a cited result.
- **ProjDevBench details** are summarized from an abstract-level reading; its task-selection
  and variance methodology was not read in full.
- **No source on log-storm suppression / breaker cooldown tuning**; the 3-consecutive / 30 s
  values are [uncited] engineering defaults, not measured. Half-open probe timing likewise
  [uncited].
- **No source compares byte-savings methodologies directly** (minification vs. our
  compaction); the numbers are not comparable across techniques.

---

## Sources

1. [NVIDIA — leading agentic coding performance on first agentic AI benchmark](https://developer.nvidia.com/blog/nvidia-achieves-leading-agentic-coding-performance-on-first-agentic-ai-benchmark) — agentic benchmark methodology, sequence lengths, per-task duration.
2. [Artificial Analysis — Coding Agents](https://artificialanalysis.ai/agents/coding-agents) — real-world, end-to-end agent measurement framing.
3. [ProjDevBench (arXiv)](https://arxiv.org/html/2602.01655v1) — extended multi-turn agent–environment interaction as the benchmark unit.
4. [Together AI — Coding agent benchmarks](https://www.together.ai/blog/coding-agent-benchmarks) — TTFT as the "feels fast vs broken" threshold.
5. [Splunk — Agent benchmarks](https://www.splunk.com/en_us/blog/artificial-intelligence/agent-benchmarks.html) — cost, task completion, and operational efficiency as co-equal benchmark outputs.
6. [Maxim — OpenTelemetry for LLM observability](https://www.getmaxim.ai/articles/opentelemetry-for-llm-observability-traces-and-metrics) — traces/spans/metrics structure for LLM calls.
7. [Mastra — What is LLM observability](https://mastra.ai/blog/what-is-llm-observability) — span-by-span breakdown with model calls and tool calls as sibling spans.
8. [OpenTelemetry blog — GenAI observability](https://opentelemetry.io/blog/2026/genai-observability) — `gen_ai.client.operation.duration` histogram; tool calls captured as structured events.
9. [CB Insights — OpenTelemetry](https://www.cbinsights.com/company/opentelemetry) — LLM call latency and token consumption as GenAI metrics.
10. [OpenTelemetry semantic-conventions-genai — Agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) — normative spec: tool calls as structured events, attribute MUST rules.
11. [OpenObserve — OpenTelemetry GenAI semantic conventions](https://openobserve.ai/blog/opentelemetry-genai-semantic-conventions) — practical guide to the span/metric/event set.
12. [Decagon — What are OTel GenAI semantic conventions](https://decagon.ai/glossary/what-are-opentelemetry-genai-semantic-conventions) — portable trace schema overview.
13. [arXiv — Reducing Token Usage of State-in-Context Agents using Minification](https://arxiv.org/html/2606.01326v1) — empirical token-reduction evaluation on SWE-bench Verified (snippet-level read).
14. [PPC Land — AlohaJet 54% token cut](https://ppc.land/alohajet-cuts-ai-agent-token-use-54-in-alohas-own-benchmark) — vendor self-measured token reduction; example of self-benchmark caveat.
15. [Yahoo Finance — Bito AI architect, SWE-Bench Pro](https://finance.yahoo.com/news/bitos-ai-architect-achieves-highest-150000632.html) — success-rate measurement via third-party evaluator.
