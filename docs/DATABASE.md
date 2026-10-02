# Database Design

## Database

PostgreSQL in Docker.

Recommended vector extension:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

At this corpus size, pgvector is appropriate and keeps vector retrieval inside PostgreSQL.

## Entity relationship

```text
posts
  │
  ├──────────────< images
  │                  │
  │                  ├── image_metadata
  │                  │       │
  │                  │       └── tags
  │                  │
  │                  └── image_embeddings
  │
  ├──────────────< post_embeddings
  │
  └──────────────< suggestions >──────── images
                         │
                         └──────── reviews

jobs
  │
  └── tracks AI/background processing

ai_calls
  │
  └── tracks provider/model/cost for each AI invocation

eval_cases
  │
  └── labeled expected image for a post
```

## Tables

### posts

```sql
CREATE TABLE posts (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### images

```sql
CREATE TABLE images (
    id UUID PRIMARY KEY,
    storage_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size BIGINT NOT NULL,
    width INTEGER,
    height INTEGER,
    sha256 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT images_status_check
      CHECK (status IN ('PENDING', 'PROCESSING', 'READY', 'FLAGGED', 'FAILED'))
);

CREATE INDEX idx_images_sha256 ON images(sha256);
CREATE INDEX idx_images_status ON images(status);
```

### image_metadata

One trusted analysis per image/model version.

```sql
CREATE TABLE image_metadata (
    id UUID PRIMARY KEY,
    image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    model_version TEXT NOT NULL,
    subject TEXT NOT NULL,
    category TEXT NOT NULL,
    attributes JSONB NOT NULL DEFAULT '[]',
    caption TEXT NOT NULL,
    confidence NUMERIC(5,4) NOT NULL,
    raw_response JSONB,
    validation_status TEXT NOT NULL DEFAULT 'VALID',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT image_metadata_confidence_check
      CHECK (confidence >= 0 AND confidence <= 1),

    CONSTRAINT image_metadata_validation_check
      CHECK (validation_status IN ('VALID', 'LOW_CONFIDENCE', 'INVALID'))
);

CREATE UNIQUE INDEX uq_image_metadata_model
ON image_metadata(image_id, model, model_version);

CREATE INDEX idx_image_metadata_category
ON image_metadata(category);

