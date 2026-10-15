# 1. Price-Level Data Structure

Date: 2026-10-15

## Status

Accepted

## Context

A limit order book requires low-latency operations for three core matching routines:

1. Lookup and traversal of the best bid (maximum price) and best ask (minimum price).
2. FIFO insertion of new resting limit orders at a given price level.
3. O(1) cancellation of an arbitrary order anywhere in the book.

In JavaScript runtimes (V8), common collection abstractions include native arrays, `Map`, plain objects, and custom balanced binary search trees or skip lists. The matching engine must balance worst-case algorithmic complexity with V8 memory layouts, cache locality, and garbage collection overhead.

## Options Considered

1. **Red-Black Tree or AVL Tree for Price Levels + Linked List for Orders**:
   - _Pros_: O(log L) insertions and deletions, naturally ordered traversal.
   - _Cons_: Allocates small node objects per price level, generating pointer indirection and GC pressure in V8. High implementation overhead and cache misses compared to contiguous memory.

2. **Sorted Array of Price Levels with Binary Search + Map for O(1) Level Lookup + Doubly Linked FIFO per Level + Map for Order Node Indexing**:
   - _Pros_: Array provides cache-friendly sequential iteration and O(log L) binary search. Inserting a new price level requires shifting elements in a compact array of numbers (typically small: dozens to hundreds of active price levels). Map from price to level gives O(1) existence checks. Per-level doubly linked list allows O(1) FIFO enqueue and head dequeue. Map from `order_id` to node allows O(1) cancellation and removal.
   - _Cons_: Array insertion and deletion of price levels is O(L) in worst-case array shifting (mitigated by small number of active levels).

3. **Single Flat Map of Orders**:
   - _Pros_: Extremely simple structure.
   - _Cons_: Finding best bid and ask requires O(N) scans or expensive key sorting on every match step, unacceptable for an order book.

## Decision

Adopt Option 2:

- Maintain sorted arrays of active price levels (`bids` descending, `asks` ascending) using binary search (`sortedIndex`) for insertion and removal.
- Maintain a `Map<price, Level>` for O(1) direct price-level access.
- Maintain a doubly linked list per price level for O(1) FIFO matching and order addition.
- Maintain a `Map<order_id, OrderNode>` for O(1) order cancellation and deletion.

This structure acts as the baseline hypothesis. It will be benchmarked against alternative structures in Phase 5 to measure allocation profiles and latency distributions.

## Consequences

- Best bid/ask lookup is O(1) (head of sorted array).
- New order insertion at existing price level is O(1).
- New price level creation is O(log L) search + O(L) array shift.
- Order cancellation is O(1) via map lookup and pointer unlink.
- Memory overhead is bounded: 1 node per resting order, 1 node per active price level.
