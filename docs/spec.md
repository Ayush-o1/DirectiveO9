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
3. `INVALID_SIDE`: Side string is not `"BUY"` or `"SELL"`.
4. `NON_POSITIVE_QUANTITY`: Quantity is less than or equal to zero.
5. `UNKNOWN_INSTRUMENT`: Symbol does not exist in registered instruments.
6. `UNKNOWN_ORDER`: Cancel command targets an order ID that does not exist in the active book for the specified symbol.
7. `NOT_OWNER`: Cancel command participant does not match the participant who placed the order.
8. `ALREADY_TERMINAL`: Command targets an order that has already reached a terminal state (`FILLED`, `CANCELLED`, or `REJECTED`).
9. `DUPLICATE_ORDER`: An order with the specified internal `order_id` already exists within the engine's order index.
10. `QUEUE_FULL`: Sequencer or bounded ingress queue capacity threshold exceeded (HTTP 503 at API boundary).

### Distinction: Engine-Level `DUPLICATE_ORDER` vs API-Level Idempotency

It is critical to distinguish between duplicate rejection at the core engine and idempotent retry handling at the API sequencer:

- **Engine Level (`DUPLICATE_ORDER`)**:
  The matching engine operates on monotonic, engine-assigned internal order identifiers (`order_id`, derived deterministically from the sequencer command `seq`). If the engine is ever commanded to place an order whose `order_id` already exists in its internal index (`this.orders`), it emits an `ORDER_REJECTED` event with code `DUPLICATE_ORDER`. This invariant protects the order book and doubly linked list pointers against identity collisions and state corruption.

- **API / Sequencer Level (Idempotency on `client_order_id`)**:
  External participants interact with the system using client-scoped identifiers: `(participant_id, client_order_id)`. The API and Sequencer layer intercepts retries before the matching engine:
  - **Identical Retry**: When a client submits a command with a `(participant_id, client_order_id)` that was previously sequenced and committed, and the payload matches the original request, the API returns the original HTTP status code and event payload without generating a new `seq`, without writing a duplicate journal row, and without re-invoking the matching engine.
  - **Mismatched Payload (Conflict)**: When a client reuses an existing `client_order_id` with different order parameters (e.g., changed price, quantity, or side), the API immediately returns HTTP 409 Conflict. The conflicting command is never sequenced and never reaches the matching engine.
  - Therefore, healthy client retries never cause an engine-level `DUPLICATE_ORDER`. That reject code acts as an internal defensive guard against sequencer sequence drift or replay corruption.

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

## 10. Idempotency and Deduplication Specification

DirectiveO9 provides end-to-end idempotency backed authoritatively by the database journal:

1. **Source of Truth**:
   The PostgreSQL relational unique constraint `UNIQUE (participant_id, client_order_id)` on the `commands` table is the definitive source of truth for idempotency.
2. **In-Memory Cache**:
   The sequencer maintains a bounded LRU cache mapping `(participant_id, client_order_id)` to a canonical SHA-256 payload hash and the recorded execution result. This cache provides O(1) response for immediate retries without querying PostgreSQL. The cache is fully rebuildable upon startup by replaying the command journal.
3. **Identical Retries**:
   A submission of `(participant_id, client_order_id)` whose canonical payload matches the recorded hash returns the original execution result, including original `seq`, status code, and emitted events. It does not modify engine state, does not increment the sequence number, does not write a duplicate journal row, and does not emit a rejection event.
4. **Conflicting Retries (Payload Mismatch)**:
   A submission of an existing `(participant_id, client_order_id)` with different order parameters (such as altered price, quantity, side, or symbol) returns HTTP 409 Conflict. The conflicting request is rejected before entering the sequencer queue and never reaches the matching engine.
5. **In-Flight Coalescing**:
   Concurrent in-flight requests sharing the same `(participant_id, client_order_id)` within the same micro-batch are coalesced: exactly one command is sequenced and executed, while pending concurrent callers await and receive the identical result.

---

## 11. Deterministic Order ID Derivation

All internal order identifiers (`order_id`) are derived deterministically:

- For order placements (`LIMIT`, `MARKET`, `IOC`), `order_id` is derived directly from the command's monotonic sequence number (`order_id = seq`).
- Order identifiers are never generated from random UUIDs, pseudo-random generators, or system clocks.
- Cancel commands (`CANCEL`) explicitly reference the target `order_id`.
- This deterministic derivation guarantees that replaying the journal from sequence 0 reproduces identical order identifiers, price-level queue structures, and trade execution records across any host or architecture.

---

## 12. Boundary Validation vs. Sequenced Engine Rejections

DirectiveO9 enforces a strict architectural boundary between API schema validation and internal engine rejections:

1. **Schema-Invalid Requests (HTTP 400 Bad Request, Unsequenced)**:
   - Evaluated at the HTTP API layer prior to queue ingestion (via Zod schema validation).
   - Examples: malformed JSON, missing mandatory fields, negative or zero prices/quantities, non-safe integers, unrecognized side/type strings.
   - Handled synchronously with HTTP 400 Bad Request.
   - **Crucial Invariant**: Schema-invalid requests NEVER receive a sequence number (`seq`), NEVER enter the sequencer queue, and are NEVER written to the command journal.

