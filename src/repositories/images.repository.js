/**
 * Image, image_metadata and image_embeddings persistence.
 *
 * Deduplication note: `images.sha256` is NOT unique, and that is intentional
 * (migration 001). Identical bytes may legitimately appear twice in a corpus,
 * and the decision to reuse or reject a duplicate belongs to the ingestion
 * service rather than the schema. `findImageBySha256` therefore returns a LIST,
 * and ingestion decides what to do with more than one hit.
 */

import { query } from '../db/pool.js';

const IMAGE_COLUMNS = `id, storage_key, original_filename, mime_type, byte_size,
  width, height, sha256, status, manifest_id, corpus_category, source,
  source_page, photographer, license, provenance, created_at, updated_at`;

const METADATA_COLUMNS = `id, image_id, model, model_version, prompt_version, subject,
  category, attributes, caption, confidence, raw_response, validation_status,
  created_at, updated_at`;

/**
 * Insert an image row.
 *
 * @param {object} image
 */
export async function insertImage({
  storageKey,
  originalFilename,
  mimeType,
  byteSize,
  width,
  height,
  sha256,
  status = 'PENDING',
  manifestId = null,
  corpusCategory = null,
  source = null,
  sourcePage = null,
  photographer = null,
  license = null,
  provenance = null,
}) {
  const { rows } = await query(
    `INSERT INTO images (storage_key, original_filename, mime_type, byte_size,
       width, height, sha256, status, manifest_id, corpus_category, source,
       source_page, photographer, license, provenance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${IMAGE_COLUMNS}`,
    [
      storageKey,
      originalFilename,
      mimeType,
      byteSize,
      width,
      height,
      sha256,
      status,
      manifestId,
      corpusCategory,
      source,
      sourcePage,
      photographer,
      license,
      provenance,
    ],
  );

  return rows[0];
}

/** All rows sharing a content hash. Duplicates are possible by design. */
export async function findImagesBySha256(sha256) {
  const { rows } = await query(
    `SELECT ${IMAGE_COLUMNS} FROM images WHERE sha256 = $1 ORDER BY created_at ASC`,
    [sha256],
  );
  return rows;
}

export async function findImageByManifestId(manifestId) {
  const { rows } = await query(
    `SELECT ${IMAGE_COLUMNS} FROM images WHERE manifest_id = $1 LIMIT 1`,
    [manifestId],
  );
  return rows[0] ?? null;
}

export async function findImageById(id) {
  const { rows } = await query(`SELECT ${IMAGE_COLUMNS} FROM images WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Images not yet successfully analysed, oldest first. */
export async function listImagesNeedingAnalysis({ status, limit = 100, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${IMAGE_COLUMNS} FROM images
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY created_at ASC, id ASC
     LIMIT $2 OFFSET $3`,
    [status ?? null, limit, offset],
  );
  return rows;
}

