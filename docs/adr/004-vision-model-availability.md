# ADR 004: Vision model availability and the per-model daily cap

- Status: accepted
- Date: 2026-10-02
- Relates to: `docs/adr/002-embedding-dimension.md`, `docs/AI-PIPELINE.md`

## Context

Phase 1 fixed a single vision model, `gemini-3.8-flash`. Phase 2 needed to run
that model across all 61 corpus images. The first live runs showed the assumption
was wrong in a way that mattered.

Measured against this project's free-tier API key on 2026-10-02:

| Model | Quota reported | Meaning |
|---|---|---|
| `gemini-3.8-flash` | `limit: 20`, retry after ~3h | daily cap |
| `gemini-3.5-flash` | `limit: 20`, retry after ~2h49m | daily cap |
| `gemini-3.6-flash` | `limit: 5`, retry after ~31s | per-minute cap, *and* a daily cap hit at ~15 calls |
| `gemini-3.1-flash-lite` | worked | — |

Three separate limits exist, and the per-minute one and the daily one look
identical in the error body apart from the retry window. The practical ceiling
is roughly **20 successful `generateContent` calls per model per day**.

61 images cannot be analysed on one model in one day. This is an external
constraint on a free tier, not something the pipeline can configure away.

Two further models named in the provider list turned out to be unusable and were
excluded rather than retried forever:

- `gemini-2.5-flash-lite` — "no longer available to new users".
- `gemini-flash-lite-latest` — HTTP 400 on `generateContent`.

## Decision

1. **Rate limits are classified, not guessed.** `classifyQuota()` parses the
   provider's own retry window and adds a 10% margin, because retrying exactly
   on the boundary earns another rejection that extends the limit.

2. **Short waits are ridden out; long waits are parked.** A window under two
   minutes means a per-minute limit: the runner sleeps and continues in the same
   run. A longer window means a daily limit: the job is parked with
   `reclaimable_at` set and the run exits cleanly. Parking a 31-second limit
   would have made a 61-image corpus need four separate manual runs.

3. **A quota wall never consumes an attempt.** Rejections are not failures; a job
   must not burn its retry budget on a limit that will reset on its own.

4. **Run-level model consistency is the default.** If a run has already written
   analysis rows it will not switch models. Mixing models mid-corpus would leave
   captions that cannot be compared, and the corpus is too small to hide that.

5. **`--model-pool` is the explicit escape hatch.** Finishing the corpus in one
   day requires spanning models, so this is supported, opt-in, and every
   `image_metadata` row records the model that produced it. The corpus is then
   attributable, at the cost of a multi-model precision measurement in Phase 4.

6. **Re-analysis is opt-in.** Ingestion skips images that already hold a
   `VALID` or `LOW_CONFIDENCE` analysis. Without this, switching model re-queues
   all 61 images, because the vision idempotency key contains the model.

## Consequences

- Phase 2 corpus evidence is **57 of 61 images**, spanning four models
  (`gemini-3.1-flash-lite` 33, `gemini-3.6-flash` 15, `gemini-3.7-flash` 7,
  `gemini-3.1-flash-lite-preview` 2). The remaining 4 are `dog` images parked
  against exhausted daily caps; they resume with `npm run process:corpus` once
  any model's window resets.
- The Phase 2 gate is **not yet met**. It requires all 61 images analysed.
- Phase 4 must either group its precision figure by model or state that it
  measures a mixed-model corpus. This is recorded rather than hidden.
- A production deployment would not face this: it would use a paid tier, or one
  model and a few days, or Ollama.

## Alternatives considered

- **Ollama vision model.** Permitted by the project constraints and immune to
  quota, but not provisioned in this environment; the corpus evidence would have
  to be re-derived to switch.
- **Retry aggressively on quota.** Rejected: it converts one clear, actionable
  signal into many failed calls, burns the attempt budget, and is exactly what
  the `deferJob` path exists to avoid.
- **Silently mixing models.** Rejected: it is faster and produces a complete
  corpus, but it destroys run-level consistency invisibly. `--model-pool` gives
  the same speed with the trade-off stated in the command line and in every row.