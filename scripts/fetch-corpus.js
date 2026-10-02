/**
 * Corpus fetch.
 *
 * Downloads every manifest entry that is not on disk yet, proves each download
 * is a real image of a supported format, hashes it, and records the measured
 * width/height/byteSize back into the manifest. Re-running is cheap: entries
 * whose file already exists and whose sha256 still matches are skipped.
 *
 *   npm run corpus:fetch            fetch everything missing
 *   npm run corpus:fetch -- --force re-download and re-measure every entry
 *   npm run corpus:fetch -- --only fox
 *
 * Only network access to the recorded `sourceUrl` values happens here, and the
 * manifest is validated before a single byte is written.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectImageBuffer } from '../src/utils/image.js';
import { sha256OfFile, sha256Hex } from '../src/utils/hashing.js';
import { validateManifest } from '../src/validators/manifest.validator.js';

const DATASET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dataset');
const MANIFEST_PATH = join(DATASET_DIR, 'manifest.json');

/** Pause between downloads so a rebuild does not hammer the image CDN. */
const REQUEST_DELAY_MS = 750;
const REQUEST_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function parseArgs(argv) {
  const options = { force: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--force') {
      options.force = true;
    } else if (argv[i] === '--only') {
      options.only = argv[i + 1];
      i += 1;
    }
  }
  return options;
}

async function loadManifest() {
  const raw = await readFile(MANIFEST_PATH, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${MANIFEST_PATH} is not valid JSON: ${error.message}`);
  }

  const result = validateManifest(parsed);
  if (!result.success) {
    const lines = result.issues.map((issue) => `  - ${issue.path || '(root)'}: ${issue.message}`);
    throw new Error(`${MANIFEST_PATH} does not satisfy the manifest schema:\n${lines.join('\n')}`);
  }
  return result.data;
}

async function fileMatchesEntry(entry, absolutePath) {
  if (!entry.sha256) {
    return false;
  }
  try {
    return (await sha256OfFile(absolutePath)) === entry.sha256;
  } catch {
    return false;
  }
}

async function download(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'flyrank-capstone-corpus-builder' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchEntry(entry) {
  const absolutePath = resolve(DATASET_DIR, entry.image);

  if (!entry.sourceUrl) {
    return { entry, status: 'skipped', reason: 'no sourceUrl recorded' };
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  const buffer = await download(entry.sourceUrl);

  const inspection = await inspectImageBuffer(buffer);
  if (!inspection.isImage) {
    return { entry, status: 'failed', reason: inspection.reason };
  }

  // Write to a temporary name first so an interrupted run cannot leave a
  // half-written file that a later run would treat as complete.
  const tempPath = `${absolutePath}.part`;
  await writeFile(tempPath, buffer);

  Object.assign(entry, {
    sha256: sha256Hex(buffer),
    width: inspection.width,
    height: inspection.height,
    byteSize: inspection.byteSize,
  });

  await rename(tempPath, absolutePath);
  return { entry, status: 'fetched', bytes: inspection.byteSize };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest();

  const targets = manifest.images.filter(
    (entry) => !options.only || entry.category === options.only,
  );

  if (options.only && targets.length === 0) {
    console.error(`No manifest entries for category "${options.only}".`);
    process.exitCode = 1;
    return;
  }

  console.log(`Corpus fetch: ${targets.length} manifest entries`);
  console.log(`  dataset:  ${DATASET_DIR}`);
  console.log(`  mode:     ${options.force ? 'force re-download' : 'skip verified files'}`);
  console.log('');

  const summary = { fetched: 0, skipped: 0, failed: 0 };

  for (const [index, entry] of targets.entries()) {
    const absolutePath = resolve(DATASET_DIR, entry.image);

    if (!options.force && (await fileMatchesEntry(entry, absolutePath))) {
      summary.skipped += 1;
      console.log(`  [${index + 1}/${targets.length}] skip  ${entry.id} (already on disk, hash matches)`);
      continue;
    }

    try {
      const result = await fetchEntry(entry);

      if (result.status === 'skipped') {
        summary.skipped += 1;
        console.log(`  [${index + 1}/${targets.length}] skip  ${entry.id} (${result.reason})`);
      } else if (result.status === 'failed') {
        summary.failed += 1;
        console.log(`  [${index + 1}/${targets.length}] FAIL  ${entry.id}: ${result.reason}`);
      } else {
        summary.fetched += 1;
        console.log(
          `  [${index + 1}/${targets.length}] fetch ${entry.id} ` +
            `(${result.bytes} bytes, ${entry.width}x${entry.height})`,
        );
      }
    } catch (error) {
      summary.failed += 1;
      const absolute = absolutePath.endsWith('.part') ? absolutePath : `${absolutePath}.part`;
      await unlink(absolute).catch(() => {});
      console.log(`  [${index + 1}/${targets.length}] FAIL  ${entry.id}: ${error.message}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // Refresh the recorded counts so the manifest describes itself accurately.
  const byCategory = {};
  for (const entry of manifest.images) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
  }
  manifest.counts = {
    total: manifest.images.length,
    verified: manifest.images.filter((entry) => entry.provenance === 'verified').length,
    unverified: manifest.images.filter((entry) => entry.provenance !== 'verified').length,
    byCategory,
  };

  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log('');
  console.log(`Fetched: ${summary.fetched}  Skipped: ${summary.skipped}  Failed: ${summary.failed}`);

  if (summary.failed > 0) {
    console.log('');
    console.log('Run `npm run corpus:verify` for the full state, or re-run this command to retry.');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
