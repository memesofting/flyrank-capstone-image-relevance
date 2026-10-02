# Folder Structure

Target structure:

```text
flyrank-capstone-image-relevance/
│
├── src/
│   ├── app.js
│   ├── server.js
│   │
│   ├── config/
│   │   ├── env.js
│   │   └── constants.js
│   │
│   ├── routes/
│   │   ├── posts.routes.js
│   │   ├── images.routes.js
│   │   ├── suggestions.routes.js
│   │   ├── reviews.routes.js
│   │   └── jobs.routes.js
│   │
│   ├── controllers/
│   │   ├── posts.controller.js
│   │   ├── images.controller.js
│   │   ├── suggestions.controller.js
│   │   ├── reviews.controller.js
│   │   └── jobs.controller.js
│   │
│   ├── services/
│   │   ├── post.service.js
│   │   ├── image.service.js
│   │   ├── matching.service.js
│   │   ├── review.service.js
│   │   └── evaluation.service.js
│   │
│   ├── domain/
│   │   ├── mismatchGuard.js
│   │   ├── scoring.js
│   │   └── matchStatus.js
│   │
│   ├── ai/
│   │   ├── vision/
│   │   │   ├── visionProvider.js
│   │   │   ├── geminiVisionProvider.js
│   │   │   ├── ollamaVisionProvider.js
│   │   │   ├── prompts.js
│   │   │   └── schemas.js
│   │   │
│   │   └── embeddings/
│   │       ├── embeddingProvider.js
│   │       ├── geminiEmbeddingProvider.js
│   │       └── ollamaEmbeddingProvider.js
│   │
│   ├── jobs/
│   │   ├── queue.js
│   │   ├── imageUnderstanding.job.js
│   │   ├── imageEmbedding.job.js
│   │   ├── postEmbedding.job.js
│   │   └── worker.js
│   │
│   ├── repositories/
│   │   ├── posts.repository.js
│   │   ├── images.repository.js
│   │   ├── embeddings.repository.js
│   │   ├── suggestions.repository.js
│   │   ├── reviews.repository.js
│   │   ├── jobs.repository.js
│   │   └── aiCalls.repository.js
│   │
│   ├── db/
│   │   ├── pool.js
│   │   └── migrations/
│   │
│   ├── storage/
│   │   ├── imageStorage.js
│   │   └── localStorage.js
│   │
│   ├── middleware/
│   │   ├── errorHandler.js
│   │   ├── validate.js
│   │   └── upload.js
│   │
│   └── utils/
│       ├── hashing.js
│       ├── image.js
│       └── logger.js
│
├── scripts/
│   ├── seed.js
│   ├── process-corpus.js
│   └── evaluate.js
│
├── dataset/
│   ├── manifest.json
│   ├── images/
│   └── eval/
│
├── docs/
│   ├── PROJECT-REQUIREMENTS.md
│   ├── PROJECT-ARCHITECTURE.md
│   ├── DATABASE.md
│   ├── API.md
│   ├── AI-PIPELINE.md
│   ├── FOLDER-STRUCTURE.md
│   ├── SUBMISSION.md
│   └── adr/
│
├── phases/
│   ├── PHASE-1-DESIGN.md
│   ├── PHASE-2-VISION-PIPELINE.md
│   ├── PHASE-3-MATCHING-AND-GUARD.md
│   └── PHASE-4-PRODUCTION-EVAL.md
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── evaluation/
│
├── .env.example
├── .gitignore
├── AGENTS.md
├── README.md
├── BUILDLOG.md
├── EVIDENCE.md
├── capstone.yaml
├── docker-compose.yml
├── package.json
└── LICENSE
```

## Rules

### Routes

Only map HTTP methods to controllers.

### Controllers

Translate HTTP input/output.

### Services

Coordinate workflows.

### Domain

Contains deterministic decisions that can be unit tested.

### AI

Contains model-provider code.

### Jobs

