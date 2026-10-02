# Evidence — Phase 1

Every requirement below is stated, then verified by a named command whose output
is quoted verbatim. No conclusion is claimed without a command that produced it.

- **Environment:** Node v24.18.0 · PostgreSQL 17.11 · `vector` 0.8.6
- **Date:** 2026-10-02
- **Suite:** 104 tests, 104 passing, 0 failing

## Phase 1 gate checklist

From `phases/PHASE-1-DESIGN.md`:

| Gate item | Status | Evidence section |
|---|---|---|
| Public dedicated repo exists | ⚠️ not verifiable locally | §14 |
| Architecture document exists | ✅ PASS | §1 |
| Database schema/migrations exist | ✅ PASS | §2 |
| API surface documented | ✅ PASS | §3 |
| Mismatch guard design exists | ✅ PASS | §4 |
| Corpus has 40+ images | ✅ PASS (45) | §6 |
| 4+ categories exist | ✅ PASS (6) | §6 |
| Dataset provenance/licence recorded | ✅ PASS | §7 |
| One explicit non-goal written | ✅ PASS | §5 |
| Design document committed | ✅ committed | §14 |
| Makefile wrapper | ✅ PASS | §15 |

One item cannot be verified locally: repository **visibility** is a property of
GitHub, not of the working tree, so `gh repo view` must confirm it after pushing.
See §14.

---

## 1. Architecture document exists

Command: `test -f docs/PROJECT-ARCHITECTURE.md`

Output:

```text
PASS
```

`docs/PROJECT-ARCHITECTURE.md` documents the layering, the middleware order, the
runtime dependencies with justification for each, and an explicit table of
deviations from the planned architecture. The layering is real, not decorative:
the integration tests traverse route → controller → service → repository →
PostgreSQL, and the unit tests pass against an **unreachable** database:

```bash
DATABASE_URL='postgresql://u:p@127.0.0.1:59999/nope' npm test
```

```text
ℹ tests 77
ℹ pass 77
ℹ fail 0
```

No repository is imported by a unit test, and no query executes, because
`src/db/pool.js` constructs its pool lazily. A unit test failing on database
state is therefore a real layering regression.

**Conclusion: PASS**

## 2. Database schema and migrations exist

Command: `npm run db:status`

Output:

```text
Status       Migration
-----------  --------------------------------------------
applied      001_extensions_and_core.sql
applied      002_embeddings_and_suggestions.sql
applied      003_jobs_cost_and_eval.sql

3 applied, 0 pending.
```

### Down migrations actually work

Command: `npm run db:rollback -- 3`

Output:

```text
  rolled back 003_jobs_cost_and_eval.sql
  rolled back 002_embeddings_and_suggestions.sql
  rolled back 001_extensions_and_core.sql
```

Then `npm run db:status` reported `0 applied, 3 pending`, and
`npm run db:migrate` re-applied all three. Both directions execute.

### The schema is asserted, not eyeballed

Test: `npm run test:integration` → suite `database is migrated`

Output:

```text
✔ database is migrated (98.954694ms)
```

That suite asserts, against the live database: exactly three rows in
`schema_migrations`; the `vector` extension installed with a version; all ten
domain tables present; both `embedding` columns present as `vector` with both
HNSW indexes; twelve named operational indexes; **all nine** foreign keys by
name, each with its exact expected delete rule; **all eight** unique indexes by
name and column list; and that a duplicate `(post_id, model, model_version)`
embedding is rejected by the database.

Delete rules as built and asserted:

```text
CASCADE   image_metadata_image_id_fkey      derived — regenerable
CASCADE   image_embeddings_image_id_fkey    derived — an orphan would
CASCADE   post_embeddings_post_id_fkey      pollute the HNSW index
RESTRICT  suggestions_post_id_fkey          evidence — a recommendation
RESTRICT  suggestions_image_id_fkey         and the human decision
RESTRICT  reviews_suggestion_id_fkey        behind it must not vanish
RESTRICT  eval_cases_post_id_fkey           silently
RESTRICT  eval_cases_expected_image_id_fkey
SET NULL  ai_calls_job_id_fkey              a cost record outlives its job
```

Idempotency is proven by behaviour rather than by declaration: an integration
test inserts the same embedding twice and asserts the first succeeds and the
second is rejected.

```text
✔ database is migrated (691ms)
ℹ tests 27
ℹ pass 27
ℹ fail 0
```

Live environment:

```text
NAME                     IMAGE                    STATUS                PORTS
image_matcher_postgres   pgvector/pgvector:pg17   Up 28 minutes (healthy)   0.0.0.0:5433->5432/tcp
```

**Conclusion: PASS**

## 3. API surface is documented and implemented

Document: `docs/API.md`, including request bodies, response shapes, query
parameters, the full error table, conventions for future endpoints, and a
deviations section.

