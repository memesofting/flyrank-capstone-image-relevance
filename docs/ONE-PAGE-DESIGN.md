# One-Page Design — AI Image Understanding & Content Matching Engine

> Phase 1 gate artifact. This document is the design contract for Phases 2–4.
> Thresholds are named but not chosen; they are tuned against evaluation data
> in Phase 4.

## Problem

Choosing an image for a blog post by filename is not selection, it is a string
comparison that happens to work until it does not. A post titled *"The Behavior
of Red Foxes"* paired with `IMG_4471_red_fox_final.jpg` looks correct; the same
post paired with `download (3).jpg` looks broken. Filenames are set by whoever
saved the file, are frequently absent, and encode no meaning about the pixels.
Keyword matching fails one level deeper too: a post about *"Vulpes vulpes"* or
*"wild fox species"* shares almost no characters with the word "fox" in a
filename, even when the image is exactly right. The system must decide from
what the image **shows**, and must be willing to say it cannot.

## Goal

Given a blog post and a library of images, return the image that is genuinely
semantically relevant — or return `NO_CONFIDENT_MATCH` when no image is. Never
return a confident wrong answer.

## Inputs

- a blog post (`title` + `content`)
- a library of candidate images (40+ across 4+ categories)

## Architecture

Layered, so that a model call, a query, and an HTTP concern can never end up in
the same function:

```text
routes/         HTTP routing only — no SQL, no model calls
controllers/    request/response orchestration
services/       business logic — ingest, embed, match, review
ai/             model clients, prompts, response schemas, embeddings
jobs/           background worker: retries, progress, cost accounting
repositories/   database access only
domain/         core types + the mismatch guard (pure, no DB, no AI)
db/             migrations, pool, seed
validators/     Zod schemas
utils/          small infrastructure helpers
```

The guard is pure by design: it takes already-fetched structured data and returns
a decision, which is what makes it testable without mocks and what stops a guard
rule from being smuggled into a SQL query where it could not be unit-tested or
explained.

Phase 1 builds the layers it can build honestly — `routes` through
`repositories`, `db`, `validators`, `utils`, plus the error taxonomy in
`domain/`. `ai/` and `jobs/` are not created, because an empty directory would
imply a provider design that has not been made.

## API surface

Full contract and error format: `docs/API.md`.

| Method | Path | Purpose | Phase |
|---|---|---|---|
| `GET` | `/health` | liveness, no dependencies | 1 ✅ |
| `GET` | `/health/ready` | readiness, probes PostgreSQL | 1 ✅ |
| `POST` | `/api/images` | ingest an image, enqueue vision job | 2 |
| `GET` | `/api/images` | list images and their analysis state | 2 |
| `GET` | `/api/images/:id` | image, metadata, confidence | 2 |
| `POST` | `/api/posts` | create a post | 1 ✅ |
| `GET` | `/api/posts` | list posts | 1 ✅ |
| `GET` | `/api/posts/:id` | fetch a post | 1 ✅ |
| `POST` | `/api/posts/:id/images` | match: ranked suggestions or `NO_CONFIDENT_MATCH` | 3 |
| `GET` | `/api/suggestions` | list suggestions with explanations | 3 |
| `POST` | `/api/suggestions/:id/review` | approve or reject a suggestion | 3 |
| `GET` | `/api/jobs/:id` | job progress and retry state | 2 |
| `GET` | `/api/costs` | per-call and aggregate AI spend | 2 |
| `GET` | `/api/evaluation` | measured top-1 precision | 4 |

Two conventions hold across all of them: any endpoint that triggers AI work
returns a job id rather than blocking, and every error uses one response shape.

## Processing

```text
image
  → vision understanding        (structured JSON from a vision model)
  → schema validation           (Zod; invalid output is never trusted)
  → image_metadata              (subject, category, attributes, caption, confidence)
  → embedding                   (embed the caption)
  → image vector                 ┐
                                 ├→ semantic retrieval (cosine over pgvector)
post → post text embedding      ─┘
  → ranked candidates
  → mismatch guard
  → ranked recommendation OR NO_CONFIDENT_MATCH
```

Vision and embedding work runs in background jobs, never inside a request
handler. Image caption embeddings and post embeddings share one model and one
dimensionality, or cosine comparison between them is meaningless.

## Mismatch guard

Semantic similarity alone is not sufficient. Nearest-neighbour retrieval will
happily return a gray wolf for a red-fox post — same habitat, same animal
category, same composition — and a cosine score around 0.9. Ranking by
similarity alone therefore produces confident nonsense.

The guard is a **separate, deterministic module**. It makes no AI call, so it
is unit-testable in isolation and cannot be argued into being lenient. It
consumes structured facts and returns `ACCEPTED` or `REJECTED` plus a
human-readable reason.

### Guard rules, written before any AI integration

