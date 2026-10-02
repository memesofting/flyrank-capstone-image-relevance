/**
 * Content hashing.
 *
 * The SHA-256 of the image bytes is the image's identity for ingestion and
 * deduplication. Filenames are never used as semantic or logical identity —
 * see docs/PROJECT-REQUIREMENTS.md.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

function toBuffer(input) {
  return typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
}

export function sha256Hex(input) {
  return createHash('sha256').update(toBuffer(input)).digest('hex');
}

export async function sha256OfFile(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
