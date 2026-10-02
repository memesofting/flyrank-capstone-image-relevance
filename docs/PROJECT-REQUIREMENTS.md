# Project Requirements

## Source

This document is derived from the FlyRank Backend Track Capstone Brief: **AI Image Understanding & Content Matching Engine**.

The capstone requires a system that understands an image library, organizes images automatically, and matches the correct image to the correct article based on meaning rather than filenames or keywords.

## Core behavior

Example:

- A red-fox article should surface a red-fox image.
- A wolf image should be rejected.
- A generic dog image should rank poorly.
- If no image is good enough, the system must say so rather than guess.

The mismatch guard is the central production reliability feature.

## Required capabilities

### 1. Image ingestion and classification

Every image is processed by a vision model.

Expected structured output:

```json
{
  "subject": "red fox",
  "category": "animal",
  "attributes": ["orange fur", "wild", "forest"],
  "caption": "A red fox standing in a forest",
  "confidence": 0.94
}
```

The response must be validated with Zod.

Invalid responses are never trusted.

Low-confidence results are flagged.

### 2. Semantic image matching

Create embeddings for:

- image descriptions/captions,
- blog post content.

Store embeddings in a vector index.

Rank images for each post.

The system must understand equivalent concepts such as:

- `red fox`
- `Vulpes vulpes`
- `wild fox species`

rather than requiring exact words.

### 3. Mismatch guard

The guard combines:

- extracted tags/category/subject,
- semantic similarity threshold,
- vision confidence.

Example:

Post: `The behavior of red foxes`

Candidate: `A gray wolf in the forest`

Result:

`REJECTED`

Reason:

`Animal category mismatch: expected fox, detected wolf`

The guard must be able to reject the best available candidate when it is still wrong.

### 4. Background processing

Vision and embedding generation must run asynchronously as background/batch jobs.

Jobs require:

- retries,
- status/progress,
- failure handling,
- per-call cost tracking.

Slow AI work must not block normal HTTP requests.

### 5. Review API

Provide endpoints to:

- list suggestions,
- inspect a suggestion and its explanation,
- approve a suggestion,
- reject a suggestion.

A full UI is not required.

## Required quality behaviors

- Invalid AI output is rejected.
- Low-confidence classifications are flagged.
- No suitable image produces `no confident match`.
- Rejections include explanations.
- Semantic matching works for equivalent concepts.
- Top-1 precision is measured on a labeled evaluation set.

## Scope

- 40+ images.
- 4+ categories.
- Recommended example categories: red fox, wolf, dog, bear, deer.
- 10+ evaluation posts.
- One vision model.
- One embedding model.
- No frontend required.
- Keep the project free to run.

## Acceptance probes

1. Run the batch job: every image gets schema-valid tags; at least one low-confidence image is flagged.
2. Query red-fox article: fox ranks first; wolf and dog rank lower.
3. Force wolf as candidate for fox article: guard rejects it with category-mismatch explanation.
4. Query a post with no suitable image: returns `no confident match` with reasons.
5. Run evaluation: top-1 precision is reported and matches README.
6. Cost log contains an entry for every vision/embedding call.

## Shared backend requirements

- Layered architecture: data / logic / HTTP separated.
- Boundary validation: bad input returns clean 4xx.
- At least one background job with retries and failure handling.
- Real persistence using migrations and appropriate indexes.
- Idempotency for retryable operations.
- Secrets only through environment configuration.
- AI cost tracked per call with a budget guard.
