# Rust Rule Quick Reference

Full list of all 269 rules across 26 categories, linked to their individual rule files.

## 1. Ownership & Borrowing (CRITICAL)

- [`own-borrow-over-clone`](own-borrow-over-clone.md) - Prefer `&T` borrowing over `.clone()`
- [`own-slice-over-vec`](own-slice-over-vec.md) - Accept `&[T]` not `&Vec<T>`, `&str` not `&String`
- [`own-cow-conditional`](own-cow-conditional.md) - Use `Cow<'a, T>` for conditional ownership
- [`own-arc-shared`](own-arc-shared.md) - Use `Arc<T>` for thread-safe shared ownership
- [`own-rc-single-thread`](own-rc-single-thread.md) - Use `Rc<T>` for shared ownership in single-threaded contexts
- [`own-refcell-interior`](own-refcell-interior.md) - Use `RefCell<T>` for interior mutability in single-threaded code
- [`own-mutex-interior`](own-mutex-interior.md) - Use `Mutex<T>` for interior mutability across threads
- [`own-rwlock-readers`](own-rwlock-readers.md) - Use `RwLock<T>` when reads significantly outnumber writes
- [`own-copy-small`](own-copy-small.md) - Implement `Copy` for small, simple types
- [`own-clone-explicit`](own-clone-explicit.md) - Use explicit `Clone` for types where copying has meaningful cost
- [`own-move-large`](own-move-large.md) - Move large types instead of copying; use `Box` if moves are expensive
- [`own-lifetime-elision`](own-lifetime-elision.md) - Rely on lifetime elision rules; add explicit lifetimes only when required

## 2. Error Handling (CRITICAL)

- [`err-thiserror-lib`](err-thiserror-lib.md) - Use `thiserror` for library error types
- [`err-anyhow-app`](err-anyhow-app.md) - Use `anyhow` for application error handling
- [`err-result-over-panic`](err-result-over-panic.md) - Return `Result<T, E>` instead of panicking for recoverable errors
- [`err-context-chain`](err-context-chain.md) - Add context with `.context()` or `.with_context()`
- [`err-no-unwrap-prod`](err-no-unwrap-prod.md) - Avoid `unwrap()` in production code; use `?`, `expect()`, or handle errors
- [`err-expect-bugs-only`](err-expect-bugs-only.md) - Use `expect()` only for invariants that indicate bugs, not user errors
- [`err-question-mark`](err-question-mark.md) - Use `?` operator for clean propagation
- [`err-from-impl`](err-from-impl.md) - Implement `From<E>` for error conversions to enable `?` operator
- [`err-source-chain`](err-source-chain.md) - Preserve error chains with `#[source]` or `source()` method
- [`err-lowercase-msg`](err-lowercase-msg.md) - Start error messages lowercase, no trailing punctuation
- [`err-doc-errors`](err-doc-errors.md) - Document error conditions with `# Errors` section in doc comments
- [`err-custom-type`](err-custom-type.md) - Define custom error types for domain-specific failures

## 3. Memory Optimization (CRITICAL)

- [`mem-with-capacity`](mem-with-capacity.md) - Use `with_capacity()` when size is known
- [`mem-smallvec`](mem-smallvec.md) - Use `SmallVec` for usually-small collections
- [`mem-arrayvec`](mem-arrayvec.md) - Use `ArrayVec<T, N>` for fixed-capacity collections that never heap-allocate
- [`mem-box-large-variant`](mem-box-large-variant.md) - Box large enum variants to reduce overall enum size
- [`mem-boxed-slice`](mem-boxed-slice.md) - Use `Box<[T]>` instead of `Vec<T>` for fixed-size heap data
- [`mem-thinvec`](mem-thinvec.md) - Use `ThinVec<T>` for nullable collections with minimal overhead
- [`mem-clone-from`](mem-clone-from.md) - Use `clone_from()` to reuse allocations when repeatedly cloning
- [`mem-reuse-collections`](mem-reuse-collections.md) - Clear and reuse collections instead of creating new ones in loops
- [`mem-avoid-format`](mem-avoid-format.md) - Avoid `format!()` when string literals work
- [`mem-write-over-format`](mem-write-over-format.md) - Use `write!()` into existing buffers instead of `format!()` allocations
- [`mem-arena-allocator`](mem-arena-allocator.md) - Use arena allocators for batch allocations
- [`mem-zero-copy`](mem-zero-copy.md) - Use zero-copy patterns with slices and `Bytes`
- [`mem-compact-string`](mem-compact-string.md) - Use compact string types for memory-constrained string storage
- [`mem-smaller-integers`](mem-smaller-integers.md) - Use appropriately-sized integers to reduce memory footprint
- [`mem-assert-type-size`](mem-assert-type-size.md) - Use static assertions to guard against accidental type size growth
- [`mem-take-replace`](mem-take-replace.md) - Use `mem::take` / `mem::replace` to move a value out of a `&mut` without cloning
- [`mem-drop-order`](mem-drop-order.md) - Know and control drop order: struct fields drop top-to-bottom, locals in reverse

