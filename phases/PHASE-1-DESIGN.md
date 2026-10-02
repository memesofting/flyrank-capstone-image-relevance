# Phase 1 — Design

## Goal

Produce the one-page design document, database design, matching strategy, guard rules, and initial corpus.

The phase gate is:

> The one-page design document is committed to the repository.

## Tasks

### 1. Create the project repository

Repository name:

```text
flyrank-capstone-image-relevance
```

It must be public and dedicated to this capstone.

### 2. Initialize Node.js + Express

Use:

- Node.js
- Express
- PostgreSQL
- Zod

### 3. Configure environment

Create:

```text
.env
.env.example
```

`.env` must be gitignored.

At minimum plan variables for:

```text
PORT
DATABASE_URL
AI_PROVIDER
GEMINI_API_KEY
AI_DAILY_BUDGET_USD
AI_MONTHLY_BUDGET_USD
```

Only put provider-specific variables in the environment when needed.

### 4. Create database migrations

Implement the schema described in `docs/DATABASE.md`.

### 5. Gather corpus

Minimum:

- 40 images,
- 4+ categories,
- licensed-free sources,
- reproducible manifest/download process.

Prefer categories that make mismatch obvious.

Recommended:

```text
red fox
wolf
dog
bear
deer
```

### 6. Define design document

The Phase 1 design document must contain:

- problem statement,
- architecture,
- data model,
- API surface,
- matching strategy,
- mismatch guard,
- one explicit non-goal.

### 7. Define guard before AI integration

Write deterministic guard rules first.

Example:

```text
if similarity < semantic_threshold:
    reject

if vision_confidence < minimum_confidence:
    reject

if expected_subject conflicts with detected_subject:
    reject
```

Do not choose final threshold values yet.

Thresholds are tuned in Phase 4 using evaluation data.

## Phase 1 gate

Before moving to Phase 2, verify:

- [ ] public dedicated repo exists
- [ ] architecture document exists
- [ ] database schema/migrations exist
- [ ] API surface is documented
- [ ] mismatch guard design exists
- [ ] corpus has 40+ images
- [ ] 4+ categories exist
- [ ] dataset provenance/license is recorded
- [ ] one explicit non-goal is written
- [ ] design document committed

## Agent instructions

Do not implement the full AI pipeline in this phase.

Do not optimize vector search yet.

Do not add a frontend.

Do not add stretch goals.

The output of this phase is a stable design contract for later phases.
