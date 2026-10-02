/**
 * Corpus verification.
 *
 * Proves the corpus is real, licensed, and big enough, then reports exactly
 * what it found. Exits non-zero on any failure so it can gate a release.
 *
 *   npm run corpus:verify
 *
 * Checks:
 *   1. the manifest parses and satisfies dataset/manifest.schema.json
 *   2. no duplicate ids, and every file path is unique
 *   3. every file exists and is a decodable image
 *   4. every recorded sha256 matches the bytes on disk
 *   5. recorded width/height/byteSize match the file
 *   6. every categorised image has provenance and a licence
 *   7. no file on disk is missing from the manifest
 *   8. the corpus meets the 40+ image / 4+ category target
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256OfFile } from '../src/utils/hashing.js';
import { inspectImageBuffer } from '../src/utils/image.js';
import { EVALUATED_CATEGORIES, validateManifest } from '../src/validators/manifest.validator.js';

const DATASET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dataset');
const MANIFEST_PATH = join(DATASET_DIR, 'manifest.json');

async function listImageFiles(directory, base = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listImageFiles(join(directory, entry.name), relative)));
    } else if (/\.jpe?g$|\.png$|\.webp$/i.test(entry.name)) {
      files.push(relative);
    }
  }

  return files.sort();
}

async function main() {
  const failures = [];
  const warnings = [];

  const raw = await readFile(MANIFEST_PATH, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`manifest.json is not valid JSON: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const validation = validateManifest(parsed);
  if (!validation.success) {
    console.error('manifest.json does not satisfy the manifest schema:');
    for (const issue of validation.issues) {
      console.error(`  - ${issue.path || '(root)'}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const manifest = validation.data;
  console.log('Corpus verification');
  console.log('===================');
  console.log(`manifest: ${MANIFEST_PATH}`);
  console.log(`schema:   dataset/manifest.schema.json (validated by src/validators/manifest.validator.js)`);
  console.log('');

  // 2. Uniqueness
  const ids = new Set();
  const paths = new Set();
  for (const entry of manifest.images) {
    if (ids.has(entry.id)) {
      failures.push(`duplicate manifest id: ${entry.id}`);
    }
    ids.add(entry.id);

    if (paths.has(entry.image)) {
      failures.push(`duplicate manifest path: ${entry.image}`);
    }
    paths.add(entry.image);
  }

  // 3-5. Every file exists, decodes, and matches its recorded measurements.
  const byCategory = {};
  let verifiedCount = 0;

  for (const entry of manifest.images) {
    const absolutePath = resolve(DATASET_DIR, entry.image);
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;

    if (entry.category !== 'unverified') {
      verifiedCount += 1;
    }

    let buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch {
      failures.push(`${entry.id}: file missing at dataset/${entry.image}`);
      continue;
    }

    const inspection = await inspectImageBuffer(buffer);
    if (!inspection.isImage) {
      failures.push(`${entry.id}: not a decodable image (${inspection.reason})`);
      continue;
    }

    const actualHash = await sha256OfFile(absolutePath);
    if (!entry.sha256) {
      failures.push(`${entry.id}: sha256 not recorded; run "npm run corpus:fetch"`);
    } else if (actualHash !== entry.sha256) {
      failures.push(`${entry.id}: sha256 mismatch (disk ${actualHash.slice(0, 12)}… vs manifest ${entry.sha256.slice(0, 12)}…)`);
    }

    if (entry.width !== inspection.width || entry.height !== inspection.height) {
      failures.push(
        `${entry.id}: dimensions mismatch (disk ${inspection.width}x${inspection.height} vs manifest ${entry.width}x${entry.height})`,
      );
    }

    if (entry.byteSize !== inspection.byteSize) {
      failures.push(
        `${entry.id}: byteSize mismatch (disk ${inspection.byteSize} vs manifest ${entry.byteSize})`,
      );
    }

    // 6. Provenance and licensing
    if (entry.category !== 'unverified') {
      if (entry.provenance !== 'verified') {
        failures.push(`${entry.id}: category "${entry.category}" but provenance is "${entry.provenance}"`);
      }
      if (!entry.sourcePage) {
        failures.push(`${entry.id}: no sourcePage recorded for a categorised image`);
      }
      if (!entry.photographer) {
        failures.push(`${entry.id}: no photographer recorded for a categorised image`);
      }
      if (entry.categorySource === 'filename') {
        failures.push(`${entry.id}: categorySource is "filename"; categories must not come from filenames`);
      }
    }

    if (entry.license !== 'Unsplash License') {
      warnings.push(`${entry.id}: licence is "${entry.license}", not the Unsplash License`);
    }
  }

  // 7. Untracked files
  const onDisk = await listImageFiles(DATASET_DIR);
  for (const file of onDisk) {
    if (!paths.has(file)) {
      failures.push(`file on disk is not in the manifest: dataset/${file}`);
    }
  }

  // 8. Target
  const populated = EVALUATED_CATEGORIES.filter((category) => (byCategory[category] ?? 0) > 0);
  const { minImages, minCategories } = manifest.target;

  if (verifiedCount < minImages) {
    failures.push(`corpus has ${verifiedCount} categorised images, need at least ${minImages}`);
  }
  if (populated.length < minCategories) {
    failures.push(`corpus has ${populated.length} populated categories, need at least ${minCategories}`);
  }

  // Report
  console.log('Per category');
  console.log('-----------');
  for (const category of [...EVALUATED_CATEGORIES, 'unverified']) {
    const count = byCategory[category] ?? 0;
    const label = category === 'unverified' ? '(excluded from the corpus)' : '';
    console.log(`  ${category.padEnd(12)} ${String(count).padStart(3)}  ${label}`);
  }
  console.log('');

  const totalBytes = manifest.images.reduce((sum, entry) => sum + (entry.byteSize ?? 0), 0);
  console.log(`Categorised images: ${verifiedCount} (target ${minImages}+)`);
  console.log(`Populated categories: ${populated.length} (target ${minCategories}+)`);
  console.log(`Manifest entries:     ${manifest.images.length} (${manifest.images.length - verifiedCount} unverified, held aside)`);
  console.log(`Total size:           ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`Licences:             ${[...new Set(manifest.images.map((entry) => entry.license))].join(', ')}`);
  console.log('');

  if (warnings.length) {
    console.log(`Warnings (${warnings.length})`);
    console.log('------------------');
    for (const warning of warnings.slice(0, 20)) {
      console.log(`  ! ${warning}`);
    }
    if (warnings.length > 20) {
      console.log(`  … and ${warnings.length - 20} more`);
    }
    console.log('');
  }

  if (failures.length) {
    console.log(`FAILED (${failures.length})`);
    console.log('----------');
    for (const failure of failures.slice(0, 40)) {
      console.log(`  x ${failure}`);
    }
    if (failures.length > 40) {
      console.log(`  … and ${failures.length - 40} more`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('PASS');
  console.log('----');
  console.log(`Manifest, files, hashes, dimensions, provenance, and licences all agree.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
