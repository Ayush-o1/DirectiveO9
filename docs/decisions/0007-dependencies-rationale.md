# 7. Dependency Rationales

Date: 2026-10-15

## Status

Accepted

## Context

To avoid dependency bloat, security vulnerabilities, and unvetted code in a financial-technology portfolio project, every dependency must have an explicit technical justification. No extraneous libraries are permitted.

## Dependency Registry

### Runtime Dependencies

1. **`pg` (v8.13.1)**:
   - _Purpose_: Official PostgreSQL client driver for Node.js.
   - _Rationale_: Provides high-performance binary/text protocol communication with PostgreSQL, connection pooling (`pg.Pool`), and parameter binding for raw SQL migrations and command journaling. No ORM abstraction is used, keeping data access explicit and latency predictable.

2. **`express` (v4.21.2)**:
   - _Purpose_: HTTP web server framework.
   - _Rationale_: Minimal, unopinionated routing layer for exposing the REST API (`/orders`, `/book`, `/trades`, `/health`, `/metrics`) and Server-Sent Events (SSE) connections for live market data streaming.

3. **`zod` (v3.24.1)**:
   - _Purpose_: Schema validation.
   - _Rationale_: Enforces strict runtime validation on all inbound command payloads (price ticks, quantity lots, order types, client IDs) at the HTTP boundary before commands enter the sequencer queue.

### Development & Testing Dependencies

1. **`c8` (v10.1.3)**:
   - _Purpose_: Code coverage reporting.
   - _Rationale_: Uses Node.js native V8 coverage counters without requiring source-code instrumentation or Babel transpilation. Generates text and lcov reports.

2. **`fast-check` (v3.23.2)**:
   - _Purpose_: Property-based testing.
   - _Rationale_: Generates randomized, shrinkable command sequences to test the matching engine against the independent naive oracle and assert all 6 system invariants across thousands of state transitions.

3. **`eslint` (v9.18.0)**:
   - _Purpose_: Static analysis and linting.
   - _Rationale_: Identifies unused variables, syntax errors, and enforces strict ES module standards across the repository.

4. **`prettier` (v3.4.2)**:
   - _Purpose_: Code formatting.
   - _Rationale_: Enforces deterministic indentation, quotes, and spacing across JavaScript, JSON, Markdown, and YAML files.

5. **`autocannon` (v8.0.0)**:
   - _Purpose_: HTTP benchmarking tool.
   - _Rationale_: Measures API throughput and latency percentiles under high concurrency to validate the sequencer group-commit pipeline and detect bottlenecks.
