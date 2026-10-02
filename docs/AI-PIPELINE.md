# AI Pipeline

## Providers

The implementation must support one of:

### Cloud

- Gemini Flash for vision.
- Gemini embeddings for semantic embeddings.

### Local

- Ollama vision model.
- Ollama embedding model.

Keep provider code behind interfaces.

## Vision schema

Canonical Zod schema:

```javascript
import { z } from "zod";

export const imageUnderstandingSchema = z.object({
  subject: z.string().min(1),
  category: z.string().min(1),
  attributes: z.array(z.string()).min(1),
  caption: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
```

Do not trust a provider response until:

```javascript
const parsed = imageUnderstandingSchema.safeParse(modelOutput);
```

If invalid:

- record the failure,
- retry if appropriate,
- otherwise flag it,
- never treat malformed output as valid metadata.

## Vision prompt requirements

The prompt should instruct the model to:

- identify the primary subject,
- classify a broad category,
- list meaningful visual attributes,
- write a factual caption,
- provide a 0–1 confidence estimate,
- return only the required JSON structure.

Avoid prompts that encourage speculation.

## Image processing

Pipeline:

```text
raw image
  ↓
validate MIME/signature
  ↓
read dimensions
  ↓
normalize for model
  ↓
vision model
  ↓
parse JSON
  ↓
Zod validation
  ↓
persist metadata
```

## Confidence policy

The model confidence is not automatically the same thing as final match confidence.

Use two concepts:

- `vision_confidence`: model's own classification confidence.
- `semantic_similarity`: vector similarity.
- `guard_decision`: deterministic application decision.

Low vision confidence must cause a flag or rejection according to configured policy.

## Embeddings

Create:

1. image caption embedding,
2. blog post text embedding.

They must use the same embedding space/model.

Do not compare unrelated embedding models.

## Embedding normalization

If the provider requires normalization for cosine retrieval, normalize consistently before persistence.

Document the chosen behavior in an ADR.

## Semantic retrieval

For a post:

```text
post text
  ↓
post embedding
  ↓
nearest image caption embeddings
  ↓
candidate images
```

The retrieval layer should return more than one candidate, such as top 10–20, before guard evaluation.

## Mismatch guard

The guard is deterministic.

Suggested decision sequence:

```text
candidate
   │
   ├── semantic similarity below threshold?
   │       └── reject
   │
   ├── image confidence below minimum?
   │       └── reject/flag
   │
   ├── expected subject/category conflicts?
   │       └── reject
   │
   └── otherwise
           accept
```

The exact thresholds must be tuned using the evaluation set.

Do not invent a threshold simply because it sounds reasonable.

## Guard output

```typescript
type GuardResult = {
  status: "ACCEPTED" | "REJECTED";
  reason: string;
  semanticSimilarity: number;
  visionConfidence: number | null;
};
```

Examples:

```text
ACCEPTED
"Semantic similarity 0.91 exceeds threshold and the detected subject matches the post."

REJECTED
"Animal mismatch: post expects fox, detected subject is wolf."

REJECTED
"Similarity below threshold: 0.42."

REJECTED
"Image understanding confidence is too low to trust this classification."
```

## No-match rule

If all candidates fail the guard:

```json
{
  "status": "NO_CONFIDENT_MATCH",
  "reason": "All candidate images were rejected by the mismatch guard."
}
```

Include candidate-level reasons for debugging/review.

## Cost tracking

Wrap every AI call:

```text
start call
  ↓
provider request
  ↓
extract usage
  ↓
calculate estimated cost
  ↓
persist ai_calls row
  ↓
return provider result
```

The cost tracker must work even when the provider's cost is zero/free-tier.

Store `0` when appropriate rather than omitting the record.

## Budget guard

Configuration should include:

```text
AI_DAILY_BUDGET_USD
AI_MONTHLY_BUDGET_USD
MAX_IMAGE_BATCH_SIZE
```

Before starting a large batch:

1. calculate current tracked cost,
2. compare with configured budget,
3. refuse/stop new work if the budget is exceeded.

## Provider abstraction

Recommended interfaces:

```typescript
interface VisionProvider {
  understandImage(input: Buffer): Promise<unknown>;
}

interface EmbeddingProvider {
  embedText(text: string): Promise<number[]>;
}
```

Provider adapters convert external responses into internal representations.

The rest of the application must not depend on Gemini-specific response shapes.

---

## Model availability and resuming a paused corpus

The free tier allows roughly **20 `generateContent` calls per model per day**, so
a 61-image corpus cannot be analysed on one model in one day. Full measurements
and reasoning are in `docs/adr/004-vision-model-availability.md`.

Two different limits produce near-identical error bodies:

| Window | Meaning | What the runner does |
|---|---|---|
| under 2 minutes | per-minute rate limit | sleeps, then continues in the same run |
| 2 minutes or more | daily quota | parks the job with `reclaimable_at`, exits cleanly |

Neither consumes a retry attempt. A rate limit is not a failure, and a job that
burned its budget on one would be `FAILED` for no useful reason.

### Finishing a paused corpus

Nothing special is required — the corpus is resumable. Jobs that were parked
become claimable once their window passes, and ingestion skips images that
already hold a valid analysis, so a second run finishes only what is left:

```bash
npm run process:corpus                      # resume, using configured models
npm run process:corpus -- --limit=10       # just the next 10
npm run process:corpus -- --no-ingest      # drain queued jobs, no corpus scan
npm run costs                               # per-model spend and call counts
```

### Model selection

The default is run-level consistency: if a run has already written analysis rows
it will not switch models, because a corpus whose captions came from several
models cannot be compared.

When the daily cap makes completion in one day more important than consistency,
`--model-pool` does it explicitly:

```bash
npm run process:corpus -- --model-pool=gemini-3.1-flash-lite,gemini-3.7-flash
```

Every `image_metadata` row records the model that produced it, so a pooled corpus
stays attributable. Phase 4 must then state that its precision figure is pooled.

Two models in the provider list do not work on a new free-tier account and should
not be added to a pool: `gemini-2.5-flash-lite` is closed to new users, and
`gemini-flash-lite-latest` returns HTTP 400 on `generateContent`.

### Cost reporting

```bash
npm run costs              # today, and the last 30 days
```

Totals come from `ai_calls`, which records provider, model, operation, token
counts, estimated cost, status, and error for every attempt. A rejected call is
still recorded — that is usually where the cost story is.

> **Careful when running tests.** The integration suite shares this database. Its
> cleanup is scoped to its own stub-provider fixtures; an earlier version ran
> unscoped `DELETE FROM ai_calls` and silently deleted the real cost audit trail.