## 4. Unsafe Code (CRITICAL)

- [`unsafe-safety-comment`](unsafe-safety-comment.md) - Write a `// SAFETY:` comment above every `unsafe` block and a `# Safety` section in every `unsafe fn`.
- [`unsafe-minimize-scope`](unsafe-minimize-scope.md) - Keep `unsafe` blocks as small as possible — mark only the operation that requires unsafety, not the surrounding safe code.
- [`unsafe-miri-ci`](unsafe-miri-ci.md) - Run `cargo miri test` in CI for every crate that contains `unsafe` code.
- [`unsafe-maybeuninit`](unsafe-maybeuninit.md) - Use `MaybeUninit<T>` for uninitialized memory; never use `mem::uninitialized()` or `mem::zeroed()` for types with validity invariants.
- [`unsafe-extern-block`](unsafe-extern-block.md) - In Rust 2024, wrap `extern` blocks in `unsafe extern { }` and annotate each item as `safe` or `unsafe`.
- [`unsafe-send-sync-manual`](unsafe-send-sync-manual.md) - Document the invariants when manually implementing `Send` or `Sync`; prefer letting the compiler derive them automatically.
- [`unsafe-no-mangle-unsafe`](unsafe-no-mangle-unsafe.md) - In Rust 2024, write `#[unsafe(no_mangle)]`, `#[unsafe(export_name = "...")]`, and `#[unsafe(link_section = "...")]` — not the bare attribute forms.

## 5. API Design (HIGH)

- [`api-builder-pattern`](api-builder-pattern.md) - Use Builder pattern for complex construction
- [`api-builder-must-use`](api-builder-must-use.md) - Mark builder methods with `#[must_use]` to prevent silent drops
- [`api-newtype-safety`](api-newtype-safety.md) - Use newtypes to prevent mixing semantically different values
- [`api-typestate`](api-typestate.md) - Use typestate pattern to encode state machine invariants in the type system
- [`api-sealed-trait`](api-sealed-trait.md) - Use sealed traits to prevent external implementations while allowing use
- [`api-extension-trait`](api-extension-trait.md) - Use extension traits to add methods to external types
- [`api-parse-dont-validate`](api-parse-dont-validate.md) - Parse into validated types at boundaries
- [`api-impl-into`](api-impl-into.md) - Accept `impl Into<T>` for flexible APIs, implement `From<T>` for conversions
- [`api-impl-asref`](api-impl-asref.md) - Use `AsRef<T>` when you only need to borrow the inner data
- [`api-must-use`](api-must-use.md) - Mark types and functions with `#[must_use]` when ignoring results is likely a bug
- [`api-non-exhaustive`](api-non-exhaustive.md) - Use `#[non_exhaustive]` on public enums and structs for forward compatibility
- [`api-from-not-into`](api-from-not-into.md) - Implement `From<T>`, not `Into<U>` - From gives you Into for free
- [`api-default-impl`](api-default-impl.md) - Implement `Default` for types with sensible default values
- [`api-common-traits`](api-common-traits.md) - Implement standard traits (Debug, Clone, PartialEq, etc.) for public types
- [`api-serde-optional`](api-serde-optional.md) - Make serde a feature flag, not a hard dependency for library crates
- [`api-impl-fromiterator`](api-impl-fromiterator.md) - Implement `FromIterator` and `Extend` for collection types, and `IntoIterator` for all three reference forms
- [`api-operator-overload`](api-operator-overload.md) - Overload operators only when the semantics are natural and unsurprising

## 6. Async/Await (HIGH)