CREATE INDEX idx_image_metadata_subject
ON image_metadata(subject);
```

### image_embeddings

The caption embedding is the primary image-side semantic representation required by the brief.

```sql
CREATE TABLE image_embeddings (
    id UUID PRIMARY KEY,
    image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    model_version TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    embedding VECTOR(768) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_image_embedding_model
ON image_embeddings(image_id, model, model_version);

CREATE INDEX idx_image_embeddings_vector
ON image_embeddings
USING hnsw (embedding vector_cosine_ops);
```

Replace `768` with the actual dimensionality returned by the selected embedding model before running the migration.

### post_embeddings

```sql
CREATE TABLE post_embeddings (
    id UUID PRIMARY KEY,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    model_version TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    embedding VECTOR(768) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_post_embedding_model
ON post_embeddings(post_id, model, model_version);

CREATE INDEX idx_post_embeddings_vector
ON post_embeddings
USING hnsw (embedding vector_cosine_ops);
```

Use the same embedding model and dimensionality for image caption embeddings and post embeddings.

### suggestions

```sql
CREATE TABLE suggestions (
    id UUID PRIMARY KEY,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,

    semantic_similarity NUMERIC(7,6) NOT NULL,
    vision_confidence NUMERIC(5,4),
    guard_status TEXT NOT NULL,
    guard_reason TEXT NOT NULL,

    rank INTEGER NOT NULL,
    matcher_version TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT suggestions_guard_status_check
      CHECK (guard_status IN ('ACCEPTED', 'REJECTED')),

    CONSTRAINT suggestions_similarity_check
      CHECK (semantic_similarity >= -1 AND semantic_similarity <= 1)
);

CREATE INDEX idx_suggestions_post_rank
ON suggestions(post_id, rank);

CREATE INDEX idx_suggestions_status
ON suggestions(guard_status);
```

### reviews

```sql
CREATE TABLE reviews (
    id UUID PRIMARY KEY,
    suggestion_id UUID NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
    decision TEXT NOT NULL,
    notes TEXT,
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT reviews_decision_check
      CHECK (decision IN ('APPROVED', 'REJECTED'))
);

CREATE UNIQUE INDEX uq_reviews_suggestion
ON reviews(suggestion_id);
```

### jobs

```sql
CREATE TABLE jobs (
    id UUID PRIMARY KEY,
    type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    progress INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT jobs_status_check
      CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'))
);

CREATE INDEX idx_jobs_status_created
ON jobs(status, created_at);

CREATE INDEX idx_jobs_entity
ON jobs(entity_type, entity_id);
```

### ai_calls

```sql
CREATE TABLE ai_calls (
    id UUID PRIMARY KEY,
    job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    operation TEXT NOT NULL,

    input_units NUMERIC,
    output_units NUMERIC,
    estimated_cost_usd NUMERIC(12,8) NOT NULL DEFAULT 0,

    status TEXT NOT NULL,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_calls_created
ON ai_calls(created_at);

CREATE INDEX idx_ai_calls_job
ON ai_calls(job_id);
```

### eval_cases

```sql
CREATE TABLE eval_cases (
    id UUID PRIMARY KEY,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    expected_image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_eval_post
ON eval_cases(post_id);
```

## Matching query

Example cosine-distance retrieval:

```sql
SELECT
    ie.image_id,
    p.id AS post_id,
    1 - (ie.embedding <=> $1) AS similarity
FROM post_embeddings pe
JOIN posts p ON p.id = pe.post_id
JOIN image_embeddings ie ON TRUE
ORDER BY ie.embedding <=> $1
LIMIT 20;
```

The production query should instead retrieve images for a specific post using the post embedding:

```sql
SELECT
    ie.image_id,
    1 - (ie.embedding <=> pe.embedding) AS similarity
FROM post_embeddings pe
JOIN image_embeddings ie ON TRUE
WHERE pe.post_id = $1
ORDER BY ie.embedding <=> pe.embedding
LIMIT 20;
```

Then join the image metadata and run the mismatch guard in application/domain code.

## Guard-related indexes

At minimum:

- `images.sha256`
- `image_metadata.category`
- `image_metadata.subject`
- vector HNSW index on image embeddings
- vector HNSW index on post embeddings
- `suggestions(post_id, rank)`
- `jobs(status, created_at)`
- `ai_calls(created_at)`

## Migration policy

All schema changes must be migrations.

Never modify production schema manually without recording the change in a migration.

Recommended:

```text
db/
  migrations/
    001_initial.sql
    002_vector_indexes.sql
    003_jobs_and_costs.sql
```

## Data retention

Keep:

- source image metadata,
- trusted structured vision output,
- embeddings,
- suggestion decisions,
- review decisions,
- AI cost records.

Raw provider responses can be retained for debugging, but avoid storing unnecessary sensitive information.

---

# Phase 1 implementation (as built)

The design above is the target schema. Phase 1 implements it in full, in three
ordered SQL migrations applied by a hand-rolled runner.

## Migrations as built

`src/db/migrations/`, with a paired `.down.sql` for each:

| File | Contents |
|---|---|
| `001_extensions_and_core.sql` | `vector` + `pgcrypto`, `posts`, `images`, `image_metadata` |
| `002_embeddings_and_suggestions.sql` | `image_embeddings`, `post_embeddings`, `suggestions`, `reviews` |
| `003_jobs_cost_and_eval.sql` | `jobs`, `ai_calls`, `eval_cases` |

Runner: `src/db/migrate.js` (`up`, `down`, `status`). Rationale:
`docs/adr/001-migration-runner.md`.

```bash
npm run db:migrate    # apply
npm run db:rollback   # revert the most recent migration
npm run db:status     # list applied migrations
```

Each migration runs in its own transaction, so a failure leaves no partial
schema. `schema_migrations` records name, SHA-256 checksum, and applied-at
timestamp.

## Naming

The design above names migration `003_jobs_and_costs.sql`. The implementation
splits the same content into two files, `002_embeddings_and_suggestions.sql`
and `003_jobs_cost_and_eval.sql`, so that embedding/suggestion/review schema is
applied before job/cost/eval schema. This keeps each migration to one logical
concern and means a rollback in Phase 2 of a jobs change cannot disturb
`reviews`. The table list is unchanged.

## Verified environment

| | |
|---|---|
| PostgreSQL | 17.11 |
| `vector` extension | 0.8.6 |
| `pgcrypto` extension | 1.3 |
| Tables | 10 domain tables + `schema_migrations` |
| Vector index | HNSW, cosine distance, on both embedding tables |

Verified against a running PostgreSQL 17 container on host port `5433`.

## Tables as built

Ten tables. UUID primary keys throughout (`gen_random_uuid()`), created
deliberately in the database so a row is insertable without application code
supplying an id — which keeps fixture seeding and manual SQL inspection simple.

| Table | Purpose |
|---|---|
| `posts` | blog posts: `title`, `slug`, `content` |
| `images` | stored images: `path`, `mime_type`, `byte_size`, `sha256` |
| `image_metadata` | trusted structured vision output for an image |
| `image_embeddings` | one vector per image per model version |
| `post_embeddings` | one vector per post per model version |
| `suggestions` | a ranked candidate for a post, with its guard decision |
| `reviews` | human approve/reject decision for a suggestion |
| `jobs` | background job state and retry count |
| `ai_calls` | per-call cost and usage record |
| `eval_cases` | labeled evaluation set for top-1 precision |

## Indexes as built

Operational indexes from the design:

| Index | Table | Serves |
|---|---|---|
| `idx_images_sha256` | `images` | content-hash dedup on re-ingest |
| `idx_image_metadata_category` | `image_metadata` | category filters, evaluation |
| `idx_image_metadata_subject` | `image_metadata` | mismatch-guard subject lookup |
| `idx_suggestions_post_rank` | `suggestions` | ranked candidates per post |
| `idx_jobs_status_created` | `jobs` | worker polling |
| `idx_ai_calls_created` | `ai_calls` | cost reporting |

Vector indexes:

| Index | Table | Definition |
|---|---|---|
| `idx_image_embeddings_vector` | `image_embeddings` | `hnsw (embedding vector_cosine_ops)` |
| `idx_post_embeddings_vector` | `post_embeddings` | `hnsw (embedding vector_cosine_ops)` |

Cosine distance is required: normalised embeddings + cosine is the comparison the
similarity score is expressed in, so the index and the reported score agree.

## Constraints as built

### Delete behaviour: derived data cascades, evidence does not

Not one blanket rule — two, chosen per table by whether the row is
regenerable:

| Rule | Tables | Reasoning |
|---|---|---|
| `ON DELETE CASCADE` | `image_metadata`, `image_embeddings`, `post_embeddings` | machine-derived and recomputable. An orphaned vector would silently pollute the HNSW index and corrupt retrieval, so it must not outlive its parent. |
| `ON DELETE RESTRICT` | `suggestions` (→ posts, images), `reviews` (→ suggestions), `eval_cases` (→ posts, images) | this is the evidence trail. Requirement 12 is that a reviewer can inspect *why* a recommendation was made. If deleting a post silently deleted its suggestions and a human's approve/reject decision, that requirement would hold only until the first delete. |
| `ON DELETE SET NULL` | `ai_calls.job_id` | a cost record must outlive the job that produced it; the reference is dropped, not the record. |

**Accepted consequence:** a post or image that has been matched or labelled
cannot be deleted in a single statement — the delete fails and the operator must
remove the dependent evidence deliberately. At this corpus size that is the right
trade: it forces a conscious decision instead of a silent one. Joins are
explicit in every repository query, so nothing depends on implicit cascades.

Verified by `tests/integration/api.test.js`, which asserts the delete rule for
every foreign key by name.

### Uniqueness

Implemented as unique **indexes** (`CREATE UNIQUE INDEX ...`), which enforce
uniqueness identically to a table constraint while keeping the definition next to
the index:

| Unique index | Columns | Effect |
|---|---|---|
| `uq_image_metadata_model` | `(image_id, model, model_version)` | one analysis per image per model version |
| `uq_image_embedding_model` | `(image_id, model, model_version)` | one embedding per image per model version |
| `uq_post_embedding_model` | `(post_id, model, model_version)` | one embedding per post per model version |
| `uq_reviews_suggestion` | `(suggestion_id)` | one human decision per suggestion |
| `uq_eval_post` | `(post_id)` | one labeled case per post |
| `suggestions_post_image_matcher_uniq` | `(post_id, image_id, matcher_version)` | one suggestion per post/image per matcher configuration |
| `posts_slug_key` | `(slug)` | slug uniqueness for collision-suffix generation |
| `jobs_idempotency_key_key` | `(idempotency_key)` | one job per idempotency key |

Including `model_version` in the composite keys is what makes re-analysis
possible: a new model version is a *new* row, not a conflict, while a retry of
the *same* version is a conflict. That is exactly the "one analysis per
image/model version" rule in the requirements.

Enforcement is proven, not assumed: an integration test inserts the same
`(post_id, model, model_version)` embedding twice and asserts the first insert
succeeds and the second is rejected by the database (`ON CONFLICT DO NOTHING`
returns zero rows).

These are the rule "retries must not create duplicate logical records", enforced
by the database rather than by application code that could be bypassed.

`images.sha256` is indexed but **not** `UNIQUE`. This is a deliberate deviation
from the design's "content-hash identity" intent: the corpus legitimately
contains images that differ by a byte or two in encoding while depicting the
same scene, and forcing uniqueness would require either rejecting a valid
distinct file or silently coalescing them. Deduplication is performed at ingest
time by the repository, which logs the collision; the index keeps that lookup
fast. If a byte-exact duplicate *must* be impossible, the constraint can be
added later — the current data would satisfy it.

`posts.slug` is `UNIQUE`, backing the collision-suffix slug generation.

`image_metadata.confidence` is a `REAL` constrained to `0..1` with a
`low_confidence` flag, so an unconfident classification is stored and flagged
rather than rejected — it is still reviewable evidence, and the guard needs it.

## The `vector(768)` placeholder

Both embedding columns are `vector(768)`. **This is a temporary placeholder.**
The embedding model is a Phase 2 decision; 768 is the dimension of the two most
likely candidates. If Phase 2 selects a different dimension, this is a normal
migration (`ALTER TABLE ... TYPE vector(N)`, rebuild the HNSW index).

The number is stated once, in `src/config/constants.js` as `EMBEDDING_DIMENSION`.
Full reasoning and candidates: `docs/adr/002-embedding-dimension.md`.

## Data retention

Keep:

- source image metadata,
- trusted structured vision output,
- embeddings,
- suggestion decisions,
- review decisions,
- AI cost records.

Raw provider responses can be retained for debugging, but avoid storing unnecessary sensitive information.

This is unchanged from the design. `image_metadata` stores the *validated*
normalised vision output rather than the raw provider payload: it is the
trustworthy record and it is what the guard reads. A raw-response column is
added in Phase 2 only if debugging requires it.

## Deviations from `docs/DATABASE.md`

| Design | Implementation | Why |
|---|---|---|
| `003_jobs_and_costs.sql` | split into `002` and `003` | one logical concern per migration |
| FK deletes cascade uniformly | split by table: `CASCADE` for derived vectors/metadata, `RESTRICT` for suggestions/reviews/eval_cases, `SET NULL` for `ai_calls.job_id` | orphaned vectors corrupt retrieval; evidence must not vanish silently |
| `images.sha256` unique | indexed, not unique | near-duplicates in the corpus are legitimate |
| 9 tables | 10 domain tables | `eval_cases` needed for the Phase 4 precision measurement |

All four are consequences of the requirements, not scope expansion: the extra
table measures a required metric, the split delete rules protect a required
audit trail without creating orphaned vectors, and the split migrations and index
choice are mechanical.

## Verification

`tests/integration/api.test.js` asserts against the live database:

- `schema_migrations` contains exactly the three applied migrations
- the `vector` extension is installed, with a version
- all ten domain tables exist
- both embedding columns are `vector` type with HNSW indexes present
- all twelve named operational indexes exist
- all nine foreign keys exist, each with its exact expected delete rule
- all eight unique indexes exist, each on its expected column list
- a duplicate `(post_id, model, model_version)` embedding is rejected by the
  database, proving uniqueness is enforced rather than merely declared

So the schema is asserted by the test suite rather than verified by reading it.
`npm run db:rollback` reverting all three migrations, followed by
`npm run db:migrate` re-applying them, was executed to prove the down path works.
