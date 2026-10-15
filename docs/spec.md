# DirectiveO9 Engine Specification

## 1. Domain Types and Units

All financial values in DirectiveO9 are represented as integers. No floating-point values are permitted in engine state, calculations, or persistent records.

- **Price**: Integer ticks represented as JavaScript `Number`, validated at the boundary via `Number.isSafeInteger(price) && price > 0`.
- **Quantity**: Integer lots represented as JavaScript `Number`, validated at the boundary via `Number.isSafeInteger(quantity) && quantity > 0`.
- **Sequence Number (`seq`)**: Strictly monotonic, gap-free integer represented as JavaScript `Number` (`Number.isSafeInteger(seq) && seq >= 1`), assigned by the sequencer.
- **Timestamp (`ts`)**: Monotonic microsecond integer timestamp represented as JavaScript `Number` (`Number.isSafeInteger(ts) && ts > 0`), assigned by the sequencer at ingestion.
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

## 4. Special Matching Rules & Known Limitations

1. **Market Orders on an Empty Book**:
   - When a MARKET order is submitted and no eligible resting orders exist on the opposite side, zero trades are executed.
   - Market orders never rest on the book. The entire order quantity is immediately cancelled.
   - The engine emits a single `ORDER_CANCELLED` event with `remaining_qty: quantity` and `reason: "MARKET_UNFILLED"`. This is a normal terminal state, not an error reject.

2. **Immediate-Or-Cancel (IOC) Partial Fills**:
   - An IOC order aggressively matches against eligible resting orders up to its specified limit price.
   - As soon as no eligible price levels remain or available liquidity is exhausted, any unfilled remainder is immediately cancelled.
   - The engine emits `TRADE_EXECUTED` (and maker `ORDER_FILLED` events where applicable) for each match, followed by `ORDER_CANCELLED` with `reason: "IOC_UNFILLED"` for the unfilled remainder.

3. **Crossing Limit Order that Partially Rests**:
   - A LIMIT order whose price crosses the inside market matches resting orders at or better than its limit price.
   - If opposite liquidity is fully exhausted and the aggressor still has remaining quantity, that remaining quantity rests on the book at the aggressor's limit price.
   - The engine emits `TRADE_EXECUTED` (and maker `ORDER_FILLED`) for each fill, followed by `ORDER_ACCEPTED` for the resting remainder.

4. **Self-Trade / Internal Crossing (Known Limitation)**:
   - In this educational simulator MVP, participants are allowed to trade against their own resting orders.
   - When an aggressor crosses an order placed by the same `participant_id`, a trade executes normally with `maker_participant_id === taker_participant_id`.
   - Self-Trade Prevention (STP) policies are not enforced.

---

## 5. Event Schema & Deterministic Event Ordering

Every command processed by the matching engine emits an array of zero or more discrete event objects.

### Event Types and Field Schemas

1. `TRADE_EXECUTED`:
   ```json
   {
     "event": "TRADE_EXECUTED",
     "trade_id": 1,
     "symbol": "BTC-USDT",
     "price": 100,
     "quantity": 5,
     "maker_order_id": 101,
     "taker_order_id": 102,
     "maker_participant_id": 1,
     "taker_participant_id": 2,
     "taker_side": "BUY",
     "seq": 42,
     "ts": 1000
   }
   ```
2. `ORDER_FILLED`:
   ```json
   {
     "event": "ORDER_FILLED",
     "order_id": 101,
     "participant_id": 1,
     "symbol": "BTC-USDT",
     "side": "SELL",
     "price": 100,
     "filled_qty": 5,
     "seq": 42,
     "ts": 1000
   }
   ```
3. `ORDER_ACCEPTED`:
   ```json
   {
     "event": "ORDER_ACCEPTED",
     "order_id": 102,
     "participant_id": 2,
     "symbol": "BTC-USDT",
     "side": "BUY",
     "price": 100,
     "quantity": 10,
     "remaining_qty": 5,
     "seq": 42,
     "ts": 1000
   }
   ```
4. `ORDER_CANCELLED`:
   ```json
   {
     "event": "ORDER_CANCELLED",
     "order_id": 102,
     "participant_id": 2,
     "symbol": "BTC-USDT",
     "side": "BUY",
     "price": 100,
     "original_qty": 10,
     "remaining_qty": 5,
     "reason": "CLIENT_CANCEL",
     "seq": 43,
     "ts": 1001
   }
   ```
5. `ORDER_REJECTED`:
   ```json
   {
     "event": "ORDER_REJECTED",
     "code": "UNKNOWN_ORDER",
     "order_id": 999,
     "participant_id": 2,
     "seq": 44,
     "ts": 1002
   }
   ```

### Deterministic Event Ordering Within a Command

For a single command, events are emitted in strict chronological order:

1. For each resting order matched during aggressive execution:
   a. Exactly one `TRADE_EXECUTED` event.
   b. If the maker order's remaining quantity is reduced to zero: exactly one `ORDER_FILLED` event for the maker order.
2. After matching loop finishes, for the incoming aggressor order:
   - If completely filled: exactly one `ORDER_FILLED` event for the taker.
   - If LIMIT order with remaining quantity: exactly one `ORDER_ACCEPTED` event for the taker with `remaining_qty`.
   - If IOC order with remaining quantity: exactly one `ORDER_CANCELLED` event with `reason: "IOC_UNFILLED"`.
   - If MARKET order with remaining quantity (or empty book): exactly one `ORDER_CANCELLED` event with `reason: "MARKET_UNFILLED"`.
3. For a CANCEL command:
   - If order is active and owned by participant: exactly one `ORDER_CANCELLED` event with `reason: "CLIENT_CANCEL"`.
   - If order is unknown: exactly one `ORDER_REJECTED` event with code `UNKNOWN_ORDER`.
   - If caller is not owner: exactly one `ORDER_REJECTED` event with code `NOT_OWNER`.
   - If order is already terminal: exactly one `ORDER_REJECTED` event with code `ALREADY_TERMINAL`.
4. For any command failing validation (tick, lot, non-positive quantity, unknown symbol):
   - Exactly one `ORDER_REJECTED` event with the corresponding reject code.

---

## 6. Enumerated Reject Codes

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

## 7. Pure Functional Engine Interface

The core matching engine has zero side effects and zero external dependencies:

```
(state, command) -> (state', events)
```

Rules enforced inside `src/engine`:

- No I/O operations (no network, no file system, no database).
- No non-deterministic functions (no `Date.now()`, no `new Date()`, no `Math.random()`, no `crypto.randomUUID()`).
- Monotonic sequence numbers and microsecond timestamps are passed as explicit fields of the input `command`.
- State transitions return a new state reference or update state in-place deterministically while emitting a discrete array of immutable event records.

---

## 8. Book Data Structure Hypothesis

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

## 9. Engine Invariants

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
   - Every processed command has `seq == previous_seq + 1`.

---

## 10. Idempotency Specification

A submission of `(participant_id, client_order_id)` that matches an existing journal entry:

- Returns the original command execution result, including original `seq`, generated events, and trade fills.
- Does not modify engine state.
- Does not increment the sequence number.
- Does not emit a rejection event.