- [`async-tokio-runtime`](async-tokio-runtime.md) - Configure Tokio runtime appropriately for your workload
- [`async-no-lock-await`](async-no-lock-await.md) - Never hold `Mutex`/`RwLock` across `.await`
- [`async-spawn-blocking`](async-spawn-blocking.md) - Use `spawn_blocking` for CPU-intensive work
- [`async-tokio-fs`](async-tokio-fs.md) - Use `tokio::fs` instead of `std::fs` in async code
- [`async-cancellation-token`](async-cancellation-token.md) - Use `CancellationToken` for graceful shutdown and task cancellation
- [`async-join-parallel`](async-join-parallel.md) - Use `join!` or `try_join!` for concurrent independent futures
- [`async-try-join`](async-try-join.md) - Use `try_join!` for concurrent fallible operations with early return on error
- [`async-select-racing`](async-select-racing.md) - Use `select!` to race futures and handle the first to complete
- [`async-bounded-channel`](async-bounded-channel.md) - Use bounded channels to apply backpressure and prevent unbounded memory growth
- [`async-mpsc-queue`](async-mpsc-queue.md) - Use `mpsc` channels for async message queues between tasks
- [`async-broadcast-pubsub`](async-broadcast-pubsub.md) - Use `broadcast` channel for pub/sub where all subscribers receive all messages
- [`async-watch-latest`](async-watch-latest.md) - Use `watch` channel for sharing the latest value with multiple observers
- [`async-oneshot-response`](async-oneshot-response.md) - Use `oneshot` channel for request-response patterns
- [`async-joinset-structured`](async-joinset-structured.md) - Use `JoinSet` for managing dynamic collections of spawned tasks
- [`async-clone-before-await`](async-clone-before-await.md) - Clone Arc/Rc data before await points to avoid holding references across suspension
- [`async-fn-in-trait`](async-fn-in-trait.md) - Use native `async fn` in traits (stable 1.75) instead of the `async_trait` macro
- [`async-async-fn-bounds`](async-async-fn-bounds.md) - Use `AsyncFn`/`AsyncFnMut`/`AsyncFnOnce` bounds instead of `F: Fn() -> Fut, Fut: Future`
- [`async-cancel-safety`](async-cancel-safety.md) - Ensure futures used in `tokio::select!` branches are cancellation-safe

## 7. Concurrency (HIGH)

- [`conc-rayon-par-iter`](conc-rayon-par-iter.md) - Use rayon's `par_iter()` for CPU-bound data parallelism
- [`conc-scoped-threads`](conc-scoped-threads.md) - Use `std::thread::scope` to borrow stack data across threads
- [`conc-atomic-ordering`](conc-atomic-ordering.md) - Use the weakest correct memory `Ordering` for every atomic operation
- [`conc-thread-local`](conc-thread-local.md) - Prefer `thread_local!` with `Cell`/`RefCell` over `static mut`

## 8. Compiler Optimization (HIGH)

- [`opt-inline-small`](opt-inline-small.md) - Use `#[inline]` for small hot functions
- [`opt-inline-always-rare`](opt-inline-always-rare.md) - Use `#[inline(always)]` sparingly—only for critical hot paths proven by profiling
- [`opt-inline-never-cold`](opt-inline-never-cold.md) - Use `#[inline(never)]` and `#[cold]` for error paths and rarely-executed code
- [`opt-cold-unlikely`](opt-cold-unlikely.md) - Mark unlikely code paths with `#[cold]` to help compiler optimization
- [`opt-likely-hint`](opt-likely-hint.md) - Use code structure to hint at likely branches; use intrinsics on nightly
- [`opt-lto-release`](opt-lto-release.md) - Enable LTO in release builds
- [`opt-codegen-units`](opt-codegen-units.md) - Set `codegen-units = 1` for maximum optimization in release builds
- [`opt-pgo-profile`](opt-pgo-profile.md) - Use Profile-Guided Optimization (PGO) for maximum performance
- [`opt-target-cpu`](opt-target-cpu.md) - Use `target-cpu=native` for maximum performance on known deployment targets
- [`opt-bounds-check`](opt-bounds-check.md) - Use iterators and patterns that eliminate bounds checks in hot paths
- [`opt-simd-portable`](opt-simd-portable.md) - Use portable SIMD for vectorized operations across architectures
- [`opt-cache-friendly`](opt-cache-friendly.md) - Organize data for cache-efficient access patterns
- [`opt-flat-storage`](opt-flat-storage.md) - Use one flat backing store for nested data; avoid `Vec<Vec<T>>` and multi-level indirection
- [`opt-registers`](opt-registers.md) - Keep hot mutable state in local variables; minimize writes through pointers
- [`opt-loop-unroll`](opt-loop-unroll.md) - Let the compiler unroll loops; unroll manually only to remove redundant per-iteration work
- [`opt-ilp`](opt-ilp.md) - Structure hot computations as independent chains so the CPU and compiler can parallelize them

