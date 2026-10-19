# Tool-call observability schema

One JSONL event per tool call, zero dependencies, OTel-GenAI field-map-ready. Per the GenAI agent-spans spec, tool calls are structured EVENTS on the turn span, not standalone spans (source: open-telemetry/semantic-conventions-genai gen-ai-agent-spans.md); cap events per span and record a remainder count [uncited rec].

## Event envelope (one line per call)

| Field | Type | Dim/Measure | Notes / OTel mapping |
| --- | --- | --- | --- |
| ts | RFC3339 string | — | Span start time |
| span_id | string | — | OTel span_id; random 8-byte hex |
| trace_id | string | — | OTel trace_id; one per agent turn, shared by chained tool calls |
| parent_span_id | string \| null | — | The model-call span that requested the tool |
| tool | enum piread\|piedit\|pibash\|pidx | dimension | → gen_ai.tool.name |
| via | enum daemon\|cli\|oracle | dimension | Rung that SERVED the call; exporter maps to pi.tool.rung |
| attempts | int | measure | Rungs tried before success (1 = first rung worked) |
| duration_ms | float | measure | → duration histogram, mirrors gen_ai.client.operation.duration (unit s on export) |
| time_to_first_byte_ms | float | measure | Invocation to first output byte; tool-side TTFT |
| queue_ms | float | measure | Time waiting for daemon slot; separates contention from work |
| work_ms | float | measure | duration_ms − queue_ms |
| ok | bool | dimension | Success of the served call |
| cold_start | bool | dimension | Call paid a spawn/warm-up cost (fresh daemon, new CLI process, cold index) [uncited] |
| input_bytes | int | measure | Size of the request payload handed to the tool [uncited] |
| session_id | string | dimension | Groups rows into one agent session [uncited] |
| model | string | dimension | Model that requested the call; group-by key only — never average across it [uncited] |
| harness_version | string | dimension | Version of the emitting harness; gates cross-version comparison [uncited] |
| bytes_raw | int | measure | Bytes produced before compaction; stored so ratios stay derived-at-read [uncited] |
| bytes_out | int | measure | Bytes delivered to the model after compaction [uncited] |
| bytes_saved | int | measure | bytes_raw − bytes_out; feeds bytes_saved_total and bytes_saved_ratio [uncited] |
| error_class | string \| null | dimension | Terminal failure taxonomy; null on success [uncited] |
| fallback_from | string \| null | dimension | Failed rung(s) preceding the served rung; null when attempts = 1 [uncited] |
| ladder_exhausted | bool | dimension | true on the terminal-fallback row: error_class + via:"oracle" after every rung failed [uncited] |

## Write-time rules

- No logging in a hot loop: one row per call, single write to an append-only file; buffer in memory, flush on turn boundary so the 0.03–0.18 ms daemon dispatch win stays visible.
- Separate failure rows: a failed rung attempt is a field on the final row (fallback_from, attempts), not its own row; full ladder exhaustion emits the terminal-fallback row with error_class + via:"oracle" + ladder_exhausted:true.
- Derived-at-read: store bytes_raw/bytes_out; compute ratios in analysis so historical rows stay re-interpretable.

## Aggregates (per (tool, via, model) and per session)

1. p50/p90/p99 of duration_ms, time_to_first_byte_ms, queue_ms.
2. fallback_rate = calls(attempts>1)/calls.
3. max_consecutive_fallbacks, time_to_first_fallback.
4. share_by_via (% of calls per rung — "is the fast path carrying load").
5. bytes_saved_total, bytes_saved_ratio = Σbytes_saved/Σbytes_raw per tool.
6. tokens_saved_est (advisory, never billing).

Cross-model averaging is out of scope — per model, per rung only.

## Benchmark fixtures (§2.2 of the design)

- Deterministic inputs: fixed file trees from a checked-in seeded script; identical fixture bytes for daemon and oracle arms.
- Sized fixtures as REAL content (not /dev/zero): 1/10/100 MB of line-structured text with repeated AND unique regions so compaction exercises dedupe and truncation.
- A no-compaction control at each size (isolate compaction cost from I/O).
- Failure injection first-class: hanging daemon (timeout path), refused socket, erroring oracle — these produce the fallback rows.
- Cold pidx: fresh tmp index dir per run (record the mechanism; true page-cache drop needs privileges).

## Sources

- research/benchmark-observability.md (approved design; tables above copied verbatim)
- OTel GenAI agent-spans spec: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
- OTel GenAI blog: https://opentelemetry.io/blog/2024/otel-generative-ai/
