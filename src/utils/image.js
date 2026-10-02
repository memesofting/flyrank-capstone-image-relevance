/**
 * Image inspection helpers.
 *
 * The corpus fetch/verify scripts and the later upload endpoint both need to
 * prove a file is a real image of a real format before trusting it. Extension
 * and `Content-Type` are attacker-controlled; the decoded header is not.
 */

import sharp from 'sharp';

/** Formats accepted for the capstone corpus. */
export const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

/** MIME type reported for each supported decoded format. */
export const MIME_BY_FORMAT = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Filename extension -> mime type. `.jpg` and `.jpeg` are the same type. */
const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * Probe a buffer for real image facts.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ isImage: boolean, format: string | null, width: number | null,
 *   height: number | null, byteSize: number, mimeType: string | null, reason?: string }>}
 */
export async function inspectImageBuffer(buffer) {
  const byteSize = buffer.length;

  if (byteSize === 0) {
    return { isImage: false, format: null, width: null, height: null, byteSize, mimeType: null, reason: 'empty file' };
  }

  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  } catch (error) {
    return {
      isImage: false,
      format: null,
      width: null,
      height: null,
      byteSize,
      mimeType: null,
      reason: `not a decodable image: ${error.message}`,
    };
  }

  if (!metadata.format || !SUPPORTED_FORMATS.has(metadata.format)) {
    return {
      isImage: false,
      format: metadata.format ?? null,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      byteSize,
      mimeType: null,
      reason: `unsupported image format: ${metadata.format ?? 'unknown'}`,
    };
  }

  return {
    isImage: true,
    format: metadata.format,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    byteSize,
    mimeType: MIME_BY_FORMAT[metadata.format],
  };
}

/** The canonical mime type for a stored file extension, or null. */
export function mimeTypeFromExtension(extension) {
  const normalized = String(extension).toLowerCase().replace(/^\./, '');
  return MIME_BY_EXTENSION[normalized] ?? null;
}
