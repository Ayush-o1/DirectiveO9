# DirectiveO9

DirectiveO9 is a deterministic limit-order-book matching engine featuring a durable command journal, verifiable state replay, and online invariant verification.

The engine executes orders with strict price-time priority (FIFO) using integer ticks and integer lots. The core engine is structured as a pure function `(state, command) -> (state', events)` with zero I/O side effects, enabling bit-for-bit reproducible execution from the command journal.

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
  |  2. Group-Commit Append to Durable Journal (PostgreSQL)         |
  |  3. Apply Command to Pure Matching Engine State                 |
  |  4. Persist Events, Trades, and Projections                     |
  |  5. Acknowledge Client and Publish Market Data over SSE         |
  +-----------------------------------------------------------------+
```

---

## Core Invariants

The matching engine verifies six structural invariants across state transitions and during replay:

1. **Book Never Crossed**: The highest bid price is strictly less than the lowest ask price.
2. **Single Location**: Every active resting order resides in exactly one price level FIFO queue and the order lookup index.
3. **Non-Zero Quantity**: Every resting order has a strictly positive remaining quantity.
4. **Conservation of Order Quantity**: For every order, `filled_quantity + remaining_quantity == original_quantity`.
5. **Conservation of Trade Volume**: For every trade, `bought_quantity == sold_quantity`. Per-symbol cumulative bought equals cumulative sold.
6. **Gap-Free Monotonic Sequence**: Sequenced commands form a strictly contiguous sequence without gaps.

---

## Order Book Core

The order book (`src/engine/book.js`) maintains deterministic price-time priority (FIFO):

- **Sorted Price Levels (`src/engine/level.js`)**: Sorted arrays of price points (`bids` descending, `asks` ascending) indexed using binary search.
- **Price Level FIFO Queues (`src/engine/queue.js`)**: Doubly linked lists per price level supporting O(1) order enqueuing and O(1) head dequeuing.
- **Order Lookup Index**: Direct map of active orders (`Map<order_id, Node>`) enabling O(1) cancellation and pointer unlinking.
- **Golden Scenarios (`test/fixtures/`)**: 16 language-neutral JSON scenario specifications defining sequential input commands, expected emitted events, and verified book depth states.

---

## Technology Stack

- **Runtime**: Node.js (>= 20.0.0, ES Modules)
- **Database**: PostgreSQL 16 (accessed via `pg` driver with raw SQL migrations)
- **API**: Express, Zod (schema validation), Server-Sent Events (SSE)
- **Testing**: Built-in `node:test`, `c8` (V8 code coverage), `fast-check` (property-based invariant tests)
- **Benchmarking**: `autocannon` (HTTP load tests), native high-resolution monotonic timer harnesses

---

## Prerequisites

- Node.js >= 20.0.0
- npm >= 10.0.0
- Docker and Docker Compose (for local PostgreSQL 16)

---

## Setup & Execution

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/Ayush-o1/DirectiveO9.git
cd DirectiveO9
npm ci
```

### 2. Code Quality Checks

```bash
# Check formatting
npm run format:check

# Run linter
npm run lint

# Run test suite with coverage
npm run test:coverage
```

### 3. Local Database (Docker Compose)

```bash
docker compose up -d postgres
```

---

## Documentation

- [Engine Specification](docs/spec.md)
- [API Specification](docs/api.md)
- [Development Roadmap](docs/roadmap.md)
- [Architecture Decision Records](docs/decisions/)
  - [0001: Price-Level Data Structure](docs/decisions/0001-price-level-data-structure.md)
  - [0002: Canonical State Hashing and Serialization](docs/decisions/0002-canonical-state-hashing.md)
  - [0003: Group-Commit Journaling in PostgreSQL](docs/decisions/0003-group-commit-journaling.md)
  - [0004: Idempotent Command Handling](docs/decisions/0004-idempotent-command-handling.md)
  - [0005: Property-Based Testing and Differential Verification](docs/decisions/0005-property-based-testing.md)
  - [0006: Benchmarking Methodology](docs/decisions/0006-benchmarking-methodology.md)
  - [0007: Dependency Rationales](docs/decisions/0007-dependencies-rationale.md)

---

## License

This project is licensed under the [MIT License](LICENSE).
