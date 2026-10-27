# opt-flat-storage

> Use one flat backing store for nested data; avoid `Vec<Vec<T>>` and multi-level indirection

## Why It Matters

Every heap allocation scatters data: a `Vec<Vec<T>>` stores each inner `Vec` at an unpredictable address, so iterating rows chases pointers and pays a cache miss per row before touching a single element. A flat `Vec<T>` plus dimensions keeps all elements contiguous, so the CPU prefetches ahead and the whole dataset costs a handful of cache misses instead of one per row. Nested containers also multiply metadata (`ptr`/`cap`/`len` per inner `Vec`), which bloats memory and cache pressure for free.

Rule of thumb: never require more than one pointer dereference to reach your value.

## Bad

```rust
// Pointer chasing: each row is a separate heap allocation
// at an unpredictable address. N+1 allocations, N cache misses
// just for row metadata.
struct Image {
    pixels: Vec<Vec<f32>>,  // rows scattered across the heap
}

fn sum(image: &Image) -> f32 {
    let mut total = 0.0;
    for row in &image.pixels {
        for px in row {
            total += px;  // pointer dereference per row
        }
    }
    total
}
```

## Good

```rust
// Uniform shape: flat buffer + dimensions. One allocation,
// contiguous iteration, hardware prefetching works.
struct Image {
    pixels: Vec<f32>,
    width: usize,
    height: usize,  // rows inferred from width + len
}

fn sum(image: &Image) -> f32 {
    image.pixels.iter().sum()  // one flat pass
}

// Statically known size: skip the heap entirely.
// A [[f32; 4]; 4] is 64 bytes — one or two cache lines total.
fn transform(m: &mut [[f32; 4]; 4]) {
    for row in m {
        for px in row {
            *px *= 2.0;
        }
    }
}
```

## Jagged Data: Offsets, Not Inner Vecs

```rust
// Jagged rows that don't need independent growth: store
// one flat buffer plus row offsets (CSR layout). Rows are
// slices into contiguous memory.
struct Jagged {
    data: Vec<u32>,
    offsets: Vec<usize>,  // offsets[i]..offsets[i + 1] is row i
}

impl Jagged {
    fn row(&self, i: usize) -> &[u32] {
        &self.data[self.offsets[i]..self.offsets[i + 1]]
    }
}
```

Nested `Vec`s are only justified when inner collections must be both jagged (different sizes) and independently growable at runtime. That combination is rare — reach for it only after profiling proves the need.

## Cost Model

A `Vec<Vec<f32>>` of N rows costs one cache miss per row (metadata) plus misses inside rows; a flat `Vec<f32>` misses only when crossing cache-line boundaries. For a 4x4 matrix that is up to 12 misses versus 4, and `[[f32; 4]; 4]` needs at most 2. You will never compute these numbers for real code — the takeaway is the shape, not the arithmetic: fewer allocations and fewer indirections means the prefetcher can do its job.

## See Also

- [`opt-cache-friendly`](opt-cache-friendly.md) — SoA/AoS and access-order layout
- [`mem-smallvec`](mem-smallvec.md) — inline storage for usually-small collections
- [`mem-boxed-slice`](mem-boxed-slice.md) — shrinking boxed collections