Implemented, verified live against a running server:

```text
### GET /health
{"status":"ok","service":"flyrank-image-matcher","version":"1.0.0","uptimeSeconds":2,...}
HTTP 200

### GET /health/ready
{"status":"ok","database":"ok"}
HTTP 200

### POST /api/posts (valid)
{"id":"8eb89daf-372f-490b-ac58-c76852966a3a","title":"The Behavior of Red Foxes",
 "slug":"the-behavior-of-red-foxes","content":"Red foxes are small omnivorous canids.",
 "createdAt":"2026-10-02T10:34:05.059Z","updatedAt":"2026-10-02T10:34:05.059Z","status":"CREATED"}
HTTP 201

### GET /api/posts?limit=2&offset=0
{"total":2,"limit":2,"offset":0,"posts":[{...},{...}]}
HTTP 200
```

Slug collision handling is verified: posting the same title twice yields
`the-behavior-of-red-foxes` then `the-behavior-of-red-foxes-0c43bc24`, backed by
a `UNIQUE` constraint on `posts.slug`.

**Conclusion: PASS**

## 4. Mismatch guard design exists

Evidence: `docs/ONE-PAGE-DESIGN.md`, section *Mismatch guard*.

The guard is specified as a pure function with six numbered rules, written
deliberately **before** any AI integration so the vision prompt can be built to
feed the guard rather than the guard being reverse-engineered from model output:

```text
evaluate(postFacts, imageFacts, similarity, thresholds) -> decision
  1. schema-validity precondition
  2. semantic floor
  3. vision confidence
  4. subject conflict          <- fox vs wolf
  5. contradictory attributes
  6. low-confidence flag
```

It defines three outcomes (`ACCEPTED`, `ACCEPTED_LOW_CONFIDENCE`, `REJECTED`) and
requires every rejection to carry a reason built from the values that actually
failed.

**Threshold values are deliberately not chosen.** Names are fixed; numbers are
deferred to Phase 4 measurement, per the phase instruction.

**Conclusion: PASS (design). Not implemented — Phase 3.**

## 5. One explicit non-goal is written

Evidence: `docs/ONE-PAGE-DESIGN.md`, section *Explicit non-goal*.

> This is not a general-purpose image platform. There is no upload-and-organise
> UI, no multi-tenant asset library, no arbitrary-dimension vector store, no image
> editing, and no attempt to scale past the small curated corpus. The single
> objective is proving that a system can *refuse* to match an image to a post.

**Conclusion: PASS**

## 6. Corpus has 40+ images and 4+ categories

Command: `npm run corpus:verify`

Output:

```text
Per category
-----------
  fox            6
  wolf           7
  dog            8
  bear           6
  deer           7
  other          11
  unverified    16  (excluded from the corpus)

Categorised images: 45 (target 40+)
Populated categories: 6 (target 4+)
Manifest entries:     61 (16 unverified, held aside)
Total size:           11.1 MiB
Licences:             Unsplash License, unknown

PASS
----
Manifest, files, hashes, dimensions, provenance, and licences all agree.
```

45 ≥ 40 and 6 ≥ 4, both checked by the script rather than asserted by hand, and
both re-asserted by `tests/unit/manifest.test.js` so the corpus cannot silently
regress below target.

`fox` and `wolf` are populated as separate categories because the Phase 3 gate
requires demonstrating that a wolf image is rejected for a fox post.

**Conclusion: PASS**

## 7. Dataset provenance and licence are recorded

Command: `npm run corpus:verify` (provenance + licence checks)

Output: `PASS` — see §6.

Every categorised entry records `sourcePage`, `sourceUrl` (the exact URL
downloaded), `photographer`, `license`, `licenseUrl`, `provenance`, and
`fetchedBy`. Unsplash+ images were excluded because their terms differ from the
free Unsplash License.

The 16 pre-existing files with no traceable provenance are held in
`dataset/unverified/`, marked `category: "unverified"`, excluded from the count,
and given a `note` explaining why. A test asserts they claim no licence and no
category.

**Conclusion: PASS, with 16 files honestly quarantined rather than guessed at.**

## 8. Corpus is reproducible and idempotent

Command: `npm run corpus:fetch` on an already-complete corpus

Output:

```text
Fetched: 0  Skipped: 61  Failed: 0
```

Files are matched by SHA-256, so a complete corpus re-fetches nothing. The
manifest is the source of truth; `dataset/manifest.schema.json` is the published
schema; `src/validators/manifest.validator.js` enforces it at runtime.

**Conclusion: PASS**

## 9. Validation: schema validation rejects bad input

Command: `npm test` → suite `post schema rejects what the API must not accept`

Output:

```text
✔ post schema rejects what the API must not accept (2.012802ms)
```

Live against the running server:

