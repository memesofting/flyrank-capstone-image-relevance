# Phase 2 — Image Understanding Pipeline

## Goal

Build the background vision pipeline that classifies every corpus image with schema-validated structured metadata.

Phase gate:

> All images are tagged by the batch job and costs are visible.

## Required flow

```text
image
 ↓
job
 ↓
vision provider
 ↓
structured JSON
 ↓
Zod validation
 ↓
image_metadata
 ↓
embedding job
 ↓
image embedding
```

## Vision output

Required fields:

```json
{
  "subject": "red fox",
  "category": "animal",
  "attributes": ["orange fur", "wild", "forest"],
  "caption": "A red fox standing in a forest",
  "confidence": 0.94
}
```

## Implementation tasks

### 1. Build provider abstraction

Implement:

```text
VisionProvider
```

and one provider:

```text
GeminiVisionProvider
```

or:

```text
OllamaVisionProvider
```

### 2. Build Zod schema

The schema must reject:

- missing subject,
- missing category,
- empty caption,
- confidence outside 0–1,
- wrong field types.

### 3. Implement AI call tracking

Every call writes to `ai_calls`.

Record:

- provider,
- model,
- operation,
- usage,
- estimated cost,
- status,
- error.

### 4. Implement background job

Job requirements:

- asynchronous,
- retry transient failures,
- update progress,
- idempotent,
- record final failure.

### 5. Implement batch processor

Command:

```bash
npm run process:corpus
```

It should:

1. discover corpus manifest,
2. enqueue/process images,
3. show progress,
4. retry failures,
5. summarize cost.

### 6. Low-confidence handling

Do not pretend low confidence is correct.

Use:

```text
VALID
LOW_CONFIDENCE
INVALID
```

Low-confidence images remain visible for review but should not be treated as fully trusted by the mismatch guard.

## Suggested logging

```text
[vision] image=123 status=success confidence=0.94
[vision] image=124 status=low-confidence confidence=0.41
[vision] image=125 status=retry attempt=2
```

## Phase 2 gate

Run the batch processor and prove:

- [ ] every corpus image has an analysis record or explicit failed/flagged state
- [ ] valid outputs pass Zod
- [ ] at least one low-confidence case is visible
- [ ] retries work
- [ ] progress/status is visible
- [ ] every AI call has a cost record
- [ ] no secret is logged
- [ ] invalid output is never trusted

Record proof in `EVIDENCE.md`.

## Agent instructions

Do not implement matching in this phase beyond whatever minimal embedding infrastructure is required by the pipeline.

Do not silently convert invalid JSON into a valid object.

Do not hard-code model output into the database.

Do not log API keys.