export async function countImagesByStatus() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS total FROM images GROUP BY status ORDER BY status`,
  );
  return rows;
}

/** Breakdown by the photographer-authored corpus category. */
export async function countImagesByCorpusCategory() {
  const { rows } = await query(
    `SELECT corpus_category, COUNT(*)::int AS total
     FROM images
     GROUP BY corpus_category
     ORDER BY corpus_category NULLS LAST`,
  );
  return rows;
}

/**
 * Update the coarse lifecycle state.
 *
 * `where status IN (...)` guards against a late-arriving retry overwriting a
 * newer state. Without it, a slow first attempt finishing after a successful
 * second attempt could drag a READY image back to PROCESSING.
 */
export async function updateImageStatus(id, status) {
  const { rows } = await query(
    `UPDATE images SET status = $2
     WHERE id = $1 AND status IN ('PENDING', 'PROCESSING')
     RETURNING ${IMAGE_COLUMNS}`,
    [id, status],
  );
  return rows[0] ?? null;
}

/**
 * Insert a vision analysis.
 *
 * ON CONFLICT DO UPDATE rather than DO NOTHING: a retried job must converge on
 * the same single row for a given (image, model, model_version, prompt_version),
 * and the retry's output is the newer one. `xmax` distinguishes insert from
 * update so the caller can tell which happened.
 *
 * `raw_response` keeps the model's own JSON. It is the audit trail that makes
 * "invalid output was never trusted" checkable after the fact instead of only at
 * write time.
 *
 * @param {object} metadata
 */
export async function insertImageMetadata({
  imageId,
  model,
  modelVersion,
  promptVersion,
  subject,
  category,
  attributes,
  caption,
  confidence,
  rawResponse = null,
  validationStatus,
}) {
  const { rows } = await query(
    `INSERT INTO image_metadata (image_id, model, model_version, prompt_version,
       subject, category, attributes, caption, confidence, raw_response, validation_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11)
     ON CONFLICT (image_id, model, model_version, prompt_version) DO UPDATE SET
       subject = EXCLUDED.subject,
       category = EXCLUDED.category,
       attributes = EXCLUDED.attributes,
       caption = EXCLUDED.caption,
       confidence = EXCLUDED.confidence,
       raw_response = EXCLUDED.raw_response,
       validation_status = EXCLUDED.validation_status,
       updated_at = NOW()
     RETURNING ${METADATA_COLUMNS}, (xmax = 0) AS created`,
    [
      imageId,
      model,
      modelVersion,
      promptVersion,
      subject,
      category,
      JSON.stringify(attributes),
      caption,
      confidence,
      rawResponse === null ? null : JSON.stringify(rawResponse),
      validationStatus,
    ],
  );

  const row = rows[0];
  const created = row.created === true;
  delete row.created;
  return { ...row, created };
}

/**
 * Fetch one image_metadata row by its own id.
 *
 * Used by the embedding path, where the job records exactly which analysis it
 * intends to embed. Looking the row up by id rather than by "most recent for
 * this model" is what keeps a stored vector traceable to the analysis it came
 * from once more than one prompt version or model exists.
 */
export async function findImageMetadataById(metadataId) {
  const { rows } = await query(
    `SELECT ${METADATA_COLUMNS} FROM image_metadata WHERE id = $1`,
    [metadataId],
  );

  return rows[0] ?? null;
}

export async function findImageMetadata(imageId, { model, modelVersion, promptVersion } = {}) {
  const { rows } = await query(
    `SELECT ${METADATA_COLUMNS} FROM image_metadata
     WHERE image_id = $1
       AND ($2::text IS NULL OR model = $2)
       AND ($3::text IS NULL OR model_version = $3)
       AND ($4::text IS NULL OR prompt_version = $4)
     ORDER BY created_at DESC
     LIMIT 1`,
    [imageId, model ?? null, modelVersion ?? null, promptVersion ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Persist a caption embedding.
 *
 * ON CONFLICT DO UPDATE so a retry converges rather than colliding. The vector
 * is passed as a pgvector literal, and the cast to vector(N) is what turns an
 * otherwise confusing "expected 768 dimensions, not 700" into the caller's own
 * dimension check failing first with a message naming the model.
 *
 * @param {object} embedding
 */
export async function insertImageEmbedding({
  imageId,
  model,
  modelVersion,
  embedding,
  dimensions,
  sourceText,
  provider,
  normalized = true,
}) {
  const { rows } = await query(
    `INSERT INTO image_embeddings (image_id, model, model_version, dimensions,
       embedding, source_text, provider, normalized)
     VALUES ($1,$2,$3,$4,$5::vector,$6,$7,$8)
     ON CONFLICT (image_id, model, model_version) DO UPDATE SET
       dimensions = EXCLUDED.dimensions,
       embedding = EXCLUDED.embedding,
       source_text = EXCLUDED.source_text,
       provider = EXCLUDED.provider,
       normalized = EXCLUDED.normalized,
       updated_at = NOW()
     RETURNING id, image_id, model, model_version, dimensions, provider, normalized, created_at`,
    [
      imageId,
      model,
      modelVersion,
      dimensions,
      `[${embedding.join(',')}]`,
      sourceText,
      provider,
      normalized,
    ],
  );
  return rows[0];
}

export async function countImageEmbeddings() {
  const { rows } = await query('SELECT COUNT(*)::int AS total FROM image_embeddings');
  return rows[0].total;
}

/**
 * Validation-status distribution across every stored analysis.
 *
 * This is the query that backs the phase gate: it must show that no row carries
 * VALID without the model having produced schema-valid JSON.
 */
export async function summariseImageMetadata({ model, promptVersion } = {}) {
  const { rows } = await query(
    `SELECT
       validation_status,
       model,
       prompt_version,
       COUNT(*)::int                     AS total,
       ROUND(AVG(confidence)::numeric, 4) AS avg_confidence,
       MIN(confidence)                   AS min_confidence,
       MAX(confidence)                   AS max_confidence
     FROM image_metadata
     WHERE ($1::text IS NULL OR model = $1)
       AND ($2::text IS NULL OR prompt_version = $2)
     GROUP BY validation_status, model, prompt_version
     ORDER BY validation_status`,
    [model ?? null, promptVersion ?? null],
  );
  return rows;
}

/**
 * Where the model's subject disagreed with the photographer's description.
 *
 * The Phase 2 accuracy signal. `corpus_category` is independent ground truth
 * written by a human, so agreement between it and `subject` is real evidence.
 * `other` is counted separately: declining to classify is not the same as being
 * wrong, and lumping them together would misreport accuracy.
 */
export async function compareSubjectsToCorpusCategory({ model, promptVersion } = {}) {
  const { rows } = await query(
    `SELECT
       i.corpus_category                          AS expected,
       m.subject                                  AS predicted,
       COUNT(*)::int                              AS total,
       SUM(CASE WHEN m.subject = 'other' THEN 1 ELSE 0 END)::int AS predicted_other,
       SUM(CASE WHEN m.subject = i.corpus_category THEN 1 ELSE 0 END)::int AS agreed
     FROM image_metadata m
     JOIN images i ON i.id = m.image_id
     WHERE i.corpus_category IS NOT NULL
       AND i.corpus_category <> 'unverified'
       AND ($1::text IS NULL OR m.model = $1)
       AND ($2::text IS NULL OR m.prompt_version = $2)
     GROUP BY i.corpus_category, m.subject
     ORDER BY i.corpus_category, total DESC`,
    [model ?? null, promptVersion ?? null],
  );
  return rows;
}