Contains background processing.

### Repositories

Contains SQL/database access.

### Scripts

Used for:

- corpus seeding,
- batch processing,
- evaluation.

Scripts may call services but must not duplicate business logic.

### Tests

Unit tests must cover:

- schema validation,
- mismatch guard,
- scoring,
- threshold behavior.

Integration tests should cover:

- database persistence,
- API validation,
- job state transitions.

Evaluation tests should run against the labeled dataset.

---

# Phase 1 implementation (as built)

```
.
├── dataset/                    image corpus, moved from the old images/
│   ├── images/{fox,wolf,dog,bear,deer,other}/
│   ├── unverified/            16 files held aside, no provenance
│   ├── manifest.json          corpus source of truth
│   └── manifest.schema.json   published JSON Schema
├── scripts/
│   ├── fetch-corpus.js        manifest-driven, idempotent download
│   └── verify-corpus.js       hashes, dimensions, licence, target checks
├── src/
│   ├── config/                env validation (Zod), constants
│   ├── db/
│   │   ├── pool.js            lazy pg Pool, withTransaction
│   │   ├── migrate.js         up / down / status runner
│   │   └── migrations/        NNN_name.sql + NNN_name.down.sql
│   ├── domain/                errors, error codes, HTTP mapping
│   ├── utils/                 slug, logger, image inspection, hashing
│   ├── validators/            Zod schemas (ADDITION — see below)
│   ├── middleware/            validate, notFound, errorHandler
│   ├── repositories/          SQL only
│   ├── services/              business logic
│   ├── controllers/           request/response
│   ├── routes/                routing only
│   ├── app.js                 middleware ordering
│   └── server.js              listen, graceful shutdown
└── tests/
    ├── unit/                  no I/O beyond the filesystem
    └── integration/           real HTTP + real PostgreSQL
```

## Deviations from the structure above

1. **`src/validators/` was added.** The structure above does not name a home for
   shared Zod schemas. Scattering them across `controllers/` and `services/`
   would make them hard to find and harder to reuse, so validation schemas live
   in one directory. `src/domain/` holds error types; `src/validators/` holds
   request/manifest schemas.
2. **Everything sits under `src/`,** so the project has one import root
   (`node src/server.js`) instead of both `./src` and `./db`, `./scripts`.
3. **`images/` was replaced by `dataset/`.** It now holds the manifest, the
   verified images, the unverified hold-out, and the corpus scripts together, so
   the corpus is reproducible from one directory. See `docs/DATASET.md`.
4. **`tests/` splits unit from integration.** Integration tests need a running
   PostgreSQL; keeping them separate means `npm test` never needs Docker.

## Rules that were enforced in Phase 1

- No SQL in `src/routes/`. Repositories own every query.
- No model calls in `src/routes/`. No model calls exist yet; when they do they
  go in `src/ai/` (not yet created).
- The mismatch guard does not exist yet and will go in `src/domain/`. No guard
  rule will ever live inside a SQL query.
- `src/db/pool.js` builds the pool lazily, so importing a module in a unit test
  does not open a database connection.

## Verification

Layering is checked by inspection and by the integration test running the full
HTTP → controller → service → repository → Postgres path.

`tests/unit/` imports `src/config`, `src/domain`, `src/utils`, `src/validators`,
`src/middleware`, and `src/services`, but **no repository is ever imported and no
query is ever executed**. `src/db/pool.js` builds its `pg.Pool` lazily, so
importing a service does not open a connection.

This is verified rather than asserted — the unit suite passes against an
unreachable database:

```bash
DATABASE_URL='postgresql://u:p@127.0.0.1:59999/nope' npm test
# ℹ tests 77
# ℹ pass 77
# ℹ fail 0
```

So a unit test failing on database state is a genuine regression in layering, not
an environment problem. Note the caveat: the unit tests read
`dataset/manifest.json` and a corpus image by relative path, so they must be run
from the repository root.
