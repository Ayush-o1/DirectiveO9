# 9. Price-Level Index Data Structure Comparison and Decision

Date: 2026-10-15

## Status

Accepted

## Context

In ADR 0001, DirectiveO9 adopted a sorted array with binary search (`SortedArrayPriceIndex`) for tracking active price levels (`bids` descending, `asks` ascending), combined with a hash map (`Map<price, LevelQueue>`) for direct $O(1)$ level lookup and doubly linked FIFO queues for order execution.

While a sorted array offers contiguous memory layout and cache-friendly binary search, inserting or removing a price level requires `Array.prototype.splice()`, which incurs an $O(L)$ memory-copy shift of subsequent elements. On books with thousands of price levels, this linear shift was hypothesized to become a throughput bottleneck.

To evaluate this trade-off empirically, we implemented a pure JavaScript, height-balanced AVL Tree (`AvlTreePriceIndex`) conforming to the identical `PriceLevelIndex` interface contract (`insert`, `remove`, `has`, `peek`, `[0]`, `length`, `toArray`, `[Symbol.iterator]`). Both implementations were evaluated across:

1. All 41 golden scenario fixtures (verifying state hash and functional parity).
2. Property-based randomized differential testing against the naive reference oracle (`NaiveEngine`).
3. An in-memory benchmark (`npm run bench:engine`) executed on an Apple M4 CPU across 5 repetitions of 25,000 commands each, testing three depths (10, 500, 5,000 price levels).

### Implementation Artifact Investigation

An initial benchmark showed `sorted-array` collapsing from 1,559,584 ops/s at 10 levels down to 98,544 ops/s at 2,000 levels. Investigation with `node --cpu-prof` revealed the following root cause:

1. **Root Cause**: `SortedArrayPriceIndex` was declared as `class SortedArrayPriceIndex extends Array`. In V8, invoking `Array.prototype.splice` on an ES6 `Array` subclass triggers the ECMAScript `ArraySpeciesCreate` abstract operation. On every insertion and deletion, V8 allocated intermediate subclass instances and dropped out of the fast C++ element-shift path (`memmove`) into a slow reflective path.
2. **CPU Profiling (`node --cpu-prof`)**: In the subclassed implementation, `insertPrice` accounted for 46.33% and `removePrice` accounted for 38.53% of all execution samples (84.86% total CPU time spent in subclassed `splice`). Microbenchmarks measured 25,537 ns per splice on the subclass versus 121 ns per splice on a plain native array (a 210x difference).
3. **Engine Complexity**: Inspection of the engine confirmed zero $O(\text{levels})$ scans per command; the only level-touching operations are initial level creation and empty level pruning.
4. **Level Churn Workload**: In the standard benchmark workload, 45% of commands are maker limits. On deep books (depth $\ge 500$), virtually every maker order touches an empty price level, and crossing market sweeps or cancellations exhaust levels. Price level creation and deletion operations account for 45.06% of commands at depth 500 and 72.84% of commands at depth 5,000.
5. **Fix**: Refactoring `SortedArrayPriceIndex` to encapsulate a plain array (`this.prices = []`) restored V8's contiguous memory copy path, increasing deep-book throughput by over 17x.

## Empirical Benchmark Results (Before vs After Artifact Fix)

### Before Fix (Array Subclass Artifact)

| Scenario                | Data Structure            | Throughput (median ops/s) | p50 Latency (ns) | p95 Latency (ns) |
| :---------------------- | :------------------------ | :------------------------ | :--------------- | :--------------- |
| Shallow Book (Depth 10) | `sorted-array` (subclass) | 1,559,584                 | 375 ns           | 1,750 ns         |
| Shallow Book (Depth 10) | `avl-tree`                | 2,025,994                 | 375 ns           | 1,167 ns         |
| Deep Book (Depth 2,000) | `sorted-array` (subclass) | 98,544                    | 1,208 ns         | 31,917 ns        |
| Deep Book (Depth 2,000) | `avl-tree`                | 1,646,280                 | 458 ns           | 1,208 ns         |

### After Fix (Plain Array Encapsulation, 5 repetitions, 25,000 commands/run)

Source artifact: `bench/results/engine-benchmark-2026-10-15T11-19-46.113Z.json` (Apple M4, 10 cores, Node v24.21.0).

| Scenario                    | Data Structure | Throughput (median ops/s) | p50 Latency (ns) | p95 Latency (ns) | p99 Latency (ns) | Throughput Spread (ops/s) |
| :-------------------------- | :------------- | :------------------------ | :--------------- | :--------------- | :--------------- | :------------------------ |
| **Shallow Book (Depth 10)** | `sorted-array` | 2,034,257                 | 334 ns           | 1,083 ns         | 1,625 ns         | 495,389                   |
| **Shallow Book (Depth 10)** | `avl-tree`     | 1,997,709                 | 375 ns           | 1,167 ns         | 1,875 ns         | 116,334                   |
| **Medium Book (Depth 500)** | `sorted-array` | 2,015,553                 | 375 ns           | 958 ns           | 1,500 ns         | 320,158                   |
| **Medium Book (Depth 500)** | `avl-tree`     | 1,816,140                 | 375 ns           | 1,250 ns         | 2,167 ns         | 107,588                   |
| **Deep Book (Depth 5,000)** | `sorted-array` | 1,765,973                 | 458 ns           | 1,042 ns         | 1,583 ns         | 138,847                   |
| **Deep Book (Depth 5,000)** | `avl-tree`     | 1,452,756                 | 541 ns           | 1,333 ns         | 2,167 ns         | 623,375                   |

## Decision: Keep-or-Replace

1. **Retain `sorted-array` as the default engine index**:
   - With the plain array encapsulation fix, `sorted-array` delivers higher throughput and lower tail latencies than `avl-tree` across all evaluated depths (Depth 10: 2.03M vs 2.00M ops/s; Depth 500: 2.02M vs 1.82M ops/s; Depth 5,000: 1.77M vs 1.45M ops/s).
   - A contiguous array of 5,000 prices consumes ~40 KB, fitting entirely within CPU L1 data cache. Binary search requires at most 13 contiguous comparisons. In contrast, an AVL tree incurs pointer dereferencing, heap node allocation, and tree rotation overhead.
2. **Retain `avl-tree` as a fully verified alternative (`indexType: 'avl'`)**:
   - `AvlTreePriceIndex` provides strictly logarithmic worst-case theoretical bounds ($O(\log N)$) without contiguous element shifting.
   - It is maintained in `src/engine/avl.js` and validated against differential fuzzer, golden fixtures, and mutation tests.

## Consequences

- The default engine instance (`new MatchingEngine()`) uses `sorted-array` and achieves optimal in-memory throughput ($\ge 1.76\text{M}$ ops/s across all tested depths).
- Developers may explicitly select the AVL tree via `new MatchingEngine({ indexType: 'avl' })` without modifying downstream interfaces.
