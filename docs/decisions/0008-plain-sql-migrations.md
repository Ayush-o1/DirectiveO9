# 8. Plain SQL Migrations Without a Migration Library

Date: 2026-10-15

## Status

Accepted

## Context

Financial exchange and ledger applications require rigorous, deterministic schema evolution. Many Node.js projects adopt third-party migration frameworks (such as `knex`, `typeorm`, `prisma`, or `db-migrate`) or query builder DSLs to manage database schema updates.

In DirectiveO9, the database serves as the authoritative, durable command journal and relational source of truth for idempotency, event auditing, and participant balances. Schema definitions involve specific PostgreSQL features, including strict `CHECK` constraints (e.g., `price > 0`, `quantity > 0`), partial unique indexes, explicit foreign key cascades, and optimal data types (`BIGINT`, `JSONB`, `TIMESTAMPTZ`).

## Decision

We will use plain SQL migration scripts managed by a lightweight, custom migration runner (`src/db/migrator.js`) written directly on top of the native `pg` client driver, with zero external migration dependencies.

### Design Principles

1. **Explicit DDL Without Abstraction Leakage**:
   Migration files are standard SQL (`001_initial_schema.sql`, `002_...sql`). Engineers write raw SQL DDL directly, retaining complete control over table structures, index types (B-tree, partial unique), and integrity constraints. No ORM translation layer or abstraction obscures the exact schema executed by PostgreSQL.

2. **Minimal, Atomic Migration Runner**:
   The runner creates a dedicated tracking table:

   ```sql
   CREATE TABLE IF NOT EXISTS _migrations (
     id SERIAL PRIMARY KEY,
     name VARCHAR(255) NOT NULL UNIQUE,
     applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   ```

   For each unapplied migration script:
   - A dedicated database transaction (`BEGIN ... COMMIT`) is opened.
   - The entire SQL script is executed.
   - A row is inserted into `_migrations`.
   - The transaction commits. If any error occurs, the transaction rolls back cleanly, halting startup and preventing partial schema states.

3. **Deterministic Constraint Enforcement**:
   All relational and domain invariants are enforced directly at the SQL level:
   - Positive quantity and price: `CHECK (price > 0)`, `CHECK (quantity > 0)`
   - Idempotency uniqueness: `UNIQUE (participant_id, client_order_id)`
   - Primary key monotonicity: `seq BIGINT PRIMARY KEY`
   - Relational integrity: Foreign keys linking `commands(seq)`, `events(seq)`, `trades(seq)`, and `participants(participant_id)`.

4. **Zero Dependency Overhead**:
   Avoids introducing heavyweight migration packages, reducing bundle size, build surface, and transitive supply chain vulnerability risks.

## Consequences

- **Positive**:
  - Zero third-party dependencies required for migrations beyond the existing `pg` driver.
  - Complete transparency of database schema and index definitions in native PostgreSQL syntax.
  - Migration execution is deterministic, transactional, and runs seamlessly during startup and in automated CI pipelines.
  - Seamless reproducibility for local development and CI testing environments.

- **Negative / Trade-offs**:
  - Down-migrations (rollbacks) are not automatically reverse-engineered; schema changes in production follow append-only forward migrations. This aligns with immutable financial ledger practices where destructive rollbacks are disallowed.
