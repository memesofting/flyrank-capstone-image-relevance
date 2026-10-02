-- 001_extensions_and_core.sql
--
-- Extensions, timestamp trigger, and the core content tables:
--   posts          - blog posts that images will be matched against
--   images         - image records; identity is the content hash, not the filename
--   image_metadata - one trusted vision analysis per image/model version
--
-- See docs/DATABASE.md. Every schema change in this project is a migration.

-- pgvector: required for image_embeddings/post_embeddings in migration 002.
CREATE EXTENSION IF NOT EXISTS vector;

-- gen_random_uuid() for id defaults, so the database is the source of UUIDs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Keeps updated_at accurate without relying on application code to remember.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- posts
-- ---------------------------------------------------------------------------
CREATE TABLE posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  content TEXT NOT NULL CHECK (length(btrim(content)) > 0),
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER posts_set_updated_at
  BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- images
-- ---------------------------------------------------------------------------
-- original_filename is provenance only. It is never used as semantic identity
-- and never as matching evidence (docs/PROJECT-REQUIREMENTS.md).
CREATE TABLE images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key TEXT NOT NULL CHECK (length(btrim(storage_key)) > 0),
  original_filename TEXT NOT NULL CHECK (length(btrim(original_filename)) > 0),
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT images_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'READY', 'FLAGGED', 'FAILED'))
);

CREATE TRIGGER images_set_updated_at
  BEFORE UPDATE ON images
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- NOT unique: identical bytes may legitimately appear twice in the corpus.
-- The index serves the dedupe lookup; the decision to reuse or reject the
-- duplicate belongs to the ingestion service (Phase 2), not the schema.
CREATE INDEX idx_images_sha256 ON images (sha256);

-- Worker scans pick up images awaiting vision processing.
CREATE INDEX idx_images_status ON images (status);

-- ---------------------------------------------------------------------------
-- image_metadata
-- ---------------------------------------------------------------------------
-- One trusted analysis per (image, model, model_version). The unique index is
-- the idempotency guarantee that a retried vision job cannot create a second
-- classification of the same image.
CREATE TABLE image_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id UUID NOT NULL REFERENCES images (id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(btrim(subject)) > 0),
  category TEXT NOT NULL CHECK (length(btrim(category)) > 0),
  -- JSONB array of strings, mirroring the vision schema's attributes field.
  -- Constraint enforces the array shape; element validation is Zod's job
  -- (docs/AI-PIPELINE.md).
  attributes JSONB NOT NULL DEFAULT '[]'::jsonb,
  caption TEXT NOT NULL CHECK (length(btrim(caption)) > 0),
  confidence NUMERIC(5,4) NOT NULL,
  raw_response JSONB,
  validation_status TEXT NOT NULL DEFAULT 'VALID',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT image_metadata_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),

  CONSTRAINT image_metadata_validation_check
    CHECK (validation_status IN ('VALID', 'LOW_CONFIDENCE', 'INVALID')),

  CONSTRAINT image_metadata_attributes_is_array
    CHECK (jsonb_typeof(attributes) = 'array'),

  CONSTRAINT image_metadata_raw_response_is_object
    CHECK (raw_response IS NULL OR jsonb_typeof(raw_response) = 'object')
);

CREATE TRIGGER image_metadata_set_updated_at
  BEFORE UPDATE ON image_metadata
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX uq_image_metadata_model
  ON image_metadata (image_id, model, model_version);

-- The mismatch guard filters candidates by category and by subject
-- (docs/PROJECT-ARCHITECTURE.md), so both are indexed for review/analysis queries.
CREATE INDEX idx_image_metadata_category ON image_metadata (category);
CREATE INDEX idx_image_metadata_subject ON image_metadata (subject);
