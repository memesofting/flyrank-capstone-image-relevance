# FlyRank Backend Track — AI Image Understanding & Content Matching Engine

A system that understands an image library with a vision model, matches images
to blog posts by **semantic meaning** rather than filenames, and — the point of
the whole exercise — **refuses to recommend an image it is not confident about**.

> **Status: Phase 1 complete.** The foundation is built and verified: application,
> database schema, migrations, corpus, validation, and error contract.
> Vision, embeddings, matching, and the mismatch guard are Phase 2–4 and are
> **not** built yet. See [Roadmap](#roadmap) and
> [Limitations](#limitations-and-honest-gaps).

---

## The problem this solves

Choosing an image for a blog post by filename is not selection, it is a string
comparison that happens to work until it does not. A post titled *"The Behavior
of Red Foxes"* paired with `IMG_4471_red_fox_final.jpg` looks fine; the same post
paired with `download (3).jpg` looks broken. Filenames are chosen by whoever
saved the file, are often absent, and say nothing about the pixels.

Keyword matching fails one level deeper too. A post about *"Vulpes vulpes"* or
*"wild canid behaviour"* shares almost no characters with a filename, even when
the image is exactly right.

And nearest-neighbour retrieval on its own is not enough either: a gray wolf and
a red fox are the same animal family in the same habitat, so cosine similarity
will happily score a **wolf** image highly for a **fox** post. Ranking by
similarity alone produces confident nonsense.

This project therefore treats rejection as a first-class outcome
(`NO_CONFIDENT_MATCH`), and gates the whole thing on an explicit
[mismatch guard](docs/ONE-PAGE-DESIGN.md).

---

## Architecture

```text
                          ┌───────────────────────────────┐
                          │        src/validators         │
                          │     Zod request schemas       │
                          └───────────────┬───────────────┘
                                          │
  HTTP ──▶ src/routes ──▶ src/controllers ──▶ src/services ──▶ src/repositories ──▶ PostgreSQL
            (routing)     (req/res shape)    (business      (SQL only)            (pgvector
                                             rules)                                 + pgvector)
                          ┌───────────────────────────────┐
                          │   src/middleware              │
                          │  validate · notFound          │
                          │  errorHandler (only writer    │
                          │  of an error response)        │
                          └───────────────────────────────┘

  NOT YET BUILT (Phase 2–4):
    src/ai/     model clients, prompts, response schemas, embeddings
    src/jobs/   background worker with retries + cost tracking
    domain/mismatch-guard  pure decision module (no DB handle, no AI call)
```

The vertical slice that exists is real: `POST /api/posts` traverses route →
controller → service → repository → PostgreSQL → JSON response, and the error
path is exercised for validation failures, malformed JSON, 404s, and unknown
routes.

Design rationale and the deviations from the planned architecture are recorded
in [`docs/PROJECT-ARCHITECTURE.md`](docs/PROJECT-ARCHITECTURE.md). Decisions are
recorded as ADRs in [`docs/adr/`](docs/adr/).

## Project layout

```text
src/            application code (see above)
dataset/        image corpus: manifest, 45 verified images, 16 unverified, scripts
scripts/        corpus fetch + verify (reproducible downloads)
tests/unit/     no database, no network
tests/integration/  real HTTP + real PostgreSQL
docs/           design, architecture, API, database, dataset, ADRs
```

## Requirements

- Node.js **>= 20.11** (developed and verified on v24.18.0)
- Docker + Docker Compose (only for PostgreSQL/pgvector)

## Setup

Every command below is also available as a `make` target — see
[`Makefile`](#makefile) at the end. Use whichever you prefer; the npm scripts
are the source of truth.

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp .env.example .env      # defaults work as-is for local development

# 3. Start PostgreSQL with pgvector
docker compose up -d      # host port 5433 → container 5432

# 4. Create the schema
npm run db:migrate
```

## Run

```bash
npm start          # production-style start, http://localhost:3000
npm run dev        # same, with nodemon reload on src/ changes
```

## Test

```bash
npm test                  # 77 unit tests, no database required
npm run test:integration  # 27 integration tests, needs PostgreSQL
npm run test:all          # 104 tests
```

Integration tests create and remove their own data, and `TRUNCATE posts CASCADE`
at setup and teardown, so run them against a development database only.

Or run everything CI runs, in one command:

```bash
make check      # db status + all 104 tests + corpus verification
```

## Rebuild the corpus from the manifest

```bash
npm run corpus:fetch     # download anything missing; verify everything present
npm run corpus:verify    # hashes, dimensions, licence, provenance, 40+/4+ targets
```

Idempotent: on a complete corpus it fetches nothing and re-verifies all 61
entries.

## Evaluation

```bash
npm run eval             # Phase 4 — not built yet
```

Top-1 precision is measured in Phase 4 against a labeled set of 10+ posts. **No
precision number is reported in Phase 1, because none has been measured.** Any
number here would be fabricated. Thresholds are selected from that measurement,
not guessed in advance.

---

## API endpoints

Implemented in Phase 1 — see [`docs/API.md`](docs/API.md) for the full contract.

| Method | Path | Success | Purpose |
|---|---|---|---|
| `GET` | `/health` | 200 | liveness; deliberately independent of the database |
| `GET` | `/health/ready` | 200 | readiness; probes PostgreSQL with a bounded timeout |
| `POST` | `/api/posts` | 201 | create a post (`title`, `content`) |
| `GET` | `/api/posts` | 200 | list posts (`limit`, `offset`, `total`) |
| `GET` | `/api/posts/:id` | 200 | fetch one post by UUID |

Planned for Phase 2–4: `POST /api/images`, `GET /api/posts/:id/images`,
`GET /api/suggestions`, review endpoints, and job status.

### Error contract

Every error, without exception:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body: title",
    "details": [ { "path": "title", "message": "Required" } ]
  }
}
```

| Code | HTTP |
|---|---|
| `VALIDATION_ERROR` | 400 |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 |
| `SERVICE_UNAVAILABLE` | 503 |
| `INTERNAL_ERROR` | 500 |

Guarantees: a validation failure never becomes a 500; stack traces and internal
error text never reach the client; `details` is always an array so clients parse
one shape; unknown request fields are rejected rather than silently dropped.

### Try it

```bash
curl localhost:3000/health
curl localhost:3000/health/ready
curl -X POST localhost:3000/api/posts \
  -H 'content-type: application/json' \
  -d '{"title":"The Behavior of Red Foxes","content":"Red foxes are small omnivorous canids."}'
```

---

## Dataset

| | |
|---|---|
| Verified, categorised images | **45** (target 40+) |
| Populated categories | **6** (target 4+) |
| Source | Unsplash, Unsplash License |
| Total size | 11.1 MiB |
| Duplicate content hashes | 0 |
| Unverified (held aside) | 16 |

Categories are assigned from the **Unsplash photo-page description**, never from
filenames — recorded per entry as `categorySource`. Unsplash+ images were excluded
because their licence terms differ from the free Unsplash License.

The 16 pre-existing files that could not be traced to a source, licence, or
subject are preserved under `dataset/unverified/` with `category:
"unverified"` and are **excluded from the corpus count**. They were not guessed
at, because inventing ground truth would corrupt the Phase 4 precision
measurement. See [`docs/DATASET.md`](docs/DATASET.md).

## Database

PostgreSQL 17 + pgvector. Ten domain tables, applied by three ordered migrations
with paired rollbacks:

| Table | Purpose |
|---|---|
| `posts` | blog posts |
| `images` | stored images with content hash |
| `image_metadata` | validated structured vision output |
| `image_embeddings` / `post_embeddings` | `vector(768)` + HNSW cosine indexes |
| `suggestions` | ranked candidates with guard decision and reason |
| `reviews` | human approve/reject, one per suggestion |
| `jobs` | background job state and retries |
| `ai_calls` | per-call provider, model, tokens, cost, outcome |
| `eval_cases` | labeled evaluation set for top-1 precision |

Idempotency is enforced **in the schema**, not only in application code:
uniqueness constraints on one analysis per image per model version, one embedding
per entity per model version, one review per suggestion, and one eval case per
post. A retrying worker cannot create duplicate logical records.

`vector(768)` is a **temporary placeholder** pending the Phase 2 model choice —
see [ADR 002](docs/adr/002-embedding-dimension.md).

Full detail, including four deliberate deviations from the planned schema:
[`docs/DATABASE.md`](docs/DATABASE.md).

## Security

- `.env` is gitignored and never committed. `.env.example` contains no secrets.
- The environment is validated at startup with Zod and **fails closed**: a missing
  or non-PostgreSQL `DATABASE_URL` exits before the server listens.
- Connection strings are never echoed in error output — verified by test.
- The structured logger redacts `token`, `api_key`, `password`, and
  `authorization` keys, including nested ones.
- SQL is parameterised everywhere; no string interpolation of user input.
- Body size is capped at 1 MB.

## Roadmap

| Phase | Gate | Status |
|---|---|---|
| 1 | One-page design document | **complete** |
| 2 | All corpus images tagged by a batch job, costs visible | not started |
| 3 | Fox ranks first; wolf rejected by the guard with an explanation | not started |
| 4 | Top-1 precision measured; submission pack complete | not started |

## Limitations and honest gaps

Stated plainly, because a capstone that overstates itself is not useful:

1. **No AI capability exists yet.** There is no vision call, no embedding, no
   semantic matching, and no mismatch guard. `src/ai/` and `src/jobs/` are not
   written. Calling this "semantic matching" today would be false.
2. **No top-1 precision number.** It has not been measured. Phase 4 does that.
3. **No `NO_CONFIDENT_MATCH` yet.** That is the headline behaviour and it comes
   with the guard in Phase 3.
4. **Only `posts` has an API.** Images, suggestions, reviews, and jobs have tables
   but no endpoints.
5. **16 of 61 corpus images have unknown provenance** and are excluded from the
   corpus count.
6. **`vector(768)` is a placeholder** that will need a migration if Phase 2 picks a
   different model.
7. **No frontend**, by design — the brief requires a validated API and a review
   table only.
8. **Integration tests truncate `posts`.** Development database only.

## Evidence

Every Phase 1 requirement, with the command that verifies it and its real output,
is in [`EVIDENCE.md`](EVIDENCE.md). The development history, including what the
AI got wrong and how it was corrected, is in [`BUILDLOG.md`](BUILDLOG.md).

## Makefile

A thin convenience wrapper over the npm scripts and `docker compose`. It adds no
behaviour that is not reachable with a plain `npm run ...`; `make` and `npm` are
both first-class here.

```bash
make            # list every target
make setup      # install, configure, start PostgreSQL, migrate
make run        # start the API
make check      # full verification: migrations, all tests, corpus integrity
make smoke      # exercise every endpoint against a running server
make eval       # Phase 4 precision measurement — fails honestly, not implemented
```

`make distclean` deletes the database volume and is guarded by a typed
confirmation, because it destroys data.

## Licence

Code: [MIT](LICENSE). Images: Unsplash License, attributed per entry in
[`dataset/manifest.json`](dataset/manifest.json). Images are **not** relicensed
by this repository.