# 9. Price-Level Index Data Structure Comparison and Decision

Date: 2026-10-15

## Status

Accepted

## Context

In ADR 0001, DirectiveO9 adopted a baseline sorted array with binary search (`SortedArrayPriceIndex`) for tracking active price levels (`bids` descending, `asks` ascending), combined with a hash map (`Map<price, LevelQueue>`) for direct O(1) level access and doubly linked FIFO queues for order execution.

While a sorted array offers contiguous memory layout and cache-friendly binary search, inserting or removing a price level requires `Array.prototype.splice()`, which incurs an $O(L)$ memory-copy shift of subsequent price levels in V8. On books with thousands of price levels (e.g. algorithmic market makers populating deep liquidity ladders), this linear shift presents a potential scaling bottleneck.

To evaluate this trade-off empirically, we implemented a pure JavaScript, height-balanced AVL Tree (`AvlTreePriceIndex`) conforming to the identical `PriceLevelIndex` interface (`insert`, `remove`, `has`, `peek`, `[0]`, `length`, `toArray`, `[Symbol.iterator]`). Both implementations were subjected to:

1. All 41 golden scenario fixtures (verifying functional and state hash parity).
2. Property-based and randomized differential fuzzing against the naive reference oracle (`NaiveEngine`).
3. An in-memory microbenchmark (`npm run bench:engine`) executed on an Apple M4 CPU across 5 repetitions of 25,000 commands each, measuring p50, p95, p99 latency with `process.hrtime.bigint` and overall throughput under forced garbage collection between runs.

## Benchmark Results

All measurements are medians over 5 benchmark trials (25,000 commands per trial) on Node v24.21.0, Apple M4 (10 cores), Darwin 27.0.0. The raw data is recorded in `bench/results/engine-benchmark-2026-10-15T10-50-55.363Z.json`.

| Scenario                    | Data Structure | Throughput (median ops/s) | p50 Latency (ns) | p95 Latency (ns) | p99 Latency (ns) | Throughput Spread (ops/s) |
| :-------------------------- | :------------- | :------------------------ | :--------------- | :--------------- | :--------------- | :------------------------ |
| **Shallow Book (Depth 10)** | `sorted-array` | 1,559,584                 | 375 ns           | 1,750 ns         | 2,667 ns         | 352,538                   |
| **Shallow Book (Depth 10)** | `avl-tree`     | 2,025,994                 | 375 ns           | 1,167 ns         | 1,875 ns         | 135,785                   |
| **Deep Book (Depth 2000)**  | `sorted-array` | 98,544                    | 1,208 ns         | 31,917 ns        | 61,458 ns        | 2,421                     |
| **Deep Book (Depth 2000)**  | `avl-tree`     | 1,646,280                 | 458 ns           | 1,208 ns         | 2,042 ns         | 212,355                   |

### Analysis

1. **Shallow Books (10 active price levels)**:
   - Both data structures achieve over 1.5 million operations per second.
   - AVL tree achieves 2,025,994 ops/s vs 1,559,584 ops/s for sorted array (+29.9% throughput), with tighter tail latencies (p95: 1,167 ns vs 1,750 ns).
2. **Deep Books (2,000 active price levels)**:
   - On deep books, `sorted-array` degrades precipitously to 98,544 ops/s, with p95 latency jumping from 1.75 microseconds to 31.92 microseconds, and p99 jumping to 61.46 microseconds. This degradation directly reflects V8's cost of shifting 2,000 64-bit float/pointer slots on every price level insertion and pruning.
   - In contrast, `avl-tree` sustains 1,646,280 ops/s (+1570% / 16.7x faster than sorted array), with p95 latency remaining stable at 1,208 ns (26.4x lower than sorted array) and p99 at 2,042 ns.

## Decision: Keep-or-Replace

**Decision**:

1. **Retain `sorted-array` as the default engine configuration** for standard, shallow-to-moderate order books (e.g. top-of-book retail flows where depth $\le 50$), preserving minimal object allocation overhead and zero pointer indirection for simple deployment profiles.
2. **Officially integrate and support `avl-tree` via `indexType: 'avl'` in `OrderBook` and `MatchingEngine`** for deep-book environments, high-frequency quoting, and institutional market making where depth exceeds 50 levels.
3. Both data structures share the identical interface contract, pass 100% of golden scenario fixtures, and produce bit-for-bit identical state hashes and trade logs.

## Consequences

- Applications configuring `new MatchingEngine({ indexType: 'avl' })` achieve predictable O(log N) insertion and deletion across arbitrarily deep books without tail-latency spikes.
- Default users retain zero-dependency sorted arrays without breaking existing test harnesses or serialization guarantees.
