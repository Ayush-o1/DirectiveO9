# 4. Idempotent Command Handling

Date: 2026-10-15

## Status

Accepted

## Context

In financial exchange APIs, network retries by participants are routine. If a client submits an order, experiences a TCP timeout, and resubmits the same order with the same `client_order_id`, the system must not create a duplicate order, nor should it return a generic error.

The engine specification mandates:
"A duplicate (participant, client_order_id) returns the original result. It is not a reject."

## Options Considered

1. **Database Unique Constraint Rejection Only**:
   - _Pros_: Simple constraint `UNIQUE(participant_id, client_order_id)` in PostgreSQL.
   - _Cons_: Rejection throws a constraint violation (PostgreSQL error `23505`). Returning this as an error violates the requirement to return the original execution result.

2. **In-Memory Idempotency Cache + Database Historical Query**:
   - _Pros_: Fast in-memory lookup for recent requests.
   - _Cons_: Memory unbounded if all historical keys are retained in memory; cache misses after restart still require database lookup.

3. **Hybrid In-Memory Deduplication Map + Database Backed Re-Query**:
   - _Pros_:
     1. Sequencer maintains an active in-memory map of `participant_id:client_order_id -> { seq, response, promise }`.
     2. In-flight requests with identical keys attach to the existing unresolved promise, preventing duplicate concurrent execution.
     3. Recently completed requests are retained in an in-memory ring-buffer/LRU for O(1) instant return of the original result.
     4. On cache miss (e.g. after restart), if PostgreSQL detects a unique constraint violation (`23505`) on batch insert, the sequencer queries the persisted command record and its generated projection/events, returning the original response.

## Decision

Adopt Option 3:

- Enforce `UNIQUE (participant_id, client_order_id)` at the database schema level on the `commands` table.
- Maintain an in-memory idempotency table in the sequencer.
- Concurrent duplicate submissions join the in-flight command promise.
- Completed duplicate submissions return the original HTTP status, sequence number, order state, and generated trade events.
- On cold cache hits, reconstruct the original response from the journal and projections.

## Consequences

- Exact-once execution semantics for matching engine state transitions.
- Transparent client retries with zero risk of duplicate execution.
- Small memory footprint for the recent idempotency index.