## 9. Numeric & Arithmetic Safety (HIGH)

- [`num-overflow-explicit`](num-overflow-explicit.md) - Handle integer overflow explicitly: `checked_`/`saturating_`/`wrapping_`/`overflowing_`
- [`num-cast-try-from`](num-cast-try-from.md) - Avoid `as` for narrowing casts; use `From` for widening and `TryFrom` for narrowing
- [`num-float-compare`](num-float-compare.md) - Don't compare floats with `==`; use a tolerance, and `total_cmp` for ordering
- [`num-saturating-clamp`](num-saturating-clamp.md) - Bound values with `clamp` and saturating arithmetic
- [`num-nonzero`](num-nonzero.md) - Use `NonZero*` types to forbid zero and unlock the niche optimization

## 10. Type Safety (MEDIUM)

- [`type-newtype-ids`](type-newtype-ids.md) - Wrap IDs in newtypes: `UserId(u64)`
- [`type-newtype-validated`](type-newtype-validated.md) - Use newtypes to enforce validation at construction time
- [`type-enum-states`](type-enum-states.md) - Use enums for mutually exclusive states
- [`type-option-nullable`](type-option-nullable.md) - Use `Option<T>` for values that might not exist
- [`type-result-fallible`](type-result-fallible.md) - Use `Result<T, E>` for operations that can fail
- [`type-phantom-marker`](type-phantom-marker.md) - Use `PhantomData` to express type relationships without runtime cost
- [`type-never-diverge`](type-never-diverge.md) - Use `!` (never type) for functions that never return
- [`type-generic-bounds`](type-generic-bounds.md) - Add trait bounds only where needed, prefer where clauses for readability
- [`type-no-stringly`](type-no-stringly.md) - Avoid stringly-typed APIs; use enums, newtypes, or validated types
- [`type-repr-transparent`](type-repr-transparent.md) - Use `#[repr(transparent)]` for newtypes in FFI contexts
- [`type-deref-coercion`](type-deref-coercion.md) - Implement `Deref`/`DerefMut` only for smart-pointer and transparent wrapper types
- [`type-display-vs-debug`](type-display-vs-debug.md) - Use `Display` for user-facing output and `Debug` for diagnostics; never swap them
- [`type-numeric-fmt`](type-numeric-fmt.md) - Implement `LowerHex`, `UpperHex`, `Octal`, and `Binary` for numeric newtypes

## 11. Trait & Generics Design (MEDIUM)

- [`trait-associated-type-vs-generic`](trait-associated-type-vs-generic.md) - Use an associated type when each impl has exactly one output type; use a generic parameter when a type can implement the trait for many input types
- [`trait-blanket-impl`](trait-blanket-impl.md) - Use a blanket impl `impl<T: Bound> Trait for T` to give behaviour to every type that satisfies a bound
- [`trait-coherence-newtype`](trait-coherence-newtype.md) - Respect the orphan rule; wrap a foreign type in a newtype to implement a foreign trait on it
- [`trait-default-methods`](trait-default-methods.md) - Define a trait in terms of a few required methods plus defaulted ones built on top of them
- [`trait-dyn-vs-generic`](trait-dyn-vs-generic.md) - Choose static dispatch (generics / `impl Trait`) vs dynamic dispatch (`dyn Trait`) deliberately
- [`trait-object-safety`](trait-object-safety.md) - Keep a trait dyn-compatible (object-safe) when you need `dyn Trait`

## 12. Conversions (MEDIUM)

