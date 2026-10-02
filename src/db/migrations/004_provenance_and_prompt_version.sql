-- 004_provenance_and_prompt_version.sql
--
--   images            + provenance columns linking a row back to the corpus manifest
--   image_metadata    + prompt_version, extended into the idempotency key
--
-- Phase 2. See docs/DATABASE.md.

-- ---------------------------------------------------------------------------
-- images: PROVENANCE
-- ---------------------------------------------------------------------------
-- Why this exists
-- ---------------
-- Phase 1 stored enough to identify an image by hash and render it, but nothing
-- about WHERE IT CAME FROM. That was fine until the first corpus run, when it
-- became impossible to answer, from the database alone, "is this row's licence
-- actually the Unsplash License, or is it one of the 16 files whose provenance
-- could not be established?"
--
-- AGENTS.md requires the corpus to be licensed and reproducible, and requires
-- evidence rather than assertion. Evidence that cannot be queried is not
-- evidence, so provenance becomes a column rather than a fact held in a
-- separate JSON file.
--
-- IMPORTANT — this is ground truth, NOT model output.
-- `corpus_category` is the species label taken from the Unsplash photo-page
-- description authored by the photographer. It is never written by the vision
-- model. Phase 4 measures classification quality by comparing
-- image_metadata.subject against this column, so it must stay independent of
-- whatever the model said. Keeping the two apart is what makes the comparison
-- meaningful instead of circular.
ALTER TABLE images
  ADD COLUMN manifest_id TEXT,
  ADD COLUMN corpus_category TEXT,
  ADD COLUMN source TEXT,
  ADD COLUMN source_page TEXT,
  ADD COLUMN photographer TEXT,
  ADD COLUMN license TEXT,
  ADD COLUMN provenance TEXT;

-- corpus_category is the Phase 4 evaluation key: "how many images did the model
-- label correctly" is a GROUP BY over this column.
CREATE INDEX idx_images_corpus_category ON images (corpus_category);

-- The batch processor resumes by asking "what have I not ingested yet?", and
-- manifest_id is the stable join between the manifest and the database.
CREATE INDEX idx_images_manifest_id ON images (manifest_id);

-- A corpus file whose provenance is unverified must stay distinguishable from a
-- verified one no matter what the model classified it as.
ALTER TABLE images
  ADD CONSTRAINT images_provenance_check
  CHECK (provenance IS NULL OR provenance IN ('verified', 'unverified'));

-- ---------------------------------------------------------------------------
-- image_metadata: PROMPT VERSION
-- ---------------------------------------------------------------------------
-- Phase 1 made one trusted analysis per (image, model, model_version). That is
-- not sufficient once the PROMPT is also versioned, because a revised prompt is
-- a different analysis: re-running it must produce a new row rather than
-- colliding with the previous prompt's result.
--
-- This matters for evidence integrity. If a prompt revision silently
-- overwrote earlier classifications, then the confidence values backing
-- EVIDENCE.md would describe a mixture of two prompts while appearing to
-- describe one. Keeping both makes that visible and keeps old results valid.
ALTER TABLE image_metadata
  ADD COLUMN prompt_version TEXT NOT NULL DEFAULT 'v1';

-- The idempotency guarantee for the vision pipeline: a retried job for the
-- same image, model and prompt version can never create a second analysis.
DROP INDEX uq_image_metadata_model;
CREATE UNIQUE INDEX uq_image_metadata_model
  ON image_metadata (image_id, model, model_version, prompt_version);

-- Phase 2 reports the run's real distribution of confidence and how often the
-- model agreed with the photographer-authored corpus_category. Both are GROUP
-- BYs over these columns.
CREATE INDEX idx_image_metadata_validation_status ON image_metadata (validation_status);