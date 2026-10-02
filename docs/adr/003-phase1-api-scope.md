# ADR 003 — Phase 1 API scope: health plus posts CRUD

- Status: accepted
- Date: 2026-10-02
- Phase: 1

## Context

Phase 1 requires a Node.js + Express application with PostgreSQL, Zod
validation, docker-compose, `.env.example`, and documented endpoints. The later
phases add image ingestion, vision analysis, embeddings, matching, the mismatch
guard, reviews, and evaluation.

There is a real risk in building all of that scaffolding at once: the Phase 1
deliverable stops being independently verifiable. Phase 1's job is to prove the
foundation works and is understood.

## Decision

Phase 1 implements exactly two resource groups:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness — process is up; does not touch the database |
| `GET` | `/health/ready` | readiness — actually queries the database |
| `POST` | `/api/posts` | create a post (`title`, `content`) |
| `GET` | `/api/posts` | list posts, with `limit`/`offset` and a total |
| `GET` | `/api/posts/:id` | fetch one post by UUID |

Deliberately **not** built in Phase 1: images, suggestions, reviews, jobs,
costs, evaluation endpoints, and every `ai/` and `jobs/` module.

## Consequences

**Good**

- Every layer is exercised by a real vertical slice rather than existing as a
  stub: route → controller → service → repository → Postgres → response, plus
  the error path for validation failures, 404s, and malformed JSON.
- The post record is not throwaway. Posts are the input to post-text embedding
  in Phase 2, so `posts` and `post_embeddings` are already in place and the
  vector column already has an HNSW index.
- `/health` versus `/health/ready` is a distinction many projects get wrong:
  liveness must not report unhealthy when a dependency is down, or the container
  gets killed during a database restart.
- Each later phase adds routes to a working router instead of establishing one.

**Bad**

- No image-related endpoint exists yet, so the API does not yet cover the
  headline data flow. This is intentional and is stated plainly rather than
  disguised with placeholder routes.

## Layering

The layered structure is in place and load-bearing, not decorative:

```text
src/routes/        HTTP routing only
src/controllers/   request/response orchestration
src/services/      business logic
src/repositories/  database access
src/validators/    Zod schemas
src/middleware/    validation, 404, error handling
```

No SQL appears in `src/routes/`. No model calls exist yet, and when they do they
will live in `src/ai/` with the request handlers unchanged.

`src/validators/` is an addition to `docs/FOLDER-STRUCTURE.md`, which did not
name a home for shared Zod schemas. A separate directory was preferred over
dispersing them across `controllers/` and `services/`.

## Verification

- `tests/unit/` covers environment validation, slug derivation, image inspection,
  the error contract, and the manifest schema.
- `tests/integration/api.test.js` runs the real HTTP stack against real
  PostgreSQL and asserts the full endpoint contract plus the resulting schema.

Total: 98 tests, 98 passing. See `EVIDENCE.md`.