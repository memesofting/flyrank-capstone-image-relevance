/**
 * Corpus ingestion.
 *
 * Turns dataset/manifest.json into `images` rows, deduplicating by content hash.
 *
 * The dedupe decision lives here rather than in the schema on purpose.
 * `images.sha256` is deliberately NOT unique (migration 001): identical bytes may
 * legitimately appear twice, and only ingestion — which can see the whole
 * manifest, including which entry is primary — can decide whether a repeat is a
 * duplicate to skip or a second reference to keep. A unique index would have
 * made that decision by throwing, which is the wrong place to express it.
 *
 * The manifest is read through its own Zod validator, so a malformed manifest
 * fails here rather than halfway through a paid batch.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Hex } from '../utils/hashing.js';
import { inspectImageBuffer } from '../utils/image.js';
import { manifestSchema } from '../validators/manifest.validator.js';
import { query } from '../db/pool.js';
import * as imagesRepository from '../repositories/images.repository.js';
import { buildIdempotencyKey, enqueueJob } from '../repositories/jobs.repository.js';
import {
  DEFAULT_MODEL_VERSION,
  EMBEDDING_OPERATION,
  VISION_OPERATION,
} from './vision.service.js';
import { PROMPT_VERSION } from '../config/constants.js';

export const CORPUS_MANIFEST_PATH = 'dataset/manifest.json';

/**
 * Resolve the corpus root that manifest paths are relative to.
 *
 * Manifest entries look like "images/fox/fox-001.jpg", i.e. relative to the
 * directory CONTAINING the manifest, matching scripts/verify-corpus.js. Deriving
 * this from import.meta.url rather than from process.cwd() means ingestion
 * behaves identically however the script is invoked, which is also why the
 * Phase 1 unit tests are documented as needing to run from the repository root.
 */
export const CORPUS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dataset');

/**
 * @typedef {object} IngestionSummary
 * @property {number} seen         entries in the manifest
 * @property {number} inserted     new images rows created
 * @property {number} reused       already present by hash or manifest id
 * @property {number} rejected     entries that failed validation
 * @property {number} enqueued     vision jobs enqueued (new or re-queued)
 * @property {{ id: string, reason: string }[]} problems
 */

/**
 * Ingest the manifest.
 *
 * @param {object} [options]
 * @param {string} [options.manifestPath]
 * @param {string} [options.model] model id, part of the job idempotency key
 * @param {string} [options.modelVersion]
 * @param {string} [options.promptVersion]
 * @param {number} [options.maxImages]
 * @param {string} [options.dataDir] root that manifest paths are relative to
 * @returns {Promise<IngestionSummary>}
 */
export async function ingestCorpus({
  manifestPath = CORPUS_MANIFEST_PATH,
  model,
  modelVersion = DEFAULT_MODEL_VERSION,
  promptVersion = PROMPT_VERSION,
  maxImages = null,
  dataDir = path.dirname(path.resolve(manifestPath)),
} = {}) {
  const summary = {
    seen: 0,
    inserted: 0,
    reused: 0,
    rejected: 0,
    enqueued: 0,
    problems: [],
  };

  const raw = await readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);

  const validation = manifestSchema.safeParse(parsed);
  if (!validation.success) {
    const detail = validation.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`corpus manifest is invalid: ${detail}`);
  }

  const { images } = validation.data;
  const seenHashes = new Set();

  for (const entry of images) {
    if (maxImages !== null && summary.seen >= maxImages) {
      break;
    }

    summary.seen += 1;

    // Path containment. A manifest is data, and a `../../etc/passwd` entry in a
    // fetched file must not become a filesystem read outside the corpus.
    const absolutePath = path.resolve(dataDir, entry.image);
    const resolvedRoot = path.resolve(dataDir);
    if (!absolutePath.startsWith(resolvedRoot + path.sep)) {
      summary.rejected += 1;
      summary.problems.push({ id: entry.id, reason: `path escapes the corpus root: ${entry.image}` });
      continue;
    }

    let bytes;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      summary.rejected += 1;
      summary.problems.push({ id: entry.id, reason: `cannot read ${entry.image}: ${error.message}` });
      continue;
    }

    // Confirm the bytes really are an image before spending a vision call on
    // them. The manifest's declared width/height is data, not a fact.
    const inspection = await inspectImageBuffer(bytes);
    if (!inspection.isImage) {
      summary.rejected += 1;
      summary.problems.push({ id: entry.id, reason: inspection.reason });
      continue;
    }

    const actualSha256 = sha256Hex(bytes);

    // The manifest records a hash; a mismatch means the file on disk is not the
    // one that was reviewed and licensed. Silently re-deriving would let an
    // unverified file pass as verified, which is the exact failure the
    // provenance work exists to prevent.
    if (entry.sha256 && entry.sha256 !== actualSha256) {
      summary.rejected += 1;
      summary.problems.push({
        id: entry.id,
        reason: `sha256 mismatch: manifest says ${entry.sha256.slice(0, 12)}…, file is ${actualSha256.slice(0, 12)}…`,
      });
      continue;
    }

    // Duplicate bytes INSIDE the manifest: the same file listed twice. Reuse the
    // first row rather than storing the same image twice.
    if (seenHashes.has(actualSha256)) {
      summary.reused += 1;
      continue;
    }
    seenHashes.add(actualSha256);

    // Already ingested on a previous run.
    const byManifestId = await imagesRepository.findImageByManifestId(entry.id);
    if (byManifestId) {
      summary.reused += 1;
      await enqueueVisionJob({ image: byManifestId, model, modelVersion, promptVersion, summary });
      continue;
    }

    const existingByHash = await imagesRepository.findImagesBySha256(actualSha256);
    if (existingByHash.length > 0) {
      // Same bytes already stored under a different manifest id (for example an
      // image reachable from two Unsplash pages). Reuse the row: embedding it
      // twice would double-count it in retrieval.
      summary.reused += 1;
      await enqueueVisionJob({ image: existingByHash[0], model, modelVersion, promptVersion, summary });
      continue;
    }

    const image = await imagesRepository.insertImage({
      storageKey: absolutePath,
      // original_filename is provenance only. It is never semantic identity and
      // never matching evidence.
      originalFilename: path.basename(entry.image),
      mimeType: inspection.mimeType,
      byteSize: inspection.byteSize,
      width: inspection.width,
      height: inspection.height,
      sha256: actualSha256,
      status: 'PENDING',
      manifestId: entry.id,
      corpusCategory: entry.category,
      source: entry.source ?? null,
      sourcePage: entry.sourcePage ?? null,
      photographer: entry.photographer ?? null,
      license: entry.license ?? null,
      provenance: entry.provenance ?? null,
    });

    summary.inserted += 1;
    await enqueueVisionJob({ image, model, modelVersion, promptVersion, summary });
  }

  return summary;
}