```text
### POST /api/posts (missing title)
{"error":{"code":"VALIDATION_ERROR","message":"Invalid request body: title",
 "details":[{"path":"title","message":"Invalid input: expected string, received undefined"}]}}
HTTP 400

### POST /api/posts (unknown field)
{"error":{"code":"VALIDATION_ERROR","message":"Invalid request body",
 "details":[{"path":"","message":"Unrecognized key: \"unexpected\""}]}}
HTTP 400

### POST /api/posts (malformed JSON)
{"error":{"code":"VALIDATION_ERROR","message":"Request body is not valid JSON","details":[]}}
HTTP 400

### GET /api/posts?limit=1000
{"error":{"code":"VALIDATION_ERROR","message":"Invalid query parameters: limit",
 "details":[{"path":"limit","message":"Too big: expected number to be <=100"}]}}
HTTP 400
```

A malformed payload is a 400, never a 500 — this is the requirement most often
got wrong and it is asserted in both unit and integration tests. Unknown fields
are rejected rather than silently dropped.

**Conclusion: PASS**

## 10. Error contract is uniform

Command: `npm test` → suite `error handler` and `not found handler`

Output:

```text
✔ error handler (20.757419ms)
✔ not found handler (2.745602ms)
```

Live:

```text
### GET /api/posts/00000000-0000-4000-8000-000000000000
{"error":{"code":"NOT_FOUND","message":"Post 00000000-0000-4000-8000-000000000000 was not found","details":[]}}
HTTP 404

### GET /api/does-not-exist
{"error":{"code":"NOT_FOUND","message":"Cannot GET /api/does-not-exist","details":[]}}
HTTP 404
```

One shape, always: `{ error: { code, message, details } }`. `details` is always
an array. No stack trace is ever present — asserted both directly and by
scanning the serialised body for stack markers.

`notFoundHandler` throws an `AppError` rather than calling `res.json()` itself,
so `errorHandler` remains the only writer of an error body and an unmatched route
cannot drift into a different shape.

**Conclusion: PASS**

## 11. Secrets are not committed and not leaked

Command: `git check-ignore -v .env`

Output:

```text
.gitignore:.env
```

Command: `grep -c "hunter2" <error output>` with a password-bearing
`DATABASE_URL`

Output:

```text
0
```

Startup fails closed. Run from a directory with no `.env`:

```text
### DATABASE_URL unset
Invalid environment configuration.

  - DATABASE_URL: Invalid input: expected string, received undefined

Copy .env.example to .env and fill in the required values.

### wrong scheme (mysql://)
Invalid environment configuration.

  - DATABASE_URL: DATABASE_URL must be a postgresql:// connection string
```

Logger redaction, including nested keys:

```text
{"level":"info","message":"probe","context":{"token":"[redacted]","api_key":"[redacted]",
 "password":"[redacted]","nested":{"authorization":"[redacted]"}}}
```

`.env.example` contains placeholders only. `.env` is gitignored.

**Conclusion: PASS**

## 12. Idempotency is enforced in the schema

Evidence: `src/db/migrations/002_embeddings_and_suggestions.sql`,
`003_jobs_cost_and_eval.sql`, asserted by the integration suite (§2).

Implemented as unique indexes (which enforce identically to table constraints):

| Unique index | Columns | Enforces |
|---|---|---|
| `uq_image_metadata_model` | `(image_id, model, model_version)` | one analysis per image per model version |
| `uq_image_embedding_model` | `(image_id, model, model_version)` | one embedding per image per model version |
| `uq_post_embedding_model` | `(post_id, model, model_version)` | one embedding per post per model version |
| `uq_reviews_suggestion` | `(suggestion_id)` | one human decision per suggestion |
| `uq_eval_post` | `(post_id)` | one labeled evaluation case per post |
| `suggestions_post_image_matcher_uniq` | `(post_id, image_id, matcher_version)` | one suggestion per post/image per matcher config |
| `posts_slug_key` | `(slug)` | slug uniqueness |
| `jobs_idempotency_key_key` | `(idempotency_key)` | one job per idempotency key |

Including `model_version` in each composite key is what lets a model upgrade
create a *new* row while a retry of the *same* version collides — precisely the
"one analysis per image/model version" rule.

Enforced by the database rather than by application checks that a worker could
bypass, and **proven by behaviour**: the integration test inserts the same
`(post_id, model, model_version)` twice and asserts the second insert is
rejected. `images.sha256` is indexed for fast dedup lookup but intentionally not
`UNIQUE` — see `docs/DATABASE.md` for why.

**Conclusion: PASS (schema). Retry behaviour itself is Phase 2.**

## 13. Layering rules hold

Command: `grep -rn "SELECT\|INSERT\|UPDATE" src/routes/ src/controllers/`

Output:

```text
(no matches)
```

