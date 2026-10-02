-- 002_embeddings_and_suggestions.sql
--
--   image_embeddings  - caption vectors for image-side semantic retrieval
--   post_embeddings   - post text vectors in the same semantic space
--   suggestions       - ranked (post, image) candidates with guard decisions
--   reviews           - human approve/reject decisions on suggestions
--
-- The AI calls that populate these tables are Phase 2/3 work. This migration
-- only establishes the persistent shape.

-- ===========================================================================
-- DELETE BEHAVIOUR — TWO DIFFERENT RULES, DELIBERATELY
-- ===========================================================================
-- Derived data cascades; evidence does not.
--
--   image_embeddings / post_embeddings  ON DELETE CASCADE
--     Machine-derived and regenerable. An orphaned vector would silently
--     pollute the HNSW index and corrupt retrieval, so it must not survive its
--     parent row.
--
--   suggestions / reviews              ON DELETE RESTRICT
--     This is the evidence trail. Requirement 12 is that a reviewer can inspect
--     WHY a recommendation was made. If deleting a post also silently deleted
--     its suggestions and a human's approve/reject decision, that requirement
--     would be satisfied only until the first delete. RESTRICT means removing a
--     post that has been matched is an explicit, deliberate act rather than a
--     side effect.
--
--   ai_calls.job_id                    ON DELETE SET NULL
--     A cost record must outlive the job that produced it.
--
-- Consequences, accepted deliberately: a post or image that has been matched or
-- labelled cannot be deleted in one statement. At this corpus size that is the
-- correct trade, and it forces the operator to decide.
-- ===========================================================================

-- ===========================================================================
-- VECTOR DIMENSION WARNING — TEMPORARY PHASE 1 DESIGN VALUE
-- ===========================================================================
-- `vector(768)` is a PLACEHOLDER, not a validated dimension. The real value is
-- a property of the embedding model selected in Phase 2/3:
--
--   gemini  text-embedding-004  -> 768
--   ollama  nomic-embed-text    -> 768
--   ollama  mxbai-embed-large   -> 1024
--
-- If the selected model does not return 768 dimensions, this file must be
-- superseded by a migration that alters the column type, and
-- EMBEDDING_DIMENSION in src/config/constants.js must be updated to match.
-- Both embedding tables live in this one file so that change stays contained.
--
-- Image caption embeddings and post embeddings MUST use the same model and
-- dimension, or cosine comparison between them is meaningless
-- (docs/DATABASE.md, docs/AI-PIPELINE.md).
--
-- See docs/adr/ADR-001-vector-dimension-placeholder.md.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- image_embeddings
-- ---------------------------------------------------------------------------
-- The caption embedding is the primary image-side semantic representation
-- required by the brief (docs/PROJECT-ARCHITECTURE.md, "Why captions are
-- embedded").
CREATE TABLE image_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id UUID NOT NULL REFERENCES images (id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  embedding VECTOR(768) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One embedding per image/model version: a retried embedding job updates this
-- row instead of inserting a duplicate.
CREATE UNIQUE INDEX uq_image_embedding_model
  ON image_embeddings (image_id, model, model_version);

-- Phase 3 retrieves candidates by cosine distance; HNSW is the index that
-- serves top-k nearest-neighbour ordering.
CREATE INDEX idx_image_embeddings_vector
  ON image_embeddings USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- post_embeddings
-- ---------------------------------------------------------------------------
CREATE TABLE post_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  embedding VECTOR(768) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_post_embedding_model
  ON post_embeddings (post_id, model, model_version);

CREATE INDEX idx_post_embeddings_vector
  ON post_embeddings USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- suggestions
-- ---------------------------------------------------------------------------
-- One row per (post, image) per matcher configuration, so re-running matching
-- for the same configuration cannot duplicate a logical suggestion.
CREATE TABLE suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts (id) ON DELETE RESTRICT,
  image_id UUID NOT NULL REFERENCES images (id) ON DELETE RESTRICT,
  semantic_similarity NUMERIC(7,6) NOT NULL,
  vision_confidence NUMERIC(5,4),
  guard_status TEXT NOT NULL,
  guard_reason TEXT NOT NULL CHECK (length(btrim(guard_reason)) > 0),
  rank INTEGER NOT NULL CHECK (rank > 0),
  matcher_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT suggestions_guard_status_check
    CHECK (guard_status IN ('ACCEPTED', 'REJECTED')),

  CONSTRAINT suggestions_similarity_check
    CHECK (semantic_similarity >= -1 AND semantic_similarity <= 1),

  CONSTRAINT suggestions_vision_confidence_check
    CHECK (vision_confidence IS NULL OR (vision_confidence >= 0 AND vision_confidence <= 1)),

  -- One ranked candidate per post/image per matcher version.
  CONSTRAINT suggestions_post_image_matcher_uniq
    UNIQUE (post_id, image_id, matcher_version)
);

-- Primary read for GET /api/posts/:id/images: one post's ranked results.
CREATE INDEX idx_suggestions_post_rank ON suggestions (post_id, rank);

-- Review queue filters on guard status to list what was accepted vs rejected.
CREATE INDEX idx_suggestions_status ON suggestions (guard_status);

-- ---------------------------------------------------------------------------
-- reviews
-- ---------------------------------------------------------------------------
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id UUID NOT NULL REFERENCES suggestions (id) ON DELETE RESTRICT,
  decision TEXT NOT NULL,
  notes TEXT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT reviews_decision_check
    CHECK (decision IN ('APPROVED', 'REJECTED'))
);

-- One human decision per suggestion. Re-reviewing updates the existing row.
CREATE UNIQUE INDEX uq_reviews_suggestion ON reviews (suggestion_id);
