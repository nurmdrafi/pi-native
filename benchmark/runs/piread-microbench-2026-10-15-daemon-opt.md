# piread micro-bench — daemon hot-path optimization (2026-10-15, second session)

Host linux x64 · node v24.21.0 · piread 0.2.0 · N=200/arm (10 warmup) · local wall-clock.
Follow-up to `piread-microbench-2026-10-15.md` (first session, commit `eedeb8a`); spec §5.2 daemon amendment.

## Goal

Close the only regression vs the built-in (`bytes60k`, +0.28 ms in the first-session report) and cut the largest absolute daemon latency (`lines2500`, 0.84 ms). Keep parity untouchable: 150/150 parity, 54 cargo tests (+2 new), gate 241/241, typecheck, doc:check.

## What was changed (all measured keepers)

1. **`HeadTruncator`: single in-place buffer** (`pipeline.rs`) — was `Vec<String>` (one allocation per line) + `join("\n")` **twice** (`finalize` builds `truncation.content`, `selection_prefix` rebuilds the identical prefix). Now one `String`, presized to the byte cap, joined incrementally; `selection_prefix` returns `&str` (zero copy). Removes N allocations + 2 full-content copies per read.
2. **Daemon response buffer reuse + single write** (`serve.rs`) — responses serialize straight into one `Vec<u8>` reused across requests (capacity ratchets), newline appended in-buffer, one `write_all` per response. No per-response `String`, no `writeln!` format pass.
3. **Hand-rolled envelope writer with SWAR escape scan** (`envelope.rs`) — serde's per-byte escape scan measured ~0.8 GB/s and is paid **twice** per truncated response (`content` + `truncation.content` — the latter is parity-pinned: the built-in's `details.truncation` carries its own content copy, so the wire ships ~2× the prefix). The writer skips clean 8-byte words with SWAR zero-tests, scans flagged words byte-wise against serde's escape table, and bails to a serde-identical loop after 4 consecutive dirty words (escape-dense text). Byte-identical to serde_json — pinned by a new exhaustive unit test (every single byte + corpus + randomized) and an oracle test comparing hand-rolled envelopes against the serde derives (kept `#[cfg(test)]` as the reference shape).

Attribution probes that drove this (throwaway, not committed): in-process release timing split `read_text` vs serialization; strace confirmed one 103 KB write syscall per bytes60k response (no fragmentation); raw-daemon sequential roundtrips isolated the ~0.083 ms scheduling floor and the ~0.10 ms Node-side `JSON.parse` of the 103 KB envelope line.

## Before / after (p50 ms, daemon arm vs oracle arm)

First-session report (commit `eedeb8a`) → this session, two confirmation runs (same host, one day later — oracle itself moved between sessions, so Δ is the honest comparator):

| corpus | report before | Δ before | post-opt run A | Δ A | post-opt run B | Δ B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| one-line | 0.14 / 0.56 | −0.42 | 0.079 / 0.296 | −0.22 | 0.114 / 0.304 | −0.19 |
| crlf | 0.08 / 0.47 | −0.39 | 0.057 / 0.272 | −0.22 | 0.072 / 0.292 | −0.22 |
| unicode | 0.08 / 0.34 | −0.26 | 0.074 / 0.289 | −0.22 | 0.060 / 0.277 | −0.22 |
| long-lines | 0.11 / 0.41 | −0.30 | 0.116 / 0.425 | −0.31 | 0.089 / 0.263 | −0.17 |
| lines2500 | 0.84 / 1.44 | −0.60 | 0.886 / 1.696 | −0.81 | 0.505 / 1.393 | −0.89 |
| **bytes60k** | 1.10 / 0.82 | **+0.28** | 0.680 / 0.684 | **−0.004** | 0.703 / 0.629 | **+0.074** |
| head60k | 0.21 / 0.49 | −0.28 | 0.244 / 0.458 | −0.21 | 0.238 / 0.416 | −0.18 |

Same-session pre-change baseline (this host, before today's edits): bytes60k Δ +0.278 → post-fast-writer Δ ≤ +0.074; lines2500 daemon 0.582 → 0.505.

- **bytes60k regression: closed.** Residual Δ oscillates around zero (−0.004 / +0.074 across runs ≈ the harness noise floor). What remains is structural: Node-side `JSON.parse` of the ~103 KB envelope (~0.10 ms measured) and std UTF-8 validation (~1 GB/s, 64 µs for the 60 KB file) — both parity/protocol-pinned (the envelope ships `content` + `truncation.content` because the built-in's own result does; validation is required for decoded-byte accounting).
- **lines2500: 0.84 → 0.505 ms** (best-case run; 0.886 on a globally slow host where the oracle itself ran 1.70 vs 0.98) — still 1.6–2.8× faster than the built-in.
- Small classes unchanged within noise (all daemon-favored by ≥ 3×).
- Spawn floor p50 3.4–3.6 ms (unchanged; paid once per session). Daemon RSS (VmHWM) 2 MB (unchanged). One-shot arm 3.1–5.7 ms — the daemon removes the 3.4 ms floor from every call.

## Remaining trade-offs

- The 2× prefix transport (`content` + `truncation.content`) is pinned by result parity with the built-in's `details.truncation`; closing it would require protocol or parity changes (out of scope).
- `String::from_utf8_lossy` per line stays: decoded-byte accounting needs validation, and safe std has no zero-cost `&[u8] → &str` path. A SIMD-validation crate could shave ~50 µs on bytes60k but adds a dependency for one class.
- The hand-rolled envelope writer is guarded by byte-exactness tests against the serde derives; the derives are kept `#[cfg(test)]` as the living oracle.

Raw auto-report of the final confirmation run: `piread-microbench-2026-10-15.md` (overwritten in place by the bench harness; numbers transcribed above).