- [`conv-tryfrom-fallible`](conv-tryfrom-fallible.md) - Implement `TryFrom` for fallible conversions instead of ad-hoc conversion functions
- [`conv-fromstr-parsing`](conv-fromstr-parsing.md) - Implement `FromStr` to enable `str::parse` for string-to-type conversions
- [`conv-asmut-mutable`](conv-asmut-mutable.md) - Accept `impl AsMut<T>` for flexible mutable borrowed inputs instead of concrete mutable references

## 13. Const & Compile-Time (MEDIUM)

- [`const-block`](const-block.md) - Use inline `const { }` blocks for compile-time evaluation and assertions
- [`const-fn`](const-fn.md) - Make functions `const fn` when they can run at compile time
- [`const-generics`](const-generics.md) - Parameterize over values with const generics `<const N: usize>`
- [`const-vs-static`](const-vs-static.md) - Use `const` for an inlined value and `static` for a single addressed instance

## 14. Serde (MEDIUM)

- [`serde-rename-all`](serde-rename-all.md) - Match the external naming convention with `#[serde(rename_all = ...)]`
- [`serde-default-compat`](serde-default-compat.md) - Use `#[serde(default)]` for optional and backward-compatible fields
- [`serde-skip-empty`](serde-skip-empty.md) - Omit empty fields with `skip_serializing_if`
- [`serde-flatten`](serde-flatten.md) - Inline nested structs or capture extra keys with `#[serde(flatten)]`
- [`serde-enum-representation`](serde-enum-representation.md) - Choose enum tagging deliberately: externally, internally, adjacently tagged, or untagged
- [`serde-deny-unknown-fields`](serde-deny-unknown-fields.md) - Reject unexpected keys with `#[serde(deny_unknown_fields)]`
- [`serde-custom-with`](serde-custom-with.md) - Customize a field's (de)serialization with `with` / `serialize_with` / `deserialize_with`
- [`serde-try-from-validate`](serde-try-from-validate.md) - Validate while deserializing with `#[serde(try_from = "Raw")]`

## 15. Pattern Matching (MEDIUM)

- [`pat-let-else`](pat-let-else.md) - Use `let ... else` for early-return pattern extraction
- [`pat-matches-macro`](pat-matches-macro.md) - Use `matches!()` for boolean pattern tests
- [`pat-if-let-chains`](pat-if-let-chains.md) - Use `if let` chains to combine pattern bindings and conditions
- [`pat-exhaustive-enum`](pat-exhaustive-enum.md) - Match owned enums exhaustively; avoid catch-all `_` that hides new variants
- [`pat-at-bindings`](pat-at-bindings.md) - Use `@` bindings to capture a value while matching it against a pattern

## 16. Macros (MEDIUM)

- [`macro-prefer-functions`](macro-prefer-functions.md) - Reach for a macro only when a function or generic cannot express it
- [`macro-rules-hygiene`](macro-rules-hygiene.md) - Rely on `macro_rules!` hygiene and use `$crate` for paths to your crate's items
- [`macro-fragment-specifiers`](macro-fragment-specifiers.md) - Capture with precise fragment specifiers, not raw `:tt`, where you can
- [`macro-export-crate-path`](macro-export-crate-path.md) - Export declarative macros with `#[macro_export]` and a clean import path
- [`macro-private-helpers`](macro-private-helpers.md) - Hide macro-generated helper items behind a `#[doc(hidden)] pub mod __private`
- [`macro-proc-two-crate`](macro-proc-two-crate.md) - Put procedural macros in a dedicated `proc-macro = true` crate and re-export from the facade
- [`macro-proc-syn-quote`](macro-proc-syn-quote.md) - Build procedural macros with `syn`, `quote`, and `proc-macro2`
- [`macro-proc-error-spans`](macro-proc-error-spans.md) - Report proc-macro errors as spanned compile errors, never by panicking

## 17. Closures (MEDIUM)

- [`closure-fn-trait-bounds`](closure-fn-trait-bounds.md) - Require the least restrictive `Fn` trait a callback needs (`FnOnce` ⊇ `FnMut` ⊇ `Fn`)
- [`closure-impl-fn-return`](closure-impl-fn-return.md) - Return closures as `impl Fn`/`FnMut`/`FnOnce`, not `Box<dyn Fn>`
- [`closure-move-capture`](closure-move-capture.md) - Use `move` for closures that outlive the current scope; clone before `move` to keep the original
- [`closure-static-vs-dyn`](closure-static-vs-dyn.md) - Accept `impl Fn` (generic) for hot callbacks; use `&dyn Fn`/`Box<dyn Fn>` to cut code size or to store them
- [`closure-disjoint-capture`](closure-disjoint-capture.md) - Capture only what you use; lean on edition-2021 disjoint closure captures

