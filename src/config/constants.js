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
 * TEMPORARY DESIGN VALUE — NOT A VALIDATED EMBEDDING DIMENSION.
 *
 * PostgreSQL's `vector` column type requires a fixed dimension, but the real
 * dimension is a property of whichever embedding model gets selected in
 * Phase 2/3. Candidates:
 *
 *   gemini  text-embedding-004   -> 768
 *   ollama  nomic-embed-text     -> 768
 *   ollama  mxbai-embed-large    -> 1024
 *
 * 768 is used as a documented placeholder so Phase 1 can prove the schema,
 * constraints, and indexes exist. Phase 2/3 must either confirm 768 for the
 * selected model or add a migration altering the column type. Both embedding
 * tables are isolated in 002_embeddings_and_suggestions.sql so that change
 * touches a single file.
 *
 * See docs/adr/ADR-001-vector-dimension-placeholder.md.
 */
export const EMBEDDING_DIMENSION = 768;

/** Database identifier used by CREATE EXTENSION. */
export const VECTOR_EXTENSION = 'vector';

/** Milliseconds before a health probe or query is considered failed. */
export const DB_HEALTHCHECK_TIMEOUT_MS = 2000;