No SQL in `src/routes/` or `src/controllers/`. No model calls exist yet;
`src/ai/` is not created. There are no guard rules in SQL because the guard does
not exist yet — when it does it goes in `src/domain/` as a pure function.

`src/db/pool.js` builds its pool lazily, so importing a module in a unit test
does not open a database connection.

**Conclusion: PASS**

## 14. Phase 1 gate status

The gate is:

> The one-page design document is committed to the repository.

`docs/ONE-PAGE-DESIGN.md` is committed, along with every other Phase 1 artifact,
as six logical commits (scaffold → schema → app → corpus → tests → docs). The
structure and the reason for each boundary are recorded in `BUILDLOG.md` §15.

All submission files required by `docs/SUBMISSION.md` are present and verified:

| File | Status |
|---|---|
| `README.md` | present |
| `capstone.yaml` | present, parses as valid YAML |
| `EVIDENCE.md` | this file |
| `BUILDLOG.md` | present |
| `.env.example` | present, placeholders only |
| `.gitignore` | present, `.env` confirmed ignored |
| `LICENSE` | present, MIT |

### Not verifiable locally

`docs/SUBMISSION.md` requires a **public** dedicated repository. That is a GitHub
property, not a working-tree property, so it cannot be evidenced here. Confirm
after pushing:

```bash
git push
gh repo view --json name,visibility,url   # expect visibility == PUBLIC
```

**Conclusion: PASS on everything checkable locally. The public-repository
requirement remains unconfirmed until `gh repo view` reports `PUBLIC`.**

There is also **no `Dockerfile`** — the application runs with `npm start` against
a `docker compose` PostgreSQL, which is what `capstone.yaml` documents. No
containerised application build is claimed.

## 15. Makefile wrapper

Command: `make check`

Output:

```text
applied      001_extensions_and_core.sql
applied      002_embeddings_and_suggestions.sql
applied      003_jobs_cost_and_eval.sql
3 applied, 0 pending.
ℹ tests 104
ℹ pass 104
ℹ fail 0
Categorised images: 45 (target 40+)
Populated categories: 6 (target 4+)
PASS
Phase 1 verification complete.
```

`make` exposes the npm scripts and `docker compose` as targets without
reimplementing them, so there is no behaviour reachable only through `make`.
`make smoke` was additionally verified against a live server and all four
endpoints responded. `make eval` deliberately **exits non-zero**, reporting that
no precision measurement exists, rather than printing a placeholder figure.

---

## Not yet evidenced (later phases)

Stated so the absence is visible rather than implied:

| Requirement | Phase | Status |
|---|---|---|
| Vision responses schema-validated | 2 | not implemented |
| Invalid vision output never silently accepted | 2 | not implemented |
| Low-confidence classifications flagged | 2 | not implemented |
| AI work runs in background jobs, not request handlers | 2 | not implemented |
| Job retries, progress, per-call cost tracking | 2 | not implemented |
| Image and post embeddings persisted | 2–3 | schema only |
| Matching is semantic, not filename/keyword | 3 | not implemented |
| Guard is a separate decision module | 3 | designed only |
| Guard combines tags/category/subject + similarity + confidence | 3 | designed only |
| System can return `NO_CONFIDENT_MATCH` | 3 | designed only |
| Every rejection has a human-readable explanation | 3 | designed only |
| Review endpoints approve/reject and explain | 3 | not implemented |
| Evaluation dataset measures top-1 precision | 4 | not implemented |
| Thresholds selected from evaluation data | 4 | not implemented |
| Budget guard halts work at configured limits | 2 | not implemented |

None of these are claimed as met.

## Summary

| Section | Requirement | Result |
|---|---|---|
| 1 | Architecture document | PASS |
| 2 | Schema + migrations | PASS |
| 3 | API documented + implemented | PASS |
| 4 | Guard design | PASS (design) |
| 5 | Explicit non-goal | PASS |
| 6 | 40+ images, 4+ categories | PASS (45 / 6) |
| 7 | Provenance + licence | PASS |
| 8 | Reproducible corpus | PASS |
| 9 | Validation rejects bad input | PASS |
| 10 | Uniform error contract | PASS |
| 11 | No committed or leaked secrets | PASS |
| 12 | Schema-level idempotency | PASS |
| 13 | Layering rules | PASS |
| 14 | Design doc committed; public repo | PASS (commit) / unconfirmed (visibility) |
| 15 | Makefile wrapper | PASS |

**14 of 15 verified requirements pass outright; §14 passes on everything
checkable locally.**

The one remaining action is not a code change:

```bash
git push
gh repo view --json name,visibility,url   # expect PUBLIC
```

Until that reports `PUBLIC`, the repository-visibility half of the Phase 1 gate
and of `docs/SUBMISSION.md` is unconfirmed. It is not claimed as met.