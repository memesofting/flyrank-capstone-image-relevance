# Phase 3 — Matching Engine and Mismatch Guard

## Goal

Build semantic retrieval and the production-critical guard.

Phase gate:

> The fox post ranks the fox first and the guard refuses the wolf.

## Required data

Two embedding streams:

```text
Image caption ──> image_vector
Post text ───────> post_vector
```

Both must use the same semantic embedding space.

## Matching flow

```text
post
 ↓
post embedding
 ↓
vector similarity
 ↓
candidate images
 ↓
rank
 ↓
mismatch guard
 ↓
accepted suggestions OR no confident match
```

## Implementation tasks

### 1. Post embeddings

Generate embeddings for:

```text
title + content
```

Persist them in `post_embeddings`.

### 2. Image embeddings

Generate embeddings for validated image captions.

Persist them in `image_embeddings`.

### 3. Vector search

Use PostgreSQL + pgvector.

Retrieve a candidate set rather than only one result.

Suggested initial retrieval size:

```text
top 10–20
```

### 4. Ranking

Sort candidates by cosine similarity.

Persist rank and similarity for reproducibility.

### 5. Mismatch guard

Create a dedicated module:

```text
src/domain/mismatchGuard.js
```

It must not call an AI model.

It consumes structured facts and returns a deterministic decision.

Inputs:

```text
semanticSimilarity
visionConfidence
postExpectedSubject/category
imageDetectedSubject/category
configuredThresholds
```

Output:

```text
ACCEPTED | REJECTED
```

plus an explanation.

### 6. Subject/category conflict

The guard must detect obvious mismatches.

Example:

```text
Expected: fox
Detected: wolf

=> REJECTED

Reason:
Animal category mismatch: expected fox, detected wolf.
```

### 7. Similarity threshold

If similarity is too low:

```text
REJECTED
Reason:
Similarity below configured threshold.
```

### 8. No-match response

If every candidate is rejected:

```text
NO_CONFIDENT_MATCH
```

Never force a result.

## API

Implement:

```http
GET /api/posts/:id/images
```

The response must include:

- rank,
- image ID,
- similarity,
- guard status,
- explanation.

## Phase 3 acceptance scenarios

### Scenario A — Correct fox

```text
Post: The Behavior of Red Foxes
Candidate: Red fox in forest

Expected:
accepted
rank = 1
```

### Scenario B — Wolf

```text
Post: The Behavior of Red Foxes
Candidate: Gray wolf in forest

Expected:
rejected
reason includes mismatch
```

### Scenario C — Generic dog

Expected:

```text
lower ranking
```

and rejection if it does not clear the guard.

### Scenario D — No suitable image

Expected:

```text
NO_CONFIDENT_MATCH
```

with reasons.

## Tests

Write unit tests for:

- similarity below threshold,
- confidence below threshold,
- subject mismatch,
- accepted candidate,
- no candidates,
- multiple rejected candidates.

## Agent instructions

Do not make the guard probabilistic.

Do not make the guard depend on an LLM call.

Do not use filenames as matching evidence.

Do not choose thresholds based on intuition alone. Phase 4 tunes thresholds against labeled evaluation data.
