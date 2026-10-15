# DirectiveO9 System Architecture

DirectiveO9 is a deterministic limit-order-book matching engine engineered for strict reproducible execution, crash durability, and verifiable replay. This document outlines the architectural lifecycle of orders, the write path, replay path, recovery path, and failure handling semantics.

---

## Architecture Overview

```
                      +-----------------------------+
                      |   HTTP / SSE Clients        |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |   REST API / Validation     |
                      |   (Express, Zod, Auth)      |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |   Bounded Ingestion Queue   |
                      +--------------+--------------+
                                     |
                                     v
  +-----------------------------------------------------------------+
  |                  Sequencer (Single Writer)                      |
  |                                                                 |
  |  1. Assign Monotonic Sequence Number and Ingestion Timestamp    |
  |  2. Pure Matching Engine State Transition:                      |
  |     (state, command) -> (state', events)                        |
  |  3. Group-Commit Persistence (PostgreSQL Transaction):          |
  |     - Commands Journal                                          |
  |     - Events Journal                                            |
  |     - Trades Journal                                            |
  |     - Projections Upsert                                        |
  |  4. Resolve In-Flight Client Promises (HTTP 201/200)            |
  |  5. Publish Live Market Data over Server-Sent Events (SSE)      |
  +-----------------------------------------------------------------+
```

---

## 1. The Write Path

The write path is structured around the single-writer principle, ensuring deterministic ordering without distributed locks or race conditions.

### Step 1: Ingestion & Boundary Validation

- Requests arrive via REST endpoints (`POST /orders`, `DELETE /orders/:id`).
- Input payloads are validated synchronously at the API boundary using Zod schemas (`src/api/schemas.js`).
- Invalid inputs (e.g., negative quantities, non-integer ticks/lots, malformed symbols) are rejected immediately with HTTP 400 Bad Request. **Malformed requests are never sequenced and never written to the journal.**

### Step 2: Authentication

- Every request carries an `x-api-key` header.
- The API hashes the incoming key using SHA-256 and compares it against pre-hashed participant credentials stored in PostgreSQL (`participants` table).
- Unauthenticated or unauthorized participants receive HTTP 401 Unauthorized or HTTP 403 Forbidden.

### Step 3: Idempotency Verification

To guarantee exactly-once processing semantics over unreliable networks:

1. **Committed LRU Cache**: The sequencer checks an in-memory bounded LRU cache (`IdempotencyCache`) for the tuple `(participant_id, client_order_id)`. If present:
   - If payload SHA-256 matches, the original response status and body are returned immediately.
   - If payload differs, HTTP 409 Conflict is returned.
2. **In-Flight Coalescing**: If a request with the same `(participant_id, client_order_id)` is currently queued or executing, the incoming request attaches its callback to the existing in-flight promise rather than queuing duplicate work.
3. **Database Constraint Resolution**: If the tuple is evicted from the in-memory cache, the sequencer queries the `commands` table in PostgreSQL. The unique constraint `UNIQUE (participant_id, client_order_id)` ensures duplicate submissions after cache eviction resolve consistently.

### Step 4: Bounded Ingestion Queue

- Validated commands enter an in-memory FIFO queue (`this.queue`).
- Queue capacity is strictly bounded (`maxQueueSize = 1000`).
- If the queue is saturated, incoming requests are rejected immediately with HTTP 503 Service Unavailable (`QUEUE_FULL`) and a `Retry-After: 1` header, preventing unbounded memory consumption.

### Step 5: Batch Formation & Single-Writer Execution

- A micro-batch is formed when either:
  1. `this.queue.length >= batchMaxSize` (default 100 commands), or
  2. `batchTimeoutMs` expires (default 5 ms).
- The sequencer assigns a strictly monotonic, gap-free sequence number (`seq = lastSeq + 1`) and a batch timestamp.
- For order placements (`LIMIT`, `MARKET`, `IOC`), the engine assigns deterministic order IDs: `order_id = seq`. No UUIDs or non-deterministic generators are used.

### Step 6: Pure In-Memory Matching

- Commands are processed through the core `MatchingEngine` (`src/engine/engine.js`).
- The engine operates as a pure state machine: `(state, command) -> (state', events)`.
- It executes orders with price-time priority (FIFO) using doubly linked lists per price level and binary-search sorted price arrays.
- Emitted events include `ORDER_PLACED`, `ORDER_FILLED`, `ORDER_CANCELLED`, and `ORDER_REJECTED`.

### Step 7: Group-Commit Persistence (PostgreSQL)

All commands, events, executed trades, and order projection updates for the batch are persisted within a single atomic PostgreSQL transaction (`BEGIN ... COMMIT`):

- `commands`: Sequence number, command type, participant ID, client order ID, symbol, price, quantity, order ID, payload hash, status, response status, response body, timestamp.
- `events`: Monotonic event ID, sequence number, event type, order ID, participant ID, payload, timestamp.
- `trades`: Monotonic trade ID, sequence number, symbol, price, quantity, maker/taker order IDs, maker/taker participant IDs, taker side, timestamp.
- `orders`: Projection table upserting cumulative filled quantities and terminal states for external querying.

### Step 8: Client Acknowledgment & Market Data Fanout

