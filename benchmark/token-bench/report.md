# Token Benchmark Report — Tool-Path Comparison

All variants run the identical task (`src/auth.ts` bugfix + regression test + commit). Metric per run is the sum across all assistant messages in the session log.

## Run-level results

| variant | rep | turns | toolCalls | input | output | cacheRead | cacheWrite | reasoning | totalTokens | cost(USD) |
|---------|-----|-------|-----------|-------|--------|-----------|------------|-----------|-------------|-----------|
| codemode | r1 | 12 | pibash×10 piread×2 piedit×1 write×1 | 5718 | 2992 | 56448 | 0 | 0 | 65158 | 0.00564 |
| codemode | r2 | 13 | pibash×10 piread×3 piedit×2 write×1 | 5733 | 2610 | 66048 | 0 | 0 | 74391 | 0.00525 |
| codemode | r3 | 15 | codemode×5 pibash×4 piread×2 piedit×2 write×1 | 7282 | 3997 | 95744 | 0 | 0 | 107023 | 0.00756 |
| codemode-gate | r1 | 16 | codemode×3 piedit×3 piread×2 pibash×6 write×1 | 6929 | 2979 | 89344 | 0 | 0 | 99252 | 0.00619 |
| codemode-gate | r2 | 17 | pibash×13 piread×2 piedit×2 write×1 | 6127 | 3299 | 92800 | 0 | 0 | 102226 | 0.00635 |
| codemode-gate | r3 | 12 | codemode×9 piedit×2 | 5247 | 2652 | 61440 | 0 | 0 | 69339 | 0.00513 |
| direct | r1 | 10 | pibash×8 piread×2 piedit×2 | 3990 | 2033 | 38272 | 0 | 0 | 44295 | 0.00387 |
| direct | r2 | 14 | pibash×13 piread×1 piedit×2 | 3570 | 3019 | 59520 | 0 | 0 | 66109 | 0.00505 |
| direct | r3 | 12 | pibash×9 piread×2 piedit×2 | 4729 | 2613 | 50176 | 0 | 0 | 57518 | 0.00486 |
| gate-block | r1 | 8 | pibash×6 piread×3 piedit×2 | 2230 | 1737 | 29312 | 0 | 0 | 33279 | 0.00293 |
| gate-block | r2 | 19 | pibash×14 piread×5 piedit×2 | 5733 | 3044 | 90752 | 0 | 0 | 99529 | 0.00592 |
| gate-block | r3 | 16 | pibash×12 piread×3 piedit×3 | 4975 | 2967 | 73216 | 0 | 0 | 81158 | 0.00549 |
| gate-on | r1 | 17 | pibash×10 piedit×4 piread×2 | 3740 | 3780 | 81152 | 0 | 0 | 88672 | 0.00614 |
| gate-on | r2 | 33 | pibash×30 piread×4 piedit×2 | 9174 | 5374 | 224896 | 0 | 0 | 239444 | 0.01055 |
| gate-on | r3 | 12 | pibash×9 piread×2 piedit×2 | 3972 | 2219 | 46464 | 0 | 0 | 52655 | 0.00413 |

## Per-variant aggregate (mean)

| variant | n | turns | input | output | cacheRead | cacheWrite | totalTokens | cost | turn1 input |
|---------|---|-------|-------|--------|-----------|------------|-------------|------|-------------|
| codemode | 3 | 13.3 | 6244 | 3200 | 72747 | 0.0 | 82191 | 0.0 | 2338 |
| codemode-gate | 3 | 15.0 | 6101 | 2977 | 81195 | 0.0 | 90272 | 0.0 | 2431 |
| direct | 3 | 12.0 | 4096 | 2555 | 49323 | 0.0 | 55974 | 0.0 | 1040 |
| gate-block | 3 | 14.3 | 4313 | 2583 | 64427 | 0.0 | 71322 | 0.0 | 1031 |
| gate-on | 3 | 20.7 | 5629 | 3791 | 117504 | 0.0 | 126924 | 0.0 | 1089 |

## Delta vs direct (baseline) — mean totalTokens

- direct baseline: 55974 tokens, $0.00459

- codemode: 82191 tokens (+26217, +46.8%), $0.00615
- codemode-gate: 90272 tokens (+34298, +61.3%), $0.00589
- gate-block: 71322 tokens (+15348, +27.4%), $0.00478
- gate-on: 126924 tokens (+70950, +126.8%), $0.00694

## Conclusion (median-based; medians are robust to the gate-on r2 loop outlier)

| variant | median totalTokens | delta vs direct |
|---------|--------------------|-----------------|
| codemode | 74391 | +16873 (+29.3%) |
| codemode-gate | 99252 | +41734 (+72.6%) |
| direct | 57518 | +0.0 (+0.0%) |
| gate-block | 81158 | +23640 (+41.1%) |
| gate-on | 88672 | +31154 (+54.2%) |

- **H1 (codemode overhead):** codemode median 74391 vs direct 57518 = +16873 tokens (29.3%). Bulk tool output *does* stay out of conversation context, but the codemode schema/prompt fixed cost is real and net-positive at this task size.
- **H2 (direct re-entry):** direct spends its tokens on tool results re-entering context; its totals are the *lowest* here, so pure direct-call re-entry is cheaper than codemode orchestration for a small multi-step task. H2's premise (direct is costlier) is *not* supported at this scale.
- **H3 (gate retry loops):** gate-block median 81158 shows the commitlint hook fired and forced one re-plan (observed in session: blocked -> re-wrap -> re-commit). gate-on's mean is inflated by an r2 loop (33 turns); its median 88672 is the fairer 'gate present, compliant' baseline.