## 18. Collections (MEDIUM)

- [`coll-binaryheap`](coll-binaryheap.md) - Use `BinaryHeap` for a priority queue or repeated max-extraction
- [`coll-map-choice`](coll-map-choice.md) - Pick the map by access pattern: `HashMap` (fast, unordered), `BTreeMap` (sorted / range queries), `IndexMap` (insertion order)
- [`coll-seq-choice`](coll-seq-choice.md) - Default to `Vec`; use `VecDeque` for queue/deque behaviour; avoid `LinkedList`
- [`coll-set-membership`](coll-set-membership.md) - Use `HashSet`/`BTreeSet` for membership tests and dedup, not linear `Vec::contains`

## 19. Naming Conventions (MEDIUM)

- [`name-types-camel`](name-types-camel.md) - Use `UpperCamelCase` for types, traits, and enum names
- [`name-variants-camel`](name-variants-camel.md) - Use `UpperCamelCase` for enum variants
- [`name-funcs-snake`](name-funcs-snake.md) - Use `snake_case` for functions, methods, variables, and modules
- [`name-consts-screaming`](name-consts-screaming.md) - Use `SCREAMING_SNAKE_CASE` for constants and statics
- [`name-lifetime-short`](name-lifetime-short.md) - Use short, conventional lifetime names: `'a`, `'b`, `'de`, `'src`
- [`name-type-param-single`](name-type-param-single.md) - Use single uppercase letters for type parameters: `T`, `E`, `K`, `V`
- [`name-as-free`](name-as-free.md) - `as_` prefix: free reference conversion
- [`name-to-expensive`](name-to-expensive.md) - Use `to_` prefix for expensive conversions that allocate or compute
- [`name-into-ownership`](name-into-ownership.md) - Use `into_` prefix for ownership-consuming conversions
- [`name-no-get-prefix`](name-no-get-prefix.md) - Omit get_ prefix for simple getters
- [`name-is-has-bool`](name-is-has-bool.md) - Use `is_`, `has_`, `can_`, `should_` prefixes for boolean-returning methods
- [`name-iter-convention`](name-iter-convention.md) - Use iter/iter_mut/into_iter for iterator methods
- [`name-iter-method`](name-iter-method.md) - Name iterator methods `iter()`, `iter_mut()`, and `into_iter()` consistently
- [`name-iter-type-match`](name-iter-type-match.md) - Name iterator types after their source method
- [`name-acronym-word`](name-acronym-word.md) - Treat acronyms as words in identifiers: `HttpServer`, not `HTTPServer`
- [`name-crate-no-rs`](name-crate-no-rs.md) - Don't suffix crate names with `-rs` or `-rust`

## 20. Testing (MEDIUM)

- [`test-cfg-test-module`](test-cfg-test-module.md) - Put unit tests in `#[cfg(test)] mod tests { }` within each module
- [`test-use-super`](test-use-super.md) - Use `use super::*;` in test modules to access parent module items
- [`test-integration-dir`](test-integration-dir.md) - Put integration tests in the `tests/` directory
- [`test-descriptive-names`](test-descriptive-names.md) - Use descriptive test names that explain what is being tested
- [`test-arrange-act-assert`](test-arrange-act-assert.md) - Structure tests with clear Arrange, Act, Assert sections
- [`test-proptest-properties`](test-proptest-properties.md) - Use proptest for property-based testing
- [`test-mockall-mocking`](test-mockall-mocking.md) - Use mockall for trait mocking
- [`test-mock-traits`](test-mock-traits.md) - Use traits for dependencies to enable mocking in tests
- [`test-fixture-raii`](test-fixture-raii.md) - Use RAII pattern (Drop trait) for automatic test cleanup
- [`test-tokio-async`](test-tokio-async.md) - Use `#[tokio::test]` for async tests
- [`test-should-panic`](test-should-panic.md) - Use `#[should_panic]` to test that code panics as expected
- [`test-criterion-bench`](test-criterion-bench.md) - Use `criterion` for benchmarking
- [`test-doctest-examples`](test-doctest-examples.md) - Keep documentation examples as executable doctests
- [`test-loom-concurrency`](test-loom-concurrency.md) - Use `loom` to exhaustively test lock-free and concurrent code
- [`test-snapshot-testing`](test-snapshot-testing.md) - Use snapshot testing (insta) for complex or serialized output