These rules are specified first, deliberately, so that the model prompts are
built to *feed* them rather than the guard being reverse-engineered from whatever
the model happened to return. **Threshold names are fixed; threshold values are
not.** They are selected in Phase 4 from measured evaluation data.

```text
evaluate(postFacts, imageFacts, similarity, thresholds) -> decision

  # 1. Schema-validity precondition. The guard trusts nothing unvalidated.
  if not imageFacts.schemaValid:
      return REJECTED("vision output failed schema validation")

  # 2. Semantic floor.
  if similarity < thresholds.minSemanticSimilarity:
      return REJECTED(
        f"semantic similarity {similarity} below minimum "
        f"{thresholds.minSemanticSimilarity}")

  # 3. Vision confidence.
  if imageFacts.confidence < thresholds.minVisionConfidence:
      return REJECTED(
        f"vision confidence {imageFacts.confidence} below minimum "
        f"{thresholds.minVisionConfidence}")

  # 4. Subject conflict — the rule that separates fox from wolf.
  if postFacts.expectedSubject is not NONE
        and imageFacts.subject is not NONE
        and imageFacts.subject != postFacts.expectedSubject:
      return REJECTED(
        f"post expects subject '{postFacts.expectedSubject}' but the image "
        f"shows '{imageFacts.subject}'")

  # 5. Contradictory attributes.
  for (attribute, expected) in postFacts.expectedAttributes:
      actual = imageFacts.attributes[attribute]
      if expected is NEGATIVE and actual is PRESENT:
          return REJECTED(
            f"image contains '{attribute}' which the post excludes")
      if expected is PRESENT and actual is NEGATIVE:
          return REJECTED(
            f"image lacks '{attribute}' which the post requires")

  # 6. Low-confidence classifications are flagged, not silently trusted.
  if imageFacts.confidence < thresholds.reviewConfidenceFloor:
      return ACCEPTED_LOW_CONFIDENCE("accepted but flagged for review")

  return ACCEPTED
```

`ACCEPTED_LOW_CONFIDENCE` is a third outcome, not a sub-case of `ACCEPTED`. It
exists so that a reviewer can see which recommendations the model itself was
unsure about — being eligible for recommendation and being *trustworthy* are
different claims.

Every `REJECTED` carries a reason built from the actual values that failed, not
a generic string. A rejection nobody can interpret is a rejection nobody can
act on, and requirement 11 ("every rejection has a human-readable explanation")
is satisfied by construction here rather than by convention.

## Matching strategy

```text
candidate image vectors
  → HNSW cosine index top-k retrieval (k = thresholdConfig.candidateCount)
  → sort by similarity DESC
  → mismatch guard on each candidate, in order
  → first ACCEPTED candidate becomes the top suggestion
  → remaining accepted candidates below it form the ranked list
  → if none accepted: NO_CONFIDENT_MATCH
```

`k` is deliberately larger than the number of suggestions returned. The guard
must be able to reject the top-3 and still have candidates left, otherwise a
system that rejects its own top choice returns nothing instead of its second
choice.

Thresholds are per-configuration and versioned, and each stored suggestion
records the configuration version that produced it. Changing a threshold
therefore never rewrites the reasoning behind a decision that was already
reviewed.

## No-match behaviour

If every candidate fails the guard, the response is

```text
NO_CONFIDENT_MATCH
```

with the per-candidate reasons attached. This is a **successful** business
outcome, not an error: the system correctly declined to guess. Forcing a
recommendation from a rejected set is the specific failure mode this capstone
exists to avoid.

## Human review

Recommendations are persisted with their explanation, and reviewers can list
suggestions, inspect why one was made (similarity, vision confidence, detected
subject/category, guard decision, reason), and approve or reject it. A human
decision outranks the guard and is stored as a first-class record. No UI is
required — a validated API and a review table are enough.

## Evaluation

A labeled evaluation set of 10+ posts, each mapped to its one correct image.
Running the pipeline over it measures **top-1 precision**. The set deliberately
includes hard negatives — fox vs wolf, dog vs wolf, similar backgrounds, generic
animal images, low-confidence classifications — so precision reflects the
guard, not just the happy path. Thresholds are selected to maximise measured
precision on that set, never by intuition.

## Data model (summary)

`posts` · `images` · `image_metadata` · `image_embeddings` · `post_embeddings` ·
`suggestions` · `reviews` · `jobs` · `ai_calls` · `eval_cases`, with UUID keys,
foreign keys, status constraints, content-hash identity on images, and
one-row-per-model-version uniqueness on analyses and embeddings so retries
cannot duplicate logical records.

## Explicit non-goal

**This is not a general-purpose image platform.** There is no upload-and-organise
UI, no multi-tenant asset library, no arbitrary-dimension vector store, no image
editing, and no attempt to scale past the small curated corpus. The single
objective is proving that a system can *refuse* to match an image to a post.