/**
 * Enqueue the vision job for an image.
 *
 * Idempotent by construction: the key is derived only from things that change the
 * output, so re-ingesting the corpus does not create a second job, and a re-run
 * resumes rather than restarting.
 */
async function enqueueVisionJob({ image, model, modelVersion, promptVersion, summary }) {
  if (!model) {
    return;
  }

  const idempotencyKey = buildIdempotencyKey({
    entityType: 'image',
    entityId: image.id,
    operation: VISION_OPERATION,
    model,
    modelVersion,
    promptVersion,
  });

  const { created } = await enqueueJob({
    type: VISION_OPERATION,
    entityType: 'image',
    entityId: image.id,
    idempotencyKey,
    maxAttempts: 3,
  });

  if (created) {
    summary.enqueued += 1;
  }
}

/**
 * Enqueue caption embedding for images that now have a validated caption.
 *
 * Runs after vision, never before: embedding a caption that does not exist yet
 * fails permanently, so a single "embed everything" pass cannot be enqueued
 * ahead of the analysis it depends on.
 *
 * Images that already have an embedding for this model are skipped, so re-running
 * the batch does not redo paid work that is already durable.
 */
export async function enqueueEmbeddingsForAnalysedImages({
  model,
  modelVersion = DEFAULT_MODEL_VERSION,
  limit = 500,
}) {
  if (!model) {
    return { enqueued: 0, skipped: 0 };
  }

  // DISTINCT ON picks ONE validated analysis per image — the most recent — and
  // records its id on the job. It is not enough to select the image_id: the
  // handler needs to embed a specific caption, and "whichever row sorts last"
  // stops being the right answer the moment a second prompt version exists.
  // LOW_CONFIDENCE is included because a flagged caption is still a usable
  // caption, and the flag travels with the metadata row for Phase 3's guard.
  const { rows: candidates } = await query(
    `SELECT DISTINCT ON (m.image_id) m.id AS metadata_id, m.image_id, m.model AS vision_model
     FROM image_metadata m
     WHERE m.validation_status IN ('VALID', 'LOW_CONFIDENCE')
       AND NOT EXISTS (
         SELECT 1 FROM image_embeddings e
         WHERE e.image_id = m.image_id AND e.model = $1
       )
     ORDER BY m.image_id, m.created_at DESC
     LIMIT $2`,
    [model, limit],
  );

  let enqueued = 0;

  for (const candidate of candidates) {
    const idempotencyKey = buildIdempotencyKey({
      entityType: 'image',
      entityId: candidate.image_id,
      operation: EMBEDDING_OPERATION,
      model,
      modelVersion,
    });

    const { created } = await enqueueJob({
      type: EMBEDDING_OPERATION,
      entityType: 'image',
      entityId: candidate.image_id,
      idempotencyKey,
      maxAttempts: 3,
      payload: {
        metadataId: candidate.metadata_id,
        visionModel: candidate.vision_model,
      },
    });

    if (created) {
      enqueued += 1;
    }
  }

  return { enqueued, skipped: candidates.length - enqueued };
}