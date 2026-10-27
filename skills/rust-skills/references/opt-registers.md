# opt-registers

> Keep hot mutable state in local variables; minimize writes through pointers

## Why It Matters

Registers are the fastest storage on the machine, and — more importantly — data the compiler can prove lives in registers can be reordered and optimized freely. Reads and writes through pointers have ordering restrictions that block optimization; a hot loop that accumulates into a local gets register-allocated, a hot loop that writes through `&mut` parameters passed down through layers of functions usually does not (unless every layer is inlined). The fewer runtime pointer writes, the more rustc/LLVM can assume about access patterns.

This is a performance extension of a readability rule: clean, boring, local code is also the easiest code for the compiler to optimize.

## Bad

```rust
struct Accumulator {
    total: u64,
    count: usize,
}

fn tally_bad(acc: &mut Accumulator, xs: &[u64]) {
    // Every iteration writes through &mut — an aliased,
    // potentially non-local location. The compiler must be
    // conservative about reordering anything around it.
    for &x in xs {
        bump(acc, x);
    }
}

fn bump(acc: &mut Accumulator, x: u64) {
    acc.total = acc.total.wrapping_add(x);
    acc.count += 1;
}
```

## Good

```rust
fn tally_good(acc: &mut Accumulator, xs: &[u64]) {
    // Accumulate in locals — register candidates — and write
    // through the pointer exactly once at the end.
    let mut total = acc.total;
    let mut count = acc.count;
    for &x in xs {
        total = total.wrapping_add(x);
        count += 1;
    }
    acc.total = total;
    acc.count = count;
}
```

The compiler may make this transformation itself when it can inline everything, but do not rely on inlining through deep call chains: keep the discipline in code you know is hot.

## Rules of Thumb

- A mutable loop counter or running total in a local is ideal register state.
- Mutating `self.field` or dereferencing `&mut` inside a tight loop is a pointer write per iteration; hoist to a local, write back after the loop.
- Returning a value beats mutating through an out-parameter for hot helpers — callers can keep the result in a register.
- Shared state behind `Rc<RefCell<...>>`, atomics, or channels forces every access to memory; keep hot paths free of them.

## See Also

- [`opt-ilp`](opt-ilp.md) — independent chains of register state
- [`opt-cache-friendly`](opt-cache-friendly.md) — locality for data that must live in memory
