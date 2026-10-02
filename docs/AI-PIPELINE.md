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
