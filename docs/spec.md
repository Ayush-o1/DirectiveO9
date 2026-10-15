# DirectiveO9 Engine Specification

## 1. Domain Types and Units

All financial values in DirectiveO9 are represented as integers. No floating-point values are permitted in engine state, calculations, or persistent records.

- **Price**: Integer ticks. A price of `10050` with a tick size of `0.01` represents `$100.50`.
- **Quantity**: Integer lots. A quantity of `50` with a lot size of `1` represents 50 shares/contracts.
- **Sequence Number (`seq`)**: Strictly monotonic, gap-free 64-bit integer (`BigInt`) assigned by the sequencer.
- **Timestamp (`ts`)**: Monotonic nanosecond timestamp (`BigInt`) assigned by the sequencer at ingestion.
- **Side**: `BUY` or `SELL`.
- **Order Types**:
  - `LIMIT`: Matches against eligible resting orders. Any remaining unfilled quantity rests on the book at the limit price.
  - `MARKET`: Matches immediately against resting orders up to available liquidity. Any unfilled quantity is immediately cancelled; market orders never rest on the book.
  - `IOC` (Immediate-Or-Cancel): Matches immediately against resting orders up to the specified limit price. Any unfilled remainder is immediately cancelled and does not rest.
  - `CANCEL`: Cancels an active resting order by ID.

---

## 2. Priority and Matching Rules

1. **Price-Time Priority (FIFO)**:
   - Orders are matched first by best price: highest price for bids, lowest price for asks.
   - At a given price level, orders are matched by arrival sequence number (`seq`) in ascending order (earliest first).
2. **Trade Execution Price**:
   - The execution price of a trade is always the price of the **resting order** already on the book.
3. **Aggressor Side**:
   - The order initiating the match is the aggressor. Every trade record explicitly stores the aggressor side (`BUY` or `SELL`).
4. **Multi-Level Partial Fills**:
   - An incoming aggressing order matches across multiple price levels until its quantity is satisfied or no eligible price levels remain.
   - A single incoming command can emit multiple trade events across different resting orders and price levels.

---

## 3. Order Lifecycle and State Transitions

An order exists in exactly one of five discrete states:

- `NEW`: Order accepted into the book and resting with full quantity.
- `PARTIALLY_FILLED`: Order partially executed; remaining quantity rests on the book.
- `FILLED`: Order completely executed; terminal state (not on book).
- `CANCELLED`: Unfilled remainder cancelled; terminal state (not on book).
- `REJECTED`: Order failed validation; terminal state (never enters book).

### State Transition Table

| Current State      | Event                                                         | Target State       | Valid  | Note                                             |
| ------------------ | ------------------------------------------------------------- | ------------------ | ------ | ------------------------------------------------ |
| None               | Submit valid resting LIMIT                                    | `NEW`              | Yes    | Enters book at limit price                       |
| None               | Submit valid aggressive LIMIT/MARKET/IOC (full fill)          | `FILLED`           | Yes    | Never rests                                      |
| None               | Submit valid aggressive LIMIT (partial fill + remainder)      | `PARTIALLY_FILLED` | Yes    | Remainder rests on book                          |
| None               | Submit valid aggressive IOC/MARKET (partial fill + remainder) | `CANCELLED`        | Yes    | Filled portion emits trades, remainder cancelled |
| None               | Submit invalid command                                        | `REJECTED`         | Yes    | Emits rejection event with code                  |
| `NEW`              | Partial execution                                             | `PARTIALLY_FILLED` | Yes    | Decrements remaining quantity                    |
| `NEW`              | Full execution                                                | `FILLED`           | Yes    | Unlinks from book                                |
| `NEW`              | Cancel request                                                | `CANCELLED`        | Yes    | Unlinks from book                                |
| `PARTIALLY_FILLED` | Further partial execution                                     | `PARTIALLY_FILLED` | Yes    | Decrements remaining quantity                    |
| `PARTIALLY_FILLED` | Final execution                                               | `FILLED`           | Yes    | Unlinks from book                                |
| `PARTIALLY_FILLED` | Cancel request                                                | `CANCELLED`        | Yes    | Unlinks from book                                |
| `FILLED`           | Any                                                           | -                  | **No** | Terminal state; reject `ALREADY_TERMINAL`        |
| `CANCELLED`        | Any                                                           | -                  | **No** | Terminal state; reject `ALREADY_TERMINAL`        |
| `REJECTED`         | Any                                                           | -                  | **No** | Terminal state; reject `ALREADY_TERMINAL`        |

