-- 006_embedding_provenance.sql (down)
-- Reverts the image_embeddings provenance columns.

DROP TRIGGER IF EXISTS image_embeddings_set_updated_at ON image_embeddings;
DROP INDEX IF EXISTS idx_image_embeddings_model;

ALTER TABLE image_embeddings
  DROP CONSTRAINT IF EXISTS image_embeddings_dimensions_match;

ALTER TABLE image_embeddings
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS normalized,
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS source_text;