# opt-loop-unroll

> Let the compiler unroll loops; unroll manually only to remove redundant per-iteration work

## Why It Matters

Optimizing compilers unroll loops automatically, so hand-mangled "unrolled" code usually just hurts readability for zero gain — or regresses after breaking the compiler's loop analysis. Manual unrolling pays off in exactly two situations: when chunking lets the compiler treat the body as a fixed-size array operation, and when the per-iteration housekeeping (computing loop-dependent values) costs more than the body itself.

## Don't: Generic Manual Unrolling

```rust
// Pointless: rustc/LLVM already does this, and the manual
// version blocks further loop analysis.
fn sum(xs: &[u64]) -> u64 {
    let mut total = 0;
    let mut i = 0;
    while i + 4 <= xs.len() {
        total += xs[i];            // unrolled by hand,
        total += xs[i + 1];        // optimized by nobody,
        total += xs[i + 2];        // maintained by you
        total += xs[i + 3];
        i += 4;
    }
    while i < xs.len() {
        total += xs[i];
        i += 1;
    }
    total
}
```

## Do: Chunk Into Fixed-Size Arrays

```rust
// If the length is a multiple of N, iterate fixed-size blocks.
// Each body sees a [T; 4] — a constant-size slice the compiler
// can vectorize aggressively — with N/4 loop-variable updates
// instead of N.
fn sum_blocks(xs: &[u64]) -> u64 {
    let mut total = 0;
    for block in xs.chunks_exact(4) {
        // block: &[u64; 4] via try_into, or a 4-element slice
        total += block.iter().sum::<u64>();
    }
    total += xs.chunks_exact(4).remainder().iter().sum::<u64>();
    total
}
```

For a true `&[[T; N]]` view over a buffer, use a safe transmute crate (for example `bytemuck`) — never raw pointer casts.

## Do: Unroll to Reduce Operation Strength

When computing a per-iteration value costs more than the body, unroll so the expensive operation runs less often. Integer logarithm: each naive iteration divides (`expensive`) just to test `n < base` (`cheap`), so batch four steps per division and pre-multiply the thresholds — comparisons and multiplications are cheap, division is not.

```rust
fn log_base(mut n: usize, base: usize) -> usize {
    let mut out = 1;
    loop {
        if n < base {
            return out;
        }
        out += 1;
        n /= base;  // division dominates the tiny body
    }
}

fn log_base_unrolled(mut n: usize, base: usize) -> usize {
    // Pre-multiplied thresholds: compare (cheap) instead of
    // divide (expensive). One division per four steps.
    let thresholds = [base, base * base, base * base * base];
    let step = base * base * base * base;
    let mut out = 1;
    while n >= step {
        n /= step;
        out += 4;
    }
    for t in thresholds {
        if n < t {
            return out;
        }
        out += 1;
    }
    out
}
```

Verify with a benchmark and `assert_eq!` against the naive version — boundary behavior (exact powers of the base especially) is where hand-rolled variants go wrong, and strength-reduction unrolling is a hypothesis until measured.

## See Also

- [`opt-ilp`](opt-ilp.md) — restructuring folds for parallelism
- [`perf-black-box-bench`](perf-black-box-bench.md) — honest benchmark harnesses