## 21. Documentation (MEDIUM)

- [`doc-all-public`](doc-all-public.md) - Document all public items with `///` doc comments
- [`doc-module-inner`](doc-module-inner.md) - Use `//!` for module-level documentation
- [`doc-examples-section`](doc-examples-section.md) - Include `# Examples` with runnable code
- [`doc-errors-section`](doc-errors-section.md) - Include `# Errors` section for fallible functions
- [`doc-panics-section`](doc-panics-section.md) - Include `# Panics` section for functions that can panic
- [`doc-safety-section`](doc-safety-section.md) - Include `# Safety` section for unsafe functions
- [`doc-question-mark`](doc-question-mark.md) - Use `?` in examples, not `.unwrap()`
- [`doc-hidden-setup`](doc-hidden-setup.md) - Use `# ` prefix to hide example setup code
- [`doc-intra-links`](doc-intra-links.md) - Use intra-doc links to reference types and items
- [`doc-link-types`](doc-link-types.md) - Use intra-doc links to connect related types and functions
- [`doc-cargo-metadata`](doc-cargo-metadata.md) - Fill `Cargo.toml` metadata for published crates
- [`doc-crate-readme`](doc-crate-readme.md) - Unify the README and crate root docs with `#![doc = include_str!("../README.md")]`

## 22. Observability (MEDIUM)

- [`obs-tracing-over-log`](obs-tracing-over-log.md) - Use `tracing` for structured, span-aware diagnostics instead of `println!` or bare `log`
- [`obs-library-facade`](obs-library-facade.md) - Libraries emit through the tracing/log facade and never install a subscriber
- [`obs-structured-fields`](obs-structured-fields.md) - Record structured key-value fields, not values interpolated into the message string
- [`obs-instrument-spans`](obs-instrument-spans.md) - Use `#[tracing::instrument]` and spans to attach context to async tasks and requests
- [`obs-levels-filter`](obs-levels-filter.md) - Use log levels meaningfully and filter with `EnvFilter` / `RUST_LOG`
- [`obs-error-chain`](obs-error-chain.md) - Log errors with their full source chain, and log each error exactly once
- [`obs-no-sensitive-data`](obs-no-sensitive-data.md) - Never log secrets or PII; redact or skip them

## 23. Performance Patterns (MEDIUM)

- [`perf-iter-over-index`](perf-iter-over-index.md) - Prefer iterators over manual indexing
- [`perf-iter-lazy`](perf-iter-lazy.md) - Keep iterators lazy, collect only when needed
- [`perf-collect-once`](perf-collect-once.md) - Don't collect intermediate iterators
- [`perf-entry-api`](perf-entry-api.md) - Use entry API for map insert-or-update
- [`perf-drain-reuse`](perf-drain-reuse.md) - Use drain to reuse allocations
- [`perf-extend-batch`](perf-extend-batch.md) - Use extend for batch insertions
- [`perf-chain-avoid`](perf-chain-avoid.md) - Avoid chain in hot loops
- [`perf-collect-into`](perf-collect-into.md) - Use collect_into for reusing containers
- [`perf-black-box-bench`](perf-black-box-bench.md) - Use black_box in benchmarks
- [`perf-release-profile`](perf-release-profile.md) - Optimize release profile settings
- [`perf-profile-first`](perf-profile-first.md) - Profile before optimizing
- [`perf-ahash`](perf-ahash.md) - Use a faster hasher (`ahash` / `FxHashMap`) when DoS resistance is not needed
- [`perf-io-buffering`](perf-io-buffering.md) - Wrap `Read`/`Write` in `BufReader`/`BufWriter` for many small operations

## 24. Project Structure (LOW)

