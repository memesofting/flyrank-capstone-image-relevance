# ADR 001 — Hand-rolled SQL migration runner

- Status: accepted
- Date: 2026-10-02
- Phase: 1

## Context

The schema is the backbone of this project: ten tables, pgvector columns,
HNSW indexes, foreign keys, and the uniqueness constraints that make retries
idempotent. Phases 2–4 add columns and tables, so migrations must be ordered,
re-runnable, and reversible enough to test that a down path actually works.

A migration library (`node-pg-migrate`, `knex`, `umzug`) would work, but each
one is a dependency to understand, configure, and audit, and none of them were
already present in this repository.

## Decision

Hand-roll a minimal runner in `src/db/migrate.js`:

- ordered `NNN_name.sql` files in `src/db/migrations/`
- paired `NNN_name.down.sql` files, excluded from the up-scrape
- each migration runs inside its own transaction, so a failure leaves no partial
  schema
- `schema_migrations` records name, checksum, and timestamp; a changed file
  whose checksum no longer matches is reported as a conflict rather than
  silently skipped
- `up`, `down`, and `status` subcommands

Scripts: `npm run db:migrate`, `npm run db:rollback`, `npm run db:status`.

## Consequences

**Good**

- Zero new runtime dependencies for schema management.
- The whole mechanism is ~200 readable lines — the project owner can audit it in
  one sitting, which matters given the requirement that generated code stay
  understandable.
- Down migrations are a first-class citizen because the Phase 1 gate requires
  demonstrating that rollback works.

**Bad**

- No parallel/branching migration support. Not needed at this scale.
- No automatic generation of down files. They are written by hand.
- Checksum drift means fixing a migration in place requires a manual
  `schema_migrations` update. Documented rather than automated.

## Alternatives considered

- **`node-pg-migrate`** — mature and capable. Rejected to avoid a dependency
  for three subcommands we need.
- **Run SQL by hand** — no record of what was applied, no ordering guarantee, no
  rollback story. Rejected.
- **`schema.sql` executed wholesale** — not incremental, so it cannot support the
  phase-by-phase column additions the project requires.

## Verification

`npm run db:status` lists the three applied migrations; rolling back all three
and re-applying them was executed during Phase 1 and both directions succeeded.
`tests/integration/api.test.js` asserts that `schema_migrations` contains exactly
the expected migrations and that the resulting schema (tables, indexes,
foreign keys, extensions) is correct — so the schema is verified by the test
suite, not only by eye.