2. **Domain Rejections by Matching Engine (Sequenced & Journaled)**:
   - Valid command payloads that fail domain business rules inside the matching engine (e.g., `UNKNOWN_ORDER`, `NOT_OWNER`, `UNKNOWN_INSTRUMENT`, `INVALID_TICK`, `ALREADY_TERMINAL`).
   - These commands ARE assigned a monotonic sequence number (`seq`), ARE processed by the single-writer sequencer, and ARE persisted to the PostgreSQL `commands` and `events` journal alongside an `ORDER_REJECTED` event.
   - **Crucial Invariant**: Sequencer sequence numbers have strictly zero gaps (`seq == previous_seq + 1`). Preserving domain rejections in the durable journal ensures that replaying historical commands reproduces the identical sequence of states and rejection events.

---

## 13. Batch Commit Failure and Fail-Stop State Recovery

If a database transaction failure occurs during the PostgreSQL group-commit phase after the matching engine has applied a batch in memory (such as storage I/O abort, lock timeout, or connection drop):

1. **Fail-Stop**: The sequencer immediately issues `ROLLBACK` on the database transaction and enters recovery mode (`isRecovering = true`).
2. **Batch Rejection**: All client command promises within the failed batch are rejected with HTTP 500 (`COMMIT_FAILED`). Acknowledgment is never sent for unpersisted commands.
3. **Refuse Ingress**: While recovery is active, new incoming submissions are refused with HTTP 503 Service Unavailable (`SERVICE_RECOVERING`).
4. **Journal Rebuild**: The sequencer resets the in-memory engine and replays the durable journal from sequence 1 up to the last committed sequence in PostgreSQL. This wipes unpersisted state changes from memory and reconciles book depth and active order pointers.
5. **Resume**: Sequence counters and idempotency caches are synchronized with the database, recovery mode is cleared (`isRecovering = false`), and the sequencer resumes normal ingestion.

---

## 14. Write-Ahead Logging & the `synchronous_commit` Durability Trade-Off

DirectiveO9 relies on PostgreSQL write-ahead logging (WAL) for durability and disaster recovery. PostgreSQL provides a runtime configuration parameter, `synchronous_commit`, which governs whether a transaction commit waits for WAL records to be physically flushed to persistent disk storage before returning success to the application.

### Primary Source Citations

1. **PostgreSQL Official Documentation**, Chapter 30: _Reliability and the Write-Ahead Log_, Section 30.5: _Asynchronous Commit_. URL: https://www.postgresql.org/docs/current/wal-async-commit.html
2. **PostgreSQL Official Documentation**, Chapter 20: _Server Configuration_, Section 20.5.1: _Write-Ahead Log (WAL) - synchronous_commit_. URL: https://www.postgresql.org/docs/current/runtime-config-wal.html#GUC-SYNCHRONOUS-COMMIT

### The Engineering Trade-Off

| Mode                                                   | Durability Guarantee                                                                                                                                               | Write Latency                                                                                 | Throughput Profile                                                                 | Failure Behavior                                                                                                                                                                                                   |
| :----------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`synchronous_commit = on`** _(DirectiveO9 Default)_  | **Strict Durability (Zero Data Loss, RPO = 0)**. A committed transaction is guaranteed to survive an operating system crash, sudden power outage, or process kill. | **Bound by Disk I/O**. Each commit blocks on physical `fsync`/`fdatasync` to disk.            | Lower per-transaction throughput unless amortized via group-commit micro-batching. | In a crash, every acknowledged command exists in the WAL and is fully recovered on restart.                                                                                                                        |
| **`synchronous_commit = off`** _(Asynchronous Commit)_ | **Bounded Window Loss (RPO > 0)**. Commits return immediately after WAL records are written to memory buffers, before physical disk flush.                         | **Sub-millisecond**. Commits return at memory speed without blocking on disk synchronization. | Up to 3x–5x higher throughput under disk-constrained workloads.                    | In a sudden OS crash or power cut, recent transactions within `wal_writer_delay * 3` (up to ~600ms) can be lost. Database internal consistency is preserved, but previously acknowledged client orders may vanish. |

### Architectural Choice in DirectiveO9

DirectiveO9 strictly mandates `synchronous_commit = on` as its operational default:

- **Journal-Before-Ack Compliance**: DirectiveO9's core contract is that an acknowledgment to a market participant guarantees deterministic recoverability. If `synchronous_commit = off` were used, an unexpected crash could acknowledge an order that subsequently disappears upon restart, permanently corrupting client trust and violating financial auditability.
- **Micro-Batch Amortization**: Rather than weakening durability to achieve performance, DirectiveO9 resolves the disk latency bottleneck through **group commit micro-batching** in `Sequencer`. The sequencer coalesces up to `BATCH_MAX_SIZE` commands (or waits up to `BATCH_TIMEOUT_MS = 5ms`) and commits them in a single multi-row database transaction. This amortizes the physical `fsync` cost across dozens or hundreds of orders simultaneously, yielding high throughput while strictly maintaining `synchronous_commit = on`.
- **Benchmarking Benchmark Ceiling**: The benchmark harness supports overriding `synchronous_commit = off` solely for measuring in-memory engine and serialization throughput ceilings without storage hardware constraints.