Any transition not explicitly permitted in this table is impossible and throws an invariant error.

---

## 4. Enumerated Reject Codes

When a command fails validation, the engine emits an `ORDER_REJECTED` event with one of the following enumerated codes:

1. `INVALID_TICK`: Price is not a positive multiple of the instrument's `tick_size`.
2. `INVALID_LOT`: Quantity is not a positive multiple of the instrument's `lot_size`.
3. `NON_POSITIVE_QUANTITY`: Quantity is less than or equal to zero.
4. `UNKNOWN_INSTRUMENT`: Symbol does not exist in registered instruments.
5. `UNKNOWN_ORDER`: Cancel command targets an order ID that does not exist in the active book.
6. `NOT_OWNER`: Cancel command participant does not match the participant who placed the order.
7. `ALREADY_TERMINAL`: Command targets an order that has already been FILLED, CANCELLED, or REJECTED.
8. `QUEUE_FULL`: Sequencer or book capacity threshold exceeded.

---

## 5. Pure Functional Engine Interface

The core matching engine has zero side effects and zero external dependencies:

```
(state, command) -> (state', events)
```

Rules enforced inside `src/engine`:

- No I/O operations (no network, no file system, no database).
- No non-deterministic functions (no `Date.now()`, no `new Date()`, no `Math.random()`, no `crypto.randomUUID()`).
- Monotonic sequence numbers and nanosecond timestamps are passed as explicit fields of the input `command`.
- State transitions return a new state reference or update state in-place deterministically while emitting a discrete array of immutable event records.

---

## 6. Book Data Structure Hypothesis

The matching book for each symbol is structured as:

1. **Sorted Price Levels**:
   - `bids`: Sorted array of price ticks in descending order.
   - `asks`: Sorted array of price ticks in ascending order.
   - Insertions and removals maintain sort order via binary search (`sortedIndex`).
2. **Price Level Map**:
   - `Map<price, Level>` for O(1) level lookup.
   - Each `Level` contains `price`, `total_volume`, `order_count`, and a doubly linked FIFO list (`head`, `tail`).
3. **Doubly Linked FIFO Queue**:
   - Each node contains `order_id`, `participant_id`, `price`, `remaining_qty`, `seq`, `ts`, `prev`, and `next`.
   - Appending a new resting order is O(1).
   - Dequeuing the head order on fill is O(1).
4. **Order Index**:
   - `Map<order_id, OrderNode>` storing references to active nodes across all levels.
   - Cancelling an order by ID is O(1) via node unlinking and level volume adjustment.

This structure is benchmarked against alternatives in Phase 5.

---

## 7. Engine Invariants

The following invariants must hold true after every command execution, during replay, and upon verification requests:

1. **Book Never Crossed**:
   - If both bids and asks exist, `max(bids.price) < min(asks.price)`.
2. **Single-Location Guarantee**:
   - Every resting order sits in exactly one price level FIFO queue and has exactly one corresponding entry in the `order_id` map.
3. **Non-Zero Quantity**:
   - Every resting order on the book has `remaining_qty > 0`. Zero-quantity orders must be unlinked.
4. **Conservation of Order Quantity**:
   - For every order: `filled_qty + remaining_qty == original_qty`.
5. **Conservation of Trade Volume**:
   - For every executed trade: `bought_qty == sold_qty`.
   - For every symbol: cumulative bought lots equals cumulative sold lots.
6. **Gap-Free Monotonic Sequence**:
   - Every processed command has `seq == previous_seq + 1n`.

---

## 8. Idempotency Specification

A submission of `(participant_id, client_order_id)` that matches an existing journal entry:

- Returns the original command execution result, including original `seq`, generated events, and trade fills.
- Does not modify engine state.
- Does not increment the sequence number.
- Does not emit a rejection event.
