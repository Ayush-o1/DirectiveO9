# DirectiveO9 Development Roadmap

This document outlines the phased development plan for DirectiveO9, incorporating architectural decisions and testing methodologies.

---

## Phase 0: Foundation [Completed]

- **Objective**: Establish development tooling, CI pipeline, directory structure, specification, and decision records.
- **Deliverables**:
  - Git repository with `main` and phase branches.
  - Project directory layout: `src/`, `test/`, `bench/`, `docs/`, `migrations/`, `ui/`, `scripts/`.
  - Node.js ESM configuration with `package.json`, ESLint 9, Prettier, `.editorconfig`, `.gitignore`.
  - MIT License and `.env.example`.
  - GitHub Actions CI workflow testing lint, formatting, and unit tests against PostgreSQL 16 service.
  - Architecture specifications in `docs/spec.md`.
  - Architecture Decision Records (ADRs) 0001 through 0007 in `docs/decisions/`.
  - `README.md` skeleton.

---

## Phase 1: Book Core [Completed]

- **Objective**: Implement the deterministic single-symbol order book data structures and depth projection.
- **Deliverables**:
  - Doubly linked list queue for FIFO price levels (`src/engine/queue.js`).
  - Sorted price-level management with binary search (`src/engine/level.js`).
  - Order book state management for bids and asks (`src/engine/book.js`).
  - Core book operations: insert resting order, cancel resting order, query best bid/ask, compute L2 depth snapshots.
  - Unit test suite for queue manipulation, edge-case pointer unlinking, and level lifecycle.
  - 16 language-neutral JSON golden scenario fixtures in `test/fixtures/` verifying command inputs against expected book states and events.

---

## Phase 2: Matching Engine & Differential Verification [Completed]

- **Objective**: Implement multi-order matching, multi-level sweeps, order lifecycle, and differential property testing.
- **Deliverables**:
  - Matching pipeline (`src/engine/engine.js`) supporting:
    - `LIMIT` orders (immediate match against opposite side + resting remainder).
    - `MARKET` orders (immediate execution up to liquidity, remainder cancelled).
    - `IOC` orders (immediate execution up to limit price, remainder cancelled).
    - `CANCEL` orders (atomic unlinking and volume reduction).
  - Input validation with enumerated reject codes (`INVALID_TICK`, `INVALID_LOT`, `UNKNOWN_INSTRUMENT`, `INVALID_SIDE`, `NON_POSITIVE_QUANTITY`, `UNKNOWN_ORDER`, `NOT_OWNER`, `ALREADY_TERMINAL`, `DUPLICATE_ORDER`).
  - Pure functional interface: engine does not mutate input commands or read the clock / randomness.
  - Independent naive reference oracle (`test/oracle/naive-engine.js`) built strictly from `docs/spec.md` with plain arrays and linear scans for unbiased differential verification.
  - Property-based testing harness using `fast-check` executing randomized command streams against both engines with online invariant checking.
  - Determinism verification ensuring identical seeds generate identical event streams.
  - 38 language-neutral golden scenario JSON fixtures (`test/fixtures/`) covering all lifecycle transitions, sweeps, and reject cases.

---

## Phase 3: Sequencer, Journal, and HTTP/SSE API [Completed]

- **Objective**: Build durable command persistence, group-commit micro-batching, idempotent ingestion, and the public API.
- **Deliverables**:
  - Plain SQL migrations (`migrations/001_initial_schema.sql`) and lightweight atomic migration runner (`src/db/migrator.js`), justified in ADR 0008.
  - Relational schema enforcing database constraints: positive price/quantity checks, foreign keys, deterministic primary key sequencing, and unique `(participant_id, client_order_id)` constraint.
  - Sequencer single-writer pipeline (`src/sequencer/sequencer.js`) with bounded queue (HTTP 503 on full), group-commit micro-batching, and journal-before-ack persistence.
  - Deterministic order ID derivation (`order_id = seq`) without pseudo-randomness or UUIDs.
  - Architectural validation boundary: schema-invalid requests rejected synchronously at API boundary (HTTP 400, never sequenced), valid engine rejections sequenced and journaled to guarantee gap-free replay.
  - In-memory bounded LRU cache with concurrent in-flight request coalescing and database-backed idempotency verification.
  - REST API routes via Express and Zod validation:
    - `POST /orders`, `DELETE /orders/:id`, `GET /orders/:id`
    - `GET /book/:symbol?depth=`, `GET /trades?symbol&from_seq`, `GET /events?from_seq`
    - `GET /health`, `GET /metrics`
    - `POST /admin/replay`, `GET /admin/verify`
  - Server-Sent Events (SSE) streaming endpoint (`/stream`) for real-time book depth snapshots, trade execution notifications, and heartbeats.
  - SHA-256 hashed API key authentication for participants and dedicated admin credential check.
  - Startup journal replay routine rebuilding order book state from PostgreSQL.
  - Database seed script (`scripts/seed.js`) initializing participants and instruments.
  - Integration test suite (`test/integration.test.js`) running against real PostgreSQL in CI verifying durability, group commits, concurrent duplicate retries, non-owner authorization, queue limits, and book state recovery.

