# Project Architecture

## Goal

Build a small, production-shaped backend that performs:

1. image understanding,
2. semantic image-to-post matching,
3. mismatch rejection,
4. human review,
5. measurable evaluation.

## High-level architecture

```text
                         ┌──────────────────────┐
                         │      Client / CLI     │
                         └──────────┬───────────┘
                                    │ HTTP
                                    ▼
                         ┌──────────────────────┐
                         │       Express        │
                         │ Routes / Controllers │
                         └──────────┬───────────┘
                                    │
                ┌───────────────────┼────────────────────┐
                │                   │                    │
                ▼                   ▼                    ▼
          Post/Image API      Matching API         Review API
                │                   │                    │
                └───────────────────┼────────────────────┘
                                    │
                                    ▼
                              Service Layer
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
              ▼                     ▼                     ▼
        Image Service        Matching Service       Review Service
              │                     │
              ▼                     ▼
          Job Queue            Vector Search
              │                     │
              ▼                     ▼
          AI Workers          PostgreSQL
              │                + pgvector
       ┌──────┴──────┐              │
       ▼             ▼              │
 Vision Model   Embedding Model     │
       │             │              │
       └──────┬──────┘              │
              ▼                     │
       Structured Metadata          │
              └─────────────────────┘
```

## Layer responsibilities

### HTTP layer

Responsible for:

- routing,
- authentication if added,
- request parsing,
- boundary validation,
- HTTP status codes,
- response serialization.

It must not contain AI logic or SQL.

### Service layer

Responsible for business workflows:

- ingest image,
- process image,
- generate embeddings,
- match post,
- run mismatch guard,
- create review decision.

### AI layer

Responsible for:

- provider client,
- prompts,
- structured-output schema,
- schema validation,
- embedding generation,
- token/cost extraction.

AI providers must be hidden behind interfaces so the provider can be changed.

### Job layer

Responsible for:

- queueing,
- retries,
- status,
- idempotency,
- progress,
- failures,
- cost recording.

### Repository layer

Responsible for database queries only.

### Domain layer

Contains deterministic logic:

- similarity thresholds,
- guard decisions,
- confidence rules,
- scoring,
- explanation generation.

The mismatch guard should be deterministic and testable without making an AI call.

## Matching pipeline

```text
POST /posts/:id/images
        │
        ▼
store image
        │
        ▼
enqueue vision job
        │
        ▼
vision model
        │
        ▼
Zod validation
        │
   ┌────┴─────┐
 invalid      valid
   │            │
 retry/flag     ▼
             image_metadata
                  │
                  ▼
          embed(caption)
                  │
                  ▼
             image_vector

POST /posts
      │
      ▼
post text
      │
      ▼
embedding job
      │
      ▼
post_vector

GET /posts/:id/images
      │
      ▼
vector similarity search
      │
      ▼
candidate images
      │
      ▼
mismatch guard
      │
 ┌────┴───────────────┐
 ▼                    ▼
accepted          rejected
 │                    │
 ▼                    ▼
suggestion       explanation
```

## Why captions are embedded

The capstone explicitly asks for embeddings of image descriptions and blog post content. The image is first understood by the vision model, producing a caption and structured metadata. The caption is then embedded into the same semantic space as the post text.

This keeps the core matching implementation aligned with the brief.

## Data flow boundaries

```text
HTTP -> validation -> service -> repository
                       |
                       +-> job queue -> AI provider
                       |
                       +-> domain guard
```

Never allow:

```text
route -> Gemini
route -> SQL
controller -> raw vector query
```

## Provider abstraction

Use interfaces similar to:

```text
VisionProvider
  understandImage(image): Promise<VisionResult>

EmbeddingProvider
  embedText(text): Promise<number[]>
```

The application should not care whether the implementation uses Gemini or Ollama.

## Failure strategy

### Vision failure

- retry transient failures,
- record failed attempt,
- do not create trusted metadata,
- mark job failed after retry limit,
- surface failure for inspection.

### Invalid structured output

- parse,
- validate with Zod,
- if invalid, retry where appropriate,
- otherwise flag as invalid,
- never silently coerce into trusted metadata.

### Embedding failure

- retry,
- preserve image/post record,
- mark embedding job failed,
- do not treat the entity as searchable until its embedding exists.

## No-match behavior

The matcher must support:

```text
MATCHED
NO_CONFIDENT_MATCH
```

`NO_CONFIDENT_MATCH` is a successful business outcome when no candidate satisfies the guard.

## Architecture decision records

If an agent changes a major architecture choice, add an ADR under:

```text
docs/adr/
```

Examples:

- `ADR-001-postgresql-pgvector.md`
- `ADR-002-gemini-provider.md`
- `ADR-003-job-queue.md`

