# opt-ilp

> Structure hot computations as independent chains so the CPU and compiler can parallelize them

## Why It Matters

The CPU executes more than one instruction at a time whenever two instructions do not share a register — instruction-level parallelism (ILP) is free parallelism with no locks, queues, or architecture changes. A serial dependency chain (`acc = acc OP x` per iteration) forfeits it: every step waits on the previous one. Independent chains also enable autovectorization, where the compiler emits one SIMD instruction that applies the same operation to several values at once.

## Bad

```rust
// One long dependency chain: each multiply-add waits on the
// previous addition. Multiplications could have run in parallel.
fn dot_serial(a: &[f64], b: &[f64]) -> f64 {
    let mut acc = 0.0;
    for i in 0..a.len() {
        acc += a[i] * b[i];  // acc is the bottleneck
    }
    acc
}
```

## Good

```rust
// Four independent chains: the multiplies/adds for each lane
// overlap, and the compiler can vectorize. Lanes are summed
// once at the end.
fn dot_ilp(a: &[f64], b: &[f64]) -> f64 {
    let mut acc = [0.0f64; 4];
    for (xs, ys) in a.chunks(4).zip(b.chunks(4)) {
        for (lane, (&x, &y)) in xs.iter().zip(ys).enumerate() {
            acc[lane] += x * y;
        }
    }
    acc.iter().sum()
}
```

## Restructure Folds with Algebra

Use the distributive and associative laws to break dependency chains. Parsing an integer digit-by-digit multiplies the accumulator by the radix each step (a serial chain); iterating backwards with a running multiplier keeps the multiplications independent — only the final addition depends on the previous iteration, and addition is cheap.

```rust
// Forward: output *= radix each step — one serial chain.
// Backwards: mul *= radix is independent of output;
// digit * mul can overlap across iterations.
fn parse_digits_backwards(bytes: &[u8]) -> u64 {
    let mut output = (bytes[bytes.len() - 1] - b'0') as u64;
    let mut mul = 1;
    for &byte in bytes[..bytes.len() - 1].iter().rev() {
        mul *= 10;
        output += (byte - b'0') as u64 * mul;  // mul is independent
    }
    output
}
```

The same idea generalizes: sum into several accumulators and combine at the end; compute per-lane results separately; group work so each iteration's expensive operations do not read what the previous iteration wrote.

## Make Hot Functions Pure

A function in a tight loop should be pure — inputs in, output out, no reads or writes through shared references. Purity removes indirect memory traffic, exposes ILP to the compiler, and makes the function trivial to benchmark. When tuning: write a representative benchmark, change one thing, re-run, repeat — treating benchmarks the way tests treat assertions.

## See Also

- [`opt-simd-portable`](opt-simd-portable.md) — explicit vector types
- [`opt-registers`](opt-registers.md) — keeping chains in registers
- [`perf-black-box-bench`](perf-black-box-bench.md) — honest benchmark harnesses
