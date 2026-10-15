# 6. Benchmarking Methodology and V8 Performance Measurement

Date: 2026-10-15

## Status

Accepted

## Context

Performance metrics reported for matching engines and low-latency systems are easily distorted by runtime artifacts and flawed measurement techniques. In Node.js (V8 runtime), the following factors must be controlled:

1. **JIT Compilation and Tier-Up**: V8 compiles JavaScript through tiered execution: Ignition bytecode interpreter -> Sparkplug -> Maglev -> TurboFan optimizing compiler. Early benchmark iterations capture compilation overhead and unoptimized code paths. Deoptimizations from unstable object shapes can introduce severe anomalies.
2. **Garbage Collection (GC)**: V8 generational GC executes scavenge passes (young generation) and full mark-sweep-compact cycles (old generation). Uncontrolled GC pauses during measurement corrupt tail latency percentiles (p99, p99.9).
3. **Timer Precision and Overhead**: `Date.now()` provides millisecond granularity and is subject to system clock adjustments (NTP). `process.hrtime.bigint()` provides monotonic nanosecond precision with minimal measurement overhead.
4. **Coordinated Omission**: Closed-loop load generators wait for an in-flight request to complete before sending the next one. During a service hiccup or GC pause, requests back up, but the load generator stops sending requests, hiding the queue delay experienced by real clients (Gil Tene, _How NOT to Measure Latency_).
5. **Reproducibility**: No metrics may be documented without verifiable, script-generated raw output files containing git commit hashes, Node runtime version, and hardware specifications.

## Options Considered

1. **Ad-Hoc `console.time` / Microbenchmarking**:
   - _Pros_: Quick to write.
   - _Cons_: Fails to isolate JIT warm-up, lacks statistical rigor, susceptible to clock jitter, unrepeatable across machines.

2. **Rigorous Multi-Phase Harness with JIT Warm-Up, Explicit GC Control, Monotonic Timers, and Coordinated Omission Correction**:
   - _Pros_:
     - Multi-phase execution: Phase 1 (warm-up: 50,000+ operations to stabilize TurboFan compilation and prevent deoptimizations), Phase 2 (cooldown with explicit GC via `--expose-gc`), Phase 3 (measurement: 200,000+ timed operations).
     - Nanosecond monotonic timing via `process.hrtime.bigint()`.
     - Distribution analysis: min, p50, p90, p99, p99.9, max, throughput (ops/sec).
     - Raw benchmark outputs persisted to `bench/results/` as JSON containing git commit hash, OS, CPU model, Node version, and timestamps.
     - API load tests conducted via `autocannon` configured with fixed duration, pipelining, and high connection concurrency to mitigate coordinated omission.
   - _Cons_: Requires running Node with `--expose-gc` flag for dedicated benchmark scripts.

## Decision

Adopt Option 2:

- Engine microbenchmarks run via `node --expose-gc bench/index.js`.
- Every benchmark performs a warm-up phase (at least 50,000 commands), triggers `global.gc()`, and runs the timed evaluation phase.
- Timing is recorded per-command using `process.hrtime.bigint()`.
- Results are written to `bench/results/<timestamp>-<commit>.json` with system environment metadata.
- All numbers cited in documentation must directly reference an existing benchmark JSON artifact in `bench/results/`.

## Consequences

- Benchmark metrics reflect steady-state TurboFan performance.
- Tail latencies are accurately categorized without being masked by initial JIT warm-up.
- Results are strictly reproducible by running `npm run bench`.