---

# Phase 1 implementation (as built)

## Layer status

| Layer | Path | Phase 1 status |
|---|---|---|
| HTTP routing | `src/routes/` | **built** — posts + health only |
| Request/response | `src/controllers/` | **built** — posts only |
| Business logic | `src/services/` | **built** — post creation/slug rules |
| Database access | `src/repositories/` | **built** — posts only |
| Database | `src/db/` | **built** — pool, migrations, full schema |
| Domain | `src/domain/` | **partial** — errors only; mismatch guard in Phase 3 |
| Model clients | `src/ai/` | **not built** — Phase 2 |
| Background jobs | `src/jobs/` | **not built** — Phase 2 |
| Utilities | `src/utils/` | **built** — logger, slug, image inspection |
| Validation | `src/validators/` | **built** (addition to the documented structure) |

The layers that exist are real implementations, not placeholders. The layers that
do not exist yet are absent on purpose: an empty `src/ai/` directory would imply
a design that has not been made, and the embedding model choice (ADR 002)
should not be pre-committed by directory layout.

## Middleware order

Ordering is load-bearing and is fixed in `src/app.js`:

```text
app.disable('x-powered-by')
  → express.json      (1 MB limit)
  → express.urlencoded(extended: false, 1 MB limit)
  → /health routes
  → /api routes
  → notFound          (no route matched → throws NOT_FOUND AppError)
  → errorHandler      (single place that shapes every error response)
```

Two consequences worth stating, because both are easy to get wrong:

- `notFound` runs **before** `errorHandler`, and it *throws* rather than writing
  a response. So an unmatched path produces the standard error envelope instead
  of Express's default HTML 404, and `errorHandler` remains the only code that
  writes an error body.
- Body parsing is registered before the routes, so a malformed payload is turned
  into a 400 by the time it would otherwise reach a handler, not after.

### Deliberately absent from Phase 1

`helmet`, `cors`, and `pino`/`pino-http` are **not** installed and not used. This
is a decision, not an oversight:

- No CORS layer, because there is no browser client. The capstone is an API plus
  a database, and adding CORS headers no caller reads is noise.
- No `pino`/`pino-http`, because a structured logger already exists in
  `src/utils/logger.js` and the integration surface is small. Revisit when the
  request volume justifies a real transport.
- `x-powered-by` is disabled, which is the meaningful part of what `helmet`
  would have done for this surface.
- Rate limiting is likewise absent. It is a Phase 4 concern once the API is
  exposed beyond localhost, and pretending otherwise would add a dependency with
  nothing to protect.

## Runtime dependencies

Five, all justified:

| Package | Why |
|---|---|
| `express` | HTTP framework (required by the brief) |
| `zod` | request/manifest schema validation (required by the brief) |
| `pg` | PostgreSQL client |
| `sharp` | real image inspection for corpus verification (format, dimensions) |
| `dotenv` | `.env` loading |

`multer` was installed early for a planned upload endpoint and removed once no
endpoint used it. An unused dependency is a supply-chain liability for no
benefit, so it was deleted rather than kept "for Phase 2".

Zero dependencies are used for migrations, logging, or HTTP request parsing — the
places where a hand-rolled solution is easiest to audit and easiest to get
wrong at scale are handled by small, readable modules instead.

## How the architecture serves the guard requirement

The requirement that "the mismatch guard is a separate decision module" is an
architectural constraint, and it is met structurally: the guard will live in
`src/domain/` as a pure function over already-fetched structured data. It will
take `(postFacts, imageFacts, similarity, thresholds)` and return a decision
plus a reason. It will not receive a database handle and it will not make an AI
call, which is what makes it unit-testable without mocks — a property Phase 3
depends on.

Correspondingly, `suggestions` is populated by the matching service *after*
retrieval, and no guard rule will be expressed as SQL. Ranking happens in the
service, and persistence happens after the decision.

## Idempotency at the architecture level

Retry-safety is enforced where it cannot be bypassed — in the schema. Per-image
analysis, per-entity embedding, per-suggestion review, and per-post evaluation
all carry a uniqueness constraint keyed by model version. The background worker
in Phase 2 will retry jobs freely; the database will reject a duplicate write.
This is why the unique constraints, rather than application-level checks, are
the load-bearing part of the idempotency requirement. See `docs/DATABASE.md`.

## Deviations from the architecture above

| Documented | Actual | Why |
|---|---|---|
| `domain/` holds core types and decision logic | `domain/` holds errors; guard still to come | the guard is Phase 3; ADR 003 explains the Phase 1 scope |
| no `validators/` directory | `validators/` added | shared Zod schemas need one home |
| top-level `db/`, `scripts/` | both under `src/` and `scripts/` respectively | single import root; scripts stay runnable |