---

## Phase 4: Deterministic Replay and Crash Recovery [Completed]

- **Objective**: Implement verifiable state hashing, offline replay verification, invariant audits, and crash recovery.
- **Deliverables**:
  - Deterministic state projector and SHA-256 canonical state hasher (`src/engine/hash.js`).
  - Standalone replay CLI tool (`scripts/replay.js` and `POST /admin/replay`).
  - Independent naive reference oracle replay validation (`--oracle`).
  - Online verification endpoint (`GET /admin/verify`) evaluating the 6 invariants against active state.
  - Startup crash-recovery routine replaying the journal from sequence 0.
  - Hardened 100-round chaos simulation script (`scripts/chaos.js`) simulating unexpected process termination (`SIGKILL`) under concurrent load with dynamic batch sizing (5..200) and timeouts (1..10ms), confirming zero acknowledged order loss, idempotent duplicate retry resolution, and bit-for-bit hash reconciliation against both engine and independent naive oracle.

---

## Phase 5: Performance Benchmarks and UI [Completed]

- **Objective**: Profile engine and API throughput, compare alternative data structures, and provide a live operator interface.
- **Deliverables**:
  - Reproducible seeded workload generator (`bench/workload.js`) modeling a moving midpoint with mean reversion and configurable depth.
  - Hardware and environment telemetry gatherer (`bench/env.js`) capturing CPU model, memory, Node version, OS, git hash, dirty tree flag, and thermal dissipation policies on fanless hardware.
  - In-memory engine microbenchmark (`bench/engine.bench.js`, `npm run bench:engine`) with V8 warm-up, explicit garbage collection, monotonic `process.hrtime.bigint` timing with measured timer overhead, and p50/p95/p99 latency tracking across shallow and deep books.
  - Empirical data-structure comparison implementing a pure JavaScript height-balanced AVL tree (`src/engine/avl.js`) behind the identical `PriceLevelIndex` contract, passing 100% of golden fixtures and differential fuzzing against the naive oracle. Documented in ADR 0009 with a keep-or-replace decision.
  - Fixed-rate API load benchmark (`bench/api.bench.js`, `npm run bench:api`) using `autocannon` to eliminate coordinated omission, sweeping batch configurations (1 vs 20 vs 100) under durable PostgreSQL journaling (`synchronous_commit = on`).
  - Startup recovery scaling benchmark (`bench/recovery.bench.js`, `npm run bench:recovery`) profiling replay latency across 3 journal sizes and tracking heap memory growth from order registry retention.
  - Automated benchmark report generator (`scripts/bench-report.js`, `npm run bench:report`) generating `docs/benchmarks.md` strictly from raw JSON telemetry in `bench/results/`.
  - Operator dashboard in `ui/` (`index.html`, `style.css`, `app.js`) served directly by the Express API, providing an interactive order book depth ladder, live trade tape and event logs over SSE, order entry/cancellation forms, and one-click replay verification. API keys are entered directly in the browser and transmitted via headers without embedding.

---

## Phase 6: Release and Documentation

- **Objective**: Finalize documentation, publish reproducible benchmark results, and tag v1.0.0.
- **Deliverables**:
  - Comprehensive `README.md` with architecture diagrams, schema ER diagrams, setup instructions, and reproducible benchmark commands.
  - Verified benchmark figures linked directly to timestamped results in `bench/results/`.
  - API documentation in `docs/api.md`.
  - Tagging of release `v1.0.0` on `main`.

---

## Known Limitations & Future Architecture

1. **Order Registry Retains Terminal Orders**:
   - The in-memory matching engine retains all orders (`this.orders` Map) across their entire lifecycle, including after reaching terminal states (`FILLED`, `CANCELLED`, `REJECTED`).
   - Memory heap scales monotonically with lifetime order count ($O(N)$ heap growth). Future architecture: periodic snapshotting, state compaction, and cold-storage archiving of terminal orders.
2. **Startup Replay Latency Scales with Journal Length**:
   - Crash recovery and startup initialization replay all commands sequentially from sequence 1 up to the current sequence ($O(N)$ recovery time).
   - Future architecture: periodic state snapshots verified by ADR 0002 canonical state hashes to truncate the replay log and bound startup time to the latest checkpoint interval.
3. **Self-Trade Prevention**:
   - In MVP, crossing orders from the same participant trade against each other. Production roadmap includes configurable Self-Trade Prevention (STP) policies.
