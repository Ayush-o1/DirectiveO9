# 3. Group-Commit Journaling in PostgreSQL

Date: 2026-10-15

## Status

Accepted

## Context

DirectiveO9 enforces a strict architectural invariant: **journal-before-ack**. An order command cannot be acknowledged to an API client until it has been durably appended to the database command journal.

Writing commands one-by-one synchronously through PostgreSQL requires a disk flush (`fsync` / `fdatasync`) for every transaction commit when `synchronous_commit = on` (PostgreSQL Documentation, Chapter 30 "Reliability and the Write-Ahead Log"). Sequential individual commits are strictly bound by the storage layer's write and flush latency per transaction.

To achieve higher throughput without sacrificing durability guarantees, the sequencer must amortize disk I/O across batches of commands.

## Options Considered

1. **Per-Command Synchronous Insertion**:
   - _Pros_: Simplest implementation. Immediate per-command error handling.
   - _Cons_: Severe throughput bottleneck dictated strictly by per-transaction disk write and flush latency.

2. **Asynchronous Journaling (Ack Before Write)**:
   - _Pros_: Lowest API latency.
   - _Cons_: Violates the non-negotiable journal-before-ack invariant. A crash after ack but before write results in lost orders and irreconcilable client state.

3. **Sequencer-Level Group Commit (Micro-Batching)**:
   - _Pros_: The sequencer accepts commands into a bounded queue. A single writer worker drains the queue either when a batch size threshold is reached or a microsecond batch timer expires. The batch is written to PostgreSQL in a single multi-row `INSERT INTO commands ...` within a single transaction. All waiting client promises in the batch are resolved upon transaction completion.
   - _Cons_: Adds bounded queueing delay under sparse load; requires careful promise-management and failure isolation within batches.

## Decision

Adopt Option 3:

- The sequencer acts as a single writer managing a bounded micro-batch queue.
- Incoming commands are enqueued with their resolution/rejection callbacks.
- When the batch reaches `BATCH_MAX_SIZE` (default: 100) or `BATCH_TIMEOUT_MS` (default: 5ms) elapses, the sequencer flushes the batch via a parameterized multi-row `INSERT INTO commands (seq, ts, participant_id, client_order_id, type, payload) VALUES ...`.
- Commands are ordered and sequenced strictly before journal insertion.
- The default database configuration uses `synchronous_commit = on` to guarantee absolute crash durability (PostgreSQL Official Documentation, Section 20.5.1 "Write-Ahead Log - synchronous_commit" and Section 30.5 "Asynchronous Commit").
- The `synchronous_commit` level is exposed as a configurable parameter (`on`, `off`, `remote_write`) for benchmarking throughput ceilings.

## Consequences

- Durability is guaranteed prior to acknowledging HTTP requests (RPO = 0).
- I/O throughput scales effectively under high concurrency by batching disk flushes across micro-batches.
- If a batch insertion fails (e.g., database network disconnect), all commands in the pending batch are rejected cleanly without engine state corruption.
- Full details and architectural trade-offs are documented in `docs/spec.md` Section 14.