- Once PostgreSQL transaction commit succeeds:
  1. Client callbacks waiting on `enqueue()` are resolved with HTTP 201 Created or HTTP 200 OK.
  2. Emitted events, trade executions, and updated L2 order book depth snapshots are dispatched to the Server-Sent Events (SSE) hub for real-time broadcast to connected clients (`/stream`).

---

## 2. The Replay Path

The replay path provides offline and online auditability, proving that the entire system state can be reconstructed bit-for-bit from the durable command journal.

```
  +-------------------------+
  |  PostgreSQL Journal     |
  |  (commands, events)     |
  +------------+------------+
               |
               v
  +-------------------------+
  |  Replay Harness         |
  |  (src/sequencer/replay) |
  +------------+------------+
               |
        +------+------+
        |             |
        v             v
  +-----------+ +-----------+
  | Fresh     | | Naive     |
  | Engine    | | Reference |
  | Instance  | | Oracle    |
  +-----+-----+ +-----+-----+
        |             |
        +------+------+
               |
               v Bit-for-bit Parity Verification
  +-------------------------+
  | Canonical State Hash    |
  | (SHA-256, ADR 0002)     |
  +-------------------------+
```

### Execution Flow

1. **Cold Engine Instantiation**: The replay runner instantiates a brand new `MatchingEngine` instance. If `--oracle` is enabled, an independent `NaiveEngine` reference oracle is also instantiated.
2. **Sequential Log Ingestion**: Replays all commands from sequence `fromSeq` (default 1) through `toSeq` (default latest sequence in database) ordered strictly by `seq ASC`.
3. **Parity Check**:
   - For every replayed command, emitted events and trades are compared bit-for-bit against stored rows in PostgreSQL.
   - Any divergence in event type, price, quantity, maker/taker ID, or order status immediately halts execution with an explanatory error.
4. **Invariant Auditing**: After log completion, the engine validates the 6 structural invariants across all order books:
   - Invariant 1: Highest bid price < lowest ask price (book never crossed).
   - Invariant 2: Active resting orders exist in exactly one FIFO queue and lookup index.
   - Invariant 3: Resting orders have strictly positive remaining quantity.
   - Invariant 4: `filled_qty + remaining_qty == original_qty` for every order.
   - Invariant 5: Total cumulative bought volume == total cumulative sold volume per symbol.
   - Invariant 6: Sequence numbers are strictly contiguous and monotonic without gaps.
5. **Canonical State Hashing**: Computes a deterministic SHA-256 state hash per ADR 0002 covering symbol order books, sorted price levels, and FIFO queue order records.

---

## 3. The Recovery Path

When the API server starts up or recovers from an unexpected process termination, it executes the recovery sequence before accepting external traffic:

1. **Schema Check**: Validates that all migrations have been applied (`src/db/migrator.js`).
2. **Instrument Discovery**: Reads registered trading pairs from PostgreSQL (`instruments` table) and initializes corresponding `OrderBook` instances.
3. **Journal Scan**: Queries `MAX(seq)` from `commands`. If `max_seq > 0`, loads all historical commands from sequence 1 through `max_seq`.
4. **State Reconstruction**: Replays every journaled command through the in-memory engine, verifying event and trade parity against stored rows.
5. **Sequence Realignment**: Sets `this.lastSeq = max_seq`.
6. **API Binding**: Binds the HTTP listener and opens the bounded ingestion queue to live traffic.

---

## 4. Failure Handling Semantics

| Failure Scenario                                | Engine & Sequencer Behavior                                                                                                                                       | Client Impact & Recovery                                                                                                                                                              |
| :---------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Batch Commit Failure (DB Error)**             | Sequencer triggers fail-stop: sets `isRecovering = true`, aborts transaction, resets in-memory engine, and replays journal from DB up to last committed sequence. | Commands in the uncommitted batch fail with HTTP 500 `COMMIT_FAILED`. Ingestion returns HTTP 503 `SERVICE_RECOVERING` until rebuild completes.                                        |
| **Process Crash (`SIGKILL`)**                   | Process terminates immediately. In-flight uncommitted memory state is discarded cleanly. Committed transactions remain durable on disk in PostgreSQL WAL.         | Uncommitted requests experience socket drop. On process restart, journal recovery reconstructs state up to the last durable sequence. Clients retry using the same `client_order_id`. |
| **Duplicate Request (Network Retry)**           | Sequencer intercepts via in-memory LRU cache or PostgreSQL `(participant_id, client_order_id)` unique constraint.                                                 | If payload matches, original response is returned (idempotent 200/201). If payload differs, rejected with HTTP 409 `IDEMPOTENCY_CONFLICT`.                                            |
| **Queue Saturation**                            | When `queue.length >= maxQueueSize`, sequencer rejects command before memory growth occurs.                                                                       | Client receives HTTP 503 `QUEUE_FULL` with `Retry-After: 1` header. Engine state and sequence counter remain untouched.                                                               |
| **Unauthorized Action (e.g. Cancel Not Owner)** | Sequencer validates ownership against in-memory order registry. Non-owner cancel produces `ORDER_REJECTED` event (`NOT_OWNER`).                                   | Request receives HTTP 422 Unprocessable Entity. Rejection is journaled to maintain gap-free sequence monotonicity.                                                                    |
| **State Invariant Divergence**                  | Invariant check throws an error, halting processing before corrupt state can be committed or propagated.                                                          | Fail-stop behavior prevents state pollution; audit trail preserved in journal for diagnostic analysis.                                                                                |
