/**
 * Application constants.
 *
 * Values here are deliberate design decisions, not tuning knobs. Anything that
 * later phases tune (guard thresholds, retrieval size) belongs in the phase
 * that measures it, driven by evaluation data.
 */

export const SERVICE_NAME = 'flyrank-image-matcher';
export const SERVICE_VERSION = '1.0.0';

/** Public base path for the versioned API described in docs/API.md. */
export const API_BASE_PATH = '/api';

/**
 * EMBEDDING DIMENSION — CONFIRMED BY MEASUREMENT IN PHASE 2.
 *
 * Phase 1 used 768 as an unvalidated placeholder. Phase 2 settled it against a
 * live call to `gemini-embedding-001` with `outputDimensionality: 768`, which
 * returned exactly 768 floats. So `vector(768)` is correct as written and no
 * migration altering the column type was needed.
 *
 * Candidates, with what is actually reachable (see
 * docs/adr/004-vision-model-availability.md):
 *
 *   gemini  gemini-embedding-001 @ 768   -> 768  CONFIRMED, in use
 *   gemini  gemini-embedding-001 default-> 3072 (would need a migration)
 *   gemini  text-embedding-004          -> DEPRECATED, absent from the model list
 *   ollama  nomic-embed-text            -> 768
 *   ollama  mxbai-embed-large           -> 1024
 *
 * `text-embedding-004` is the model Phase 1 named as its justification for 768.
 * It no longer exists on the provider, so that justification was wrong even
 * though the number was right. See docs/adr/002-embedding-dimension.md.
 */
export const EMBEDDING_DIMENSION = 768;

/**
 * Image-side and post-side embeddings MUST come from the same model and
 * dimension, or cosine comparison between them is meaningless
 * (docs/AI-PIPELINE.md, "Embeddings").
 *
 * Phase 2 embeds image captions only. Post embeddings are Phase 3, and must
 * use this same model or every similarity score in Phase 4 is noise.
 */
export const EMBEDDING_MODEL = 'gemini-embedding-001';

/**
 * Vision model, with a fallback.
 *
 * `gemini-2.5-flash` — the obvious first choice — is listed by the API but
 * returns 404 "no longer available to new users". `gemini-3.8-flash` was
 * observed returning 503 "high demand". `gemini-3.5-flash` was verified working
 * and is the fallback, so availability changes do not halt the pipeline.
 *
 * The fallback is resolved once per run, not per image, so a single run never
 * silently mixes models. If a mid-run failover is ever needed, the image's
 * metadata row records which model actually answered.
 */
export const VISION_MODEL = 'gemini-3.8-flash';
export const VISION_MODEL_FALLBACK = 'gemini-3.5-flash';

/**
 * Bumped whenever the prompt or the Zod schema changes shape.
 *
 * It is part of the image_metadata idempotency key, so a revised prompt
 * produces a new analysis row instead of colliding with — or worse,
 * overwriting — results from the previous prompt.
 */
export const PROMPT_VERSION = 'v1';

/** Gemini REST base. Both vision and embeddings live under v1beta. */
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Per-request timeouts.
 *
 * Measured: gemini-3.5-flash returns a 640x427 image in roughly 2-4s. 60s is
 * generous headroom for a cold start without letting a hung socket hold a job
 * slot indefinitely.
 */
export const AI_REQUEST_TIMEOUT_MS = 60_000;

/** Base delay for retry backoff; attempt N waits roughly BASE * 2^(N-1). */
export const AI_RETRY_BASE_DELAY_MS = 2_000;

/**
 * PROVISIONAL — NOT TUNED AGAINST EVALUATION DATA.
 *
 * Below this confidence a classification is persisted as LOW_CONFIDENCE and the
 * image is flagged FLAGGED for review rather than trusted. This value is a
 * reasoned starting point, not a measured one: AGENTS.md requires thresholds to
 * be selected from evaluation data, and that evidence does not exist until
 * Phase 4. Revisit it there.
 *
 * Symmetrically, the guard's own reviewConfidenceFloor sits above this value so
 * that "flagged as uncertain by the pipeline" and "flagged for reviewer
 * attention by the guard" stay distinguishable (docs/ONE-PAGE-DESIGN.md).
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

/** Database identifier used by CREATE EXTENSION. */
export const VECTOR_EXTENSION = 'vector';

/** Milliseconds before a health probe or query is considered failed. */
export const DB_HEALTHCHECK_TIMEOUT_MS = 2_000;
