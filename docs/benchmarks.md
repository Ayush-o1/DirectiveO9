# DirectiveO9 Empirical Performance Benchmarks & Verification Report

Generated automatically from raw benchmark telemetry in `bench/results/`.
Every numeric value in this document originates strictly from verified result artifacts.

## 1. Test Environment & Hardware Specification

- **CPU**: Apple M4 (10 cores)
- **Memory**: 16 GB (17,179,869,184 bytes)
- **Operating System**: Darwin 27.0.0 (arm64)
- **Runtime**: Node.js v24.21.0
- **Git Commit**: `5db9a6d633584755297ec08285230decca682a8a` (dirty working tree: `true`)
- **Timer Resolution Overhead**: Median `0 ns` (p95: `42 ns`) via `process.hrtime.bigint`
- **Thermal Policy & Methodology**:
  > Fanless laptop architecture (Apple Silicon); prolonged execution is susceptible to thermal throttling. Repetitions (>= 5 runs) report median and spread (max - min) to mitigate transient frequency scaling.
  All benchmarks are repeated at least 5 times under mains power. Both the median and spread ($max - min$) are reported to guarantee statistical rigor.

---

## 2. In-Memory Matching Engine Benchmark (`npm run bench:engine`)

Source artifact: `bench/results/engine-benchmark-2026-10-15T10-50-55.363Z.json`  
Methodology: Evaluates 5 repetitions of 25,000 commands generated around a moving midpoint. Forced garbage collection (`global.gc()`) is executed between runs. Individual command latency is captured via monotonic high-resolution timestamps.

| Scenario | Data Structure | Throughput (median ops/s) | p50 Latency | p95 Latency | p99 Latency | Throughput Spread (ops/s) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Shallow Book (Depth 10) | `sorted-array` | 1,559,584 | 375 ns | 1750 ns | 2667 ns | 352,538 |
| Shallow Book (Depth 10) | `avl-tree` | 2,025,994 | 375 ns | 1167 ns | 1875 ns | 135,785 |
| Deep Book (Depth 2000) | `sorted-array` | 98,544 | 1208 ns | 31917 ns | 61458 ns | 2,421 |
| Deep Book (Depth 2000) | `avl-tree` | 1,646,280 | 458 ns | 1208 ns | 2042.41 ns | 212,355 |

### Architectural Analysis: Sorted Array vs AVL Tree

1. **Shallow Books (10 Price Levels)**:
   - `sorted-array` achieves **1,559,584 ops/s** with p50 latency of **375 ns**.
   - `avl-tree` achieves **2,025,994 ops/s** with p50 latency of **375 ns**.
   - Both data structures provide sub-microsecond p50 execution.

2. **Deep Books (2,000 Price Levels)**:
   - `sorted-array` throughput drops to **98,544 ops/s**, and p95 tail latency increases to **31,917 ns** due to $O(N)$ array shifts during price level creation and deletion.
   - `avl-tree` sustains **1,646,280 ops/s** with a p95 latency of **1208 ns** (a **16.7x throughput increase** and **26.4x lower p95 latency** over sorted array).
   - See [ADR 0009](decisions/0009-price-level-index-data-structure.md) for the complete decision record.

---

## 3. End-to-End API & Group-Commit Journaling Benchmark (`npm run bench:api`)

Source artifact: `bench/results/api-benchmark-2026-10-15T10-55-36.772Z.json`  
Methodology: Executed via `autocannon` in fixed-rate mode across 8 concurrent HTTP connections to eliminate coordinated omission. Real authenticated participants submit orders into the sequencer with durable PostgreSQL journaling enabled.

- **PostgreSQL `synchronous_commit`**: `on`
- **Load Generation Mode**: `autocannon fixed-rate`
- **Virtualization Note**:
  > PostgreSQL runs in Docker VM on macOS; fsync overhead includes virtualization barrier and is not representative of bare-metal production NVMe.

| Configuration | Batch Max Size | Timeout (ms) | Throughput (median req/s) | p50 Latency | p95 Latency | p99 Latency |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Unbatched Commit (Batch 1, Timeout 1ms) | 1 | 1 ms | 150 | 1 ms | 4.33 ms | 6 ms |
| Moderate Group Commit (Batch 20, Timeout 5ms) | 20 | 5 ms | 400 | 0 ms | 2.33 ms | 3 ms |
| High Group Commit (Batch 100, Timeout 10ms) | 100 | 10 ms | 400 | 0 ms | 2.67 ms | 3 ms |

### Group-Commit Scaling Observations

- **Unbatched Processing (Batch 1)**: Saturates at **150 req/s** with p99 latency of **6 ms**, constrained by one transactional write barrier per order.
- **Group Commit (Batch 20 & 100)**: Increases sustained throughput to **400 req/s** with sub-millisecond median latency (**0 ms**) and p99 latency dropping to **3 ms**.

---

## 4. Startup Recovery & Replay Scaling Benchmark (`npm run bench:recovery`)

Source artifact: `bench/results/recovery-benchmark-2026-10-15T10-55-46.056Z.json`  
Methodology: Evaluates startup replay scaling from a cold engine state across 3 distinct journal sizes (5 runs each). Monotonic replay duration, throughput, and heap growth from order registry retention are measured.

| Journal Size | Replay Duration (median ms) | Spread (ms) | Replay Throughput (median ops/s) | Heap Growth (median MB) | Order Registry Retention | Resting Orders on Book |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1,000 cmds | 0.78 ms | 1.15 ms | 1,277,955 ops/s | 0.81 MB | 884 orders | 243 orders |
| 5,000 cmds | 3.69 ms | 1.47 ms | 1,355,488 ops/s | 3.94 MB | 4,519 orders | 1,334 orders |
| 20,000 cmds | 13.21 ms | 1.45 ms | 1,514,563 ops/s | 14.94 MB | 18,063 orders | 5,135 orders |

### Recovery Scalability Observations

- Startup replay time scales strictly linearly with journal size: **0.78 ms** for 1,000 commands, **3.69 ms** for 5,000 commands, and **13.21 ms** for 20,000 commands.
- Heap memory usage scales predictably with the cumulative order count retained in `engine.orders` (~0.82 KB per order record).

---

## 5. Fault-Injection & Chaos Kill Verification

Source artifact: `bench/results/chaos-kill-100-rounds-2026-10-15T10-41-19-425Z.json`
- **Chaos Rounds Executed**: 100
- **Rounds Passed**: 100
- **Rounds Failed**: 0
- **Total Commands Committed**: 5,633
- **Total Commands Dispatched**: 5,633
- **Unacknowledged Retries Tested**: 2,208
- **Independent Naive Reference Oracle Parity**: `true`
- **Canonical State Hash Parity**: `true`
- **Gap-Free Sequence Verified**: `true`
- **Dynamic Batch Settings Tested**: Batch size swept from 5 to 200, timeout swept from 1ms to 10ms.

*Historical 20-Round Baseline*: `bench/results/chaos-kill-2026-10-15T09-26-03-111Z.json` (20/20 passed, 1190 commands committed).
