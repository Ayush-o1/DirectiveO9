# 2. Canonical State Hashing and Serialization

Date: 2026-10-15

## Status

Accepted

## Context

Deterministic replay verification requires computing a cryptographic state hash (SHA-256) of the matching engine state after any arbitrary sequence number. Two separate runs processing identical commands from genesis must produce identical state hashes byte-for-byte.

JavaScript environments present specific serialization pitfalls:

1. **Property Iteration Order**: While ES2015 defines deterministic property traversal order (integer indices ascending, followed by insertion order for string keys, followed by Symbols), property assignment timing or internal hidden-class transitions can alter insertion orders across runs.
2. **Collections (`Map`, `Set`)**: Iteration order reflects insertion history rather than sorted content. Two books with identical resting orders inserted in different chronological sequences would iterate differently if traversed naively.
3. **BigInt Handling**: DirectiveO9 uses integer ticks, integer lots, sequence numbers, and nanosecond timestamps. In JavaScript, standard `JSON.stringify()` throws `TypeError: Do not know how to serialize a BigInt`.
4. **Number Formatting**: JavaScript numbers are double-precision floats (IEEE 754), susceptible to formatting differences (`-0` vs `+0`, scientific notation).

## Options Considered

1. **Standard `JSON.stringify` with Replacer**:
   - _Pros_: Built-in engine function.
   - _Cons_: Fails on BigInt without replacer, does not sort object keys recursively, does not sort Map entries by key, susceptible to key insertion order variations.

2. **Third-Party Canonical JSON Packages (e.g., `fast-json-stable-stringify`)**:
   - _Pros_: Tested canonical key sorting.
   - _Cons_: Does not handle native `Map`, `Set`, or `BigInt` primitives without pre-transformation; introduces external dependency.

3. **Deterministic State Projection with Recursive Canonical Serialization**:
   - _Pros_: Explicit, zero-dependency canonical serialization. Extracts engine state into a normalized schema: sorted array of instruments, sorted bids (by price descending, then sequence ascending), sorted asks (by price ascending, then sequence ascending), and orders sorted by order ID. BigInt values are converted to string format (`<value>n`). Object keys are sorted lexicographically at every depth. Fed directly into Node `crypto.createHash('sha256')`.
   - _Cons_: Requires maintaining a dedicated state projection function as engine state fields evolve.

## Decision

Adopt Option 3:

- Define an explicit canonical state representation in `src/engine/hash.js`.
- Price levels, active orders, and instrument states are projected into canonical sorted arrays.
- Object keys are sorted recursively via `Object.keys().sort()`.
- BigInt values are formatted deterministically as base-10 strings with an explicit suffix (`${val.toString()}n`).
- The canonical UTF-8 payload is hashed using SHA-256, returning a lowercase 64-character hex digest.

## Consequences

- State hashing is completely independent of runtime memory layout, insertion order, or V8 hidden classes.
- Zero external dependencies.
- Any change to the state schema requires corresponding updates to the canonical projector.
