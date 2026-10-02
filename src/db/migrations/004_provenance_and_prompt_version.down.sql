-- 004_provenance_and_prompt_version.down.sql
-- Reverts 004_provenance_and_prompt_version.sql.

-- Restore the Phase 1 idempotency key before dropping prompt_version, otherwise
-- the index cannot be rebuilt against a column that no longer exists.
DROP INDEX IF EXISTS uq_image_metadata_model;
CREATE UNIQUE INDEX uq_image_metadata_model
  ON image_metadata (image_id, model, model_version);

DROP INDEX IF EXISTS idx_image_metadata_validation_status;

ALTER TABLE image_metadata
  DROP COLUMN IF EXISTS prompt_version;

DROP INDEX IF EXISTS idx_images_manifest_id;
DROP INDEX IF EXISTS idx_images_corpus_category;

ALTER TABLE images
  DROP CONSTRAINT IF EXISTS images_provenance_check;

ALTER TABLE images
  DROP COLUMN IF EXISTS provenance,
  DROP COLUMN IF EXISTS license,
  DROP COLUMN IF EXISTS photographer,
  DROP COLUMN IF EXISTS source_page,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS corpus_category,
  DROP COLUMN IF EXISTS manifest_id;