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

## Order Book Core & Matching Engine

The order book and matching engine (`src/engine/`) maintain deterministic price-time priority (FIFO):

- **Sorted Price Levels (`src/engine/level.js`)**: Sorted arrays of price points (`bids` descending, `asks` ascending) indexed using binary search.
- **Price Level FIFO Queues (`src/engine/queue.js`)**: Doubly linked lists per price level supporting O(1) order enqueuing and O(1) head dequeuing.
- **Order Lookup Index**: Direct map of active orders (`Map<order_id, Node>`) enabling O(1) cancellation and pointer unlinking.
- **Matching Pipeline (`src/engine/engine.js`)**: Multi-instrument matching engine supporting `LIMIT`, `MARKET`, `IOC`, and `CANCEL` commands with multi-level liquidity sweeping and strict quantity conservation.
- **Differential Verification (`test/differential.test.js`)**: Independent naive reference oracle (`test/oracle/naive-engine.js`) written with plain arrays and linear scans, fuzz-tested using `fast-check` with full state and depth differential comparison and online invariant validation.
- **Golden Scenarios (`test/fixtures/`)**: 38 language-neutral JSON scenario specifications defining sequential input commands, expected emitted events, and verified book depth states.

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

The PostgreSQL container maps container port `5432` to host port `5433` to prevent port collisions with any existing local PostgreSQL service:

```bash
# Start PostgreSQL on host port 5433
docker compose up -d postgres

# Run database migrations and seed default participants/instruments
node scripts/seed.js
```

### 4. Benchmarking & Empirical Verification

```bash
# In-memory engine benchmark (sorted array vs AVL tree, shallow vs deep)
npm run bench:engine

# End-to-end API group-commit benchmark (autocannon fixed rate)
npm run bench:api

# Startup recovery scaling & heap growth benchmark
npm run bench:recovery

# Generate docs/benchmarks.md strictly from raw JSON telemetry
npm run bench:report
```

### 5. Operator UI Dashboard

Start the API server and navigate to `http://localhost:3000`:

```bash
npm start
```

The web interface (`ui/`) serves:

- Real-time order book depth ladder with proportional volume visualization.
- Live trade tape and sequenced engine event logs over Server-Sent Events (SSE).
- Order entry and cancellation forms with explicit client-side API key transmission.
- Live replay verification button executing independent naive oracle audits over `/admin/replay`.

---

## Documentation

- [Engine Specification](docs/spec.md)
- [API Specification](docs/api.md)
- [Empirical Benchmarks & Verification Report](docs/benchmarks.md)
- [Development Roadmap](docs/roadmap.md)
- [Architecture Decision Records](docs/decisions/)
  - [0001: Price-Level Data Structure](docs/decisions/0001-price-level-data-structure.md)
  - [0002: Canonical State Hashing and Serialization](docs/decisions/0002-canonical-state-hashing.md)
  - [0003: Group-Commit Journaling in PostgreSQL](docs/decisions/0003-group-commit-journaling.md)
  - [0004: Idempotent Command Handling](docs/decisions/0004-idempotent-command-handling.md)
  - [0005: Property-Based Testing and Differential Verification](docs/decisions/0005-property-based-testing.md)
  - [0006: Benchmarking Methodology](docs/decisions/0006-benchmarking-methodology.md)
  - [0007: Dependency Rationales](docs/decisions/0007-dependencies-rationale.md)
  - [0008: Plain SQL Migrations Without a Migration Library](docs/decisions/0008-plain-sql-migrations.md)
  - [0009: Price-Level Index Data Structure Comparison](docs/decisions/0009-price-level-index-data-structure.md)

---

## License

This project is licensed under the [MIT License](LICENSE).