- [`proj-lib-main-split`](proj-lib-main-split.md) - Keep `main.rs` minimal, logic in `lib.rs`
- [`proj-mod-by-feature`](proj-mod-by-feature.md) - Organize modules by feature, not type
- [`proj-flat-small`](proj-flat-small.md) - Keep small projects flat
- [`proj-mod-rs-dir`](proj-mod-rs-dir.md) - Use mod.rs for multi-file modules
- [`proj-pub-crate-internal`](proj-pub-crate-internal.md) - Use pub(crate) for internal APIs
- [`proj-pub-super-parent`](proj-pub-super-parent.md) - Use pub(super) for parent-only visibility
- [`proj-pub-use-reexport`](proj-pub-use-reexport.md) - Use pub use for clean public API
- [`proj-prelude-module`](proj-prelude-module.md) - Create prelude module for common imports
- [`proj-bin-dir`](proj-bin-dir.md) - Put multiple binaries in src/bin/
- [`proj-workspace-large`](proj-workspace-large.md) - Use workspaces for large projects
- [`proj-workspace-deps`](proj-workspace-deps.md) - Use workspace dependency inheritance for consistent versions across crates
- [`proj-feature-additive`](proj-feature-additive.md) - Design Cargo features to be strictly additive
- [`proj-msrv-declare`](proj-msrv-declare.md) - Declare `rust-version` (MSRV) in Cargo.toml and test it in CI
- [`proj-build-rs-minimal`](proj-build-rs-minimal.md) - Keep `build.rs` minimal, deterministic, and idempotent

## 25. Clippy & Linting (LOW)

- [`lint-deny-correctness`](lint-deny-correctness.md) - `#![deny(clippy::correctness)]`
- [`lint-warn-suspicious`](lint-warn-suspicious.md) - Enable clippy::suspicious for likely bugs
- [`lint-warn-style`](lint-warn-style.md) - Enable clippy::style for idiomatic code
- [`lint-warn-complexity`](lint-warn-complexity.md) - Enable clippy::complexity for simpler code
- [`lint-warn-perf`](lint-warn-perf.md) - Enable clippy::perf for performance improvements
- [`lint-pedantic-selective`](lint-pedantic-selective.md) - Enable clippy::pedantic selectively
- [`lint-missing-docs`](lint-missing-docs.md) - Warn on missing documentation for public items
- [`lint-unsafe-doc`](lint-unsafe-doc.md) - Require documentation for unsafe blocks
- [`lint-cargo-metadata`](lint-cargo-metadata.md) - Enable clippy::cargo for published crates
- [`lint-rustfmt-check`](lint-rustfmt-check.md) - Run cargo fmt --check in CI
- [`lint-workspace-lints`](lint-workspace-lints.md) - Configure lints at workspace level for consistent enforcement
- [`lint-cfg-check`](lint-cfg-check.md) - Enable `unexpected_cfgs` and declare known cfgs to catch feature-gate typos
- [`lint-clippy-nursery-selected`](lint-clippy-nursery-selected.md) - Enable high-value `clippy::nursery` lints selectively, not the whole group

## 26. Anti-patterns (REFERENCE)

- [`anti-unwrap-abuse`](anti-unwrap-abuse.md) - Don't use `.unwrap()` in production code
- [`anti-expect-lazy`](anti-expect-lazy.md) - Don't use expect for recoverable errors
- [`anti-clone-excessive`](anti-clone-excessive.md) - Don't clone when borrowing works
- [`anti-lock-across-await`](anti-lock-across-await.md) - Don't hold locks across await points
- [`anti-string-for-str`](anti-string-for-str.md) - Don't accept &String when &str works
- [`anti-vec-for-slice`](anti-vec-for-slice.md) - Don't accept &Vec<T> when &[T] works
- [`anti-index-over-iter`](anti-index-over-iter.md) - Don't use indexing when iterators work
- [`anti-panic-expected`](anti-panic-expected.md) - Don't panic on expected or recoverable errors
- [`anti-empty-catch`](anti-empty-catch.md) - Don't silently ignore errors
- [`anti-over-abstraction`](anti-over-abstraction.md) - Don't over-abstract with excessive generics
- [`anti-premature-optimize`](anti-premature-optimize.md) - Don't optimize before profiling
- [`anti-type-erasure`](anti-type-erasure.md) - Don't use Box<dyn Trait> when impl Trait works
- [`anti-format-hot-path`](anti-format-hot-path.md) - Don't use format! in hot paths
- [`anti-collect-intermediate`](anti-collect-intermediate.md) - Don't collect intermediate iterators
- [`anti-stringly-typed`](anti-stringly-typed.md) - Don't use strings where enums or newtypes would provide type safety

