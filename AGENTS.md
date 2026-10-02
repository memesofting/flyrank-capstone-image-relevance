# AI Agent Instructions — AI Image Understanding & Content Matching Engine

## Purpose

This repository implements the FlyRank Backend Track capstone:

> AI Image Understanding & Content Matching Engine

The system understands an image library, semantically matches images to blog posts, and safely rejects poor matches.

The authoritative project requirements are represented in `docs/PROJECT-REQUIREMENTS.md`. Do not silently expand or change the capstone scope.

## Technology constraints

- Runtime: Node.js
- HTTP framework: Express
- Validation: Zod
- Database: PostgreSQL
- Vector search: pgvector is the preferred implementation for the required vector index at this project scale.
- Vision model: Gemini Flash free tier OR a fully local Ollama vision model.
- Embeddings: Gemini embeddings free tier OR a compatible local Ollama embedding model.
- Background processing: a queue/worker implementation. Keep the implementation lightweight and free.
- Images: licensed-free corpus from Unsplash/Pexels, with a reproducible download/seed script.
- Secrets: `.env` only; never commit real secrets.

## Non-negotiable behavior

1. Vision responses MUST be schema-validated before application code trusts them.
2. Invalid vision output is never silently accepted.
3. Low-confidence classifications are flagged.
4. Vision and embedding work runs in background jobs, not inside ordinary request handlers.
5. Jobs have retries, progress/status tracking, and per-call cost tracking.
6. Image and post embeddings are persisted.
7. Matching is semantic, not filename/keyword matching.
8. The mismatch guard is a separate decision module.
9. The guard combines:
   - structured tags/category/subject checks,
   - semantic similarity thresholds,
   - vision confidence.
10. The system can return `NO_CONFIDENT_MATCH`.
11. Every rejection has a human-readable explanation.
12. Review endpoints allow approve/reject and inspection of why a recommendation was made.
13. An evaluation dataset measures top-1 precision.
14. Thresholds must be selected using evaluation data, not guessed.
15. AI-generated code must remain understandable to the project owner.

## Architecture rules

Use layered architecture:

- `routes/` — HTTP routing only.
- `controllers/` — request/response orchestration.
- `services/` — business logic.
- `ai/` — model clients, prompts, schemas, embedding logic.
- `jobs/` — asynchronous work.
- `repositories/` — database access.
- `db/` — migrations, connection, seed.
- `domain/` — core types and decision logic.
- `utils/` — small infrastructure helpers.

Do not put database queries directly into route files.

Do not put model calls directly into route files.

Do not put mismatch-guard rules inside SQL queries.

## Required data flow

### Image ingestion

`image -> validation -> persisted image -> background vision job -> schema validation -> image metadata -> embedding job -> image vector`

### Post ingestion

`post -> persisted post -> post text embedding job -> post vector`

### Matching

`post -> retrieve image vectors -> rank -> mismatch guard -> suggestion OR no confident match`

### Review

`suggestion -> inspect explanation -> approve/reject -> persist review`

## Idempotency

Retries must not create duplicate logical records.

Use stable identifiers and unique constraints such as:

- image checksum where appropriate,
- one vision analysis per image/model version,
- one embedding per entity/model/version,
- one suggestion per post/image pair/model configuration where appropriate.

## Cost tracking

Every AI call must record:

- provider,
- model,
- operation,
- entity/job ID,
- input token/image metadata where available,
- output token/metadata where available,
- estimated cost,
- timestamp,
- success/failure.

A budget guard must stop or flag work when configured limits are exceeded.

## Scope

The core corpus is intentionally small: 40+ images across 4+ categories and an evaluation set of 10+ posts. Do not build a general-purpose image platform.

No frontend is required.

A validated API and database/review table are sufficient.

## Phase gates

Do not treat a phase as complete until its gate in `phases/` is satisfied.

- Phase 1: one-page design document committed.
- Phase 2: all corpus images tagged by the batch job, with costs visible.
- Phase 3: fox ranks first and wolf is rejected by the guard with an explanation.
- Phase 4: evaluation precision is measured and submission documentation is complete.

## Required repository artifacts

The final repository must contain:

- `README.md`
- `capstone.yaml`
- `EVIDENCE.md`
- `BUILDLOG.md`
- `.env.example`
- `.gitignore`
- public GitHub repository
- license

See `docs/SUBMISSION.md`.

## Working style for agents

Before editing code:

1. Read the relevant phase document.
2. Read `docs/PROJECT-ARCHITECTURE.md`.
3. Read `docs/DATABASE.md` if changing persistence.
4. Read `docs/API.md` if changing endpoints.
5. Preserve existing working behavior.
6. Make small changes.
7. Run the relevant tests/checks.
8. Report what changed and what was verified.

Never claim a requirement is complete without evidence.
