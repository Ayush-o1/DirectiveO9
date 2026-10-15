# 2. Canonical State Hashing and Serialization

Date: 2026-10-15

## Status

Accepted

## Context

Deterministic replay verification requires computing a cryptographic state hash (SHA-256) of the matching engine state after any arbitrary sequence number. Two separate runs processing identical commands from genesis must produce identical state hashes byte-for-byte.

JavaScript environments present specific serialization pitfalls:

1. **Property Iteration Order**: While ES2015 defines deterministic property traversal order (integer indices ascending, followed by insertion order for string keys, followed by Symbols), property assignment timing or internal hidden-class transitions can alter insertion orders across runs.
2. **Collections (`Map`, `Set`)**: Iteration order reflects insertion history rather than sorted content. Two books with identical resting orders inserted in different chronological sequences would iterate differently if traversed naively.
3. **Numeric Representation**: Prices (integer ticks), quantities (integer lots), and sequence numbers (`seq`) use JavaScript `Number` validated via `Number.isSafeInteger(val) && val > 0` at the API boundary. This avoids the heap allocation, boxing, and arithmetic overhead of `BigInt` in V8, while safely supporting exact integer values up to `Number.MAX_SAFE_INTEGER` ($2^{53} - 1 \approx 9 \times 10^{15}$). If nanosecond timestamps require `BigInt`, serialization must format them explicitly since `JSON.stringify` throws on `BigInt`.
4. **Number Formatting**: JavaScript numbers are double-precision floats (IEEE 754). Within `Number.isSafeInteger` boundaries, integer values format deterministically in base-10 without exponential notation or floating-point rounding artifacts.

## Options Considered

1. **Standard `JSON.stringify` with Replacer**:
   - _Pros_: Built-in engine function.
   - _Cons_: Does not sort object keys recursively, does not sort Map entries by key, susceptible to key insertion order variations, fails on BigInt without replacer.

2. **Third-Party Canonical JSON Packages (e.g., `fast-json-stable-stringify`)**:
   - _Pros_: Tested canonical key sorting.
   - _Cons_: Does not handle native `Map`, `Set`, or arbitrary collections without pre-transformation; introduces external dependency.

3. **Deterministic State Projection with Recursive Canonical Serialization**:
   - _Pros_: Explicit, zero-dependency canonical serialization. Extracts engine state into a normalized schema: sorted array of instruments, sorted bids (by price descending, then sequence ascending), sorted asks (by price ascending, then sequence ascending), and orders sorted by order ID. Prices, quantities, and sequence numbers are formatted as exact base-10 integer strings. Object keys are sorted lexicographically at every depth. Fed directly into Node `crypto.createHash('sha256')`.
   - _Cons_: Requires maintaining a dedicated state projection function as engine state fields evolve.

## Decision

Adopt Option 3:

- Use JavaScript `Number` for prices (ticks), quantities (lots), and sequence numbers, validated strictly at the system boundary with `Number.isSafeInteger`.
- Implement deterministic state projection and SHA-256 canonical hashing in `src/engine/hash.js`.
- The canonical state hash incorporates three authoritative components:
  1. **Resting Orders in Price-Time Priority Order**:
     - Projected per instrument, sorted alphabetically by symbol.
     - `bids`: Sorted by price descending; within each price level, traversed strictly in FIFO queue order (`head` to `tail`).
     - `asks`: Sorted by price ascending; within each price level, traversed strictly in FIFO queue order (`head` to `tail`).
     - Order fields captured: `order_id`, `participant_id`, `price`, `remaining_qty`, `seq`, `ts`.
     - _Why_: Guarantees that active market depth, priority queues, and resting liquidity match bit-for-bit down to the lot across any host architecture.
  2. **Order Registry**:
     - All active and resting order records across all instruments, sorted strictly by `order_id` ascending.
     - Order fields captured: `order_id`, `participant_id`, `symbol`, `side`, `price`, `original_qty`, `remaining_qty`, `filled_qty`, `state`, `seq`, `ts`.
     - _Why_: Verifies that internal order indexes, quantity conservation, remaining balances, and terminal state flags match perfectly without ghost or orphaned nodes.
  3. **Trade Counter**:
     - Global cumulative trade execution sequence counter (`trade_id_seq`).
     - _Why_: Confirms that trade execution counts and match volumes are conserved and fully aligned with the durable trade ledger.
- Canonical JSON serialization with recursive key sorting:
  - Object keys are sorted lexicographically at every depth via `Object.keys().sort()`.
  - Numbers format deterministically in exact base-10 strings.
- The canonical UTF-8 payload is hashed using SHA-256, returning a lowercase 64-character hexadecimal digest.

## Consequences

- State hashing is completely independent of runtime memory layout, insertion order, or V8 hidden classes.
- Zero external dependencies.
- Prices and quantities execute without heap-allocation overhead in V8 hot loops.
- Any change to the state schema requires corresponding updates to the canonical projector.
