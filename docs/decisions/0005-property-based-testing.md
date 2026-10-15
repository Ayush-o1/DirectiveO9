# 5. Property-Based Testing and Differential Verification

Date: 2026-10-15

## Status

Accepted

## Context

A limit-order-book matching engine has a large combinatorial state space: multi-level price sweeps, partial fills at multiple tick levels, cancellations of head/middle/tail queue nodes, immediate-or-cancel residual cancellations, and market orders exhausting liquidity.

Hand-written unit tests only test scenarios anticipated by the engineer. To verify correctness across edge cases, we require:

1. Differential testing against an independently authored reference implementation (naive oracle).
2. Automated generative property-based testing using `fast-check`.
3. Invariant validation across every single state transition.

## Options Considered

1. **Unit Tests and Golden Fixtures Only**:
   - _Pros_: Fast execution, deterministic regression baseline.
   - _Cons_: Cannot discover unanticipated edge cases in multi-command interleavings.

2. **Model-Based Testing with `fast-check` and Naive Oracle**:
   - _Pros_:
     - `fast-check` generates hundreds of randomized, shrinkable command sequences (Limit, Market, IOC, Cancel across multiple participants and price points).
     - An independent naive oracle in `test/oracle/` implements the specification using simple linear scans (no complex data structures).
     - Every command execution compares:
       a) Emitted event sequences between engine and oracle.
       b) Canonical state hash between engine and oracle.
       c) Invariant assertions after every command.
     - When an invariant fails, `fast-check` automatically shrinks the command sequence to the minimal failing reproduction.
   - _Cons_: Slower test runtime than pure unit tests (must be parameterized to run efficiently in CI).

## Decision

Adopt Option 2:

- Write an independent naive oracle (`test/oracle/naive-engine.js`) that maintains resting orders in an unsorted list and executes matches via straightforward linear searches.
- Use `fast-check` to generate randomized valid command streams (100 to 1,000 steps per run).
- Execute commands simultaneously against both DirectiveO9 and the naive oracle.
- Assert strict equality of returned events and canonical state hashes.
- Verify the 6 structural invariants after every step:
  1. Book never crossed (`best_bid < best_ask`).
  2. Every resting order sits in exactly one price level and in the order index.
  3. No zero-quantity or negative-quantity resting order.
  4. Conservation of order quantity: `filled_qty + remaining_qty == original_qty`.
  5. Conservation of trade volume: `bought_qty == sold_qty` for every trade, and cumulative symbol bought == cumulative symbol sold.
  6. Sequence numbers are strictly monotonic and gap-free.

## Consequences

- High confidence in engine determinism and correctness.
- Bugs in optimization (pointer manipulation, binary search, map pruning) are caught by differential divergence from the naive oracle.
