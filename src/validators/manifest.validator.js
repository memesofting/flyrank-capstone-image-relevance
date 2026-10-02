/**
 * Dataset manifest schema.
 *
 * The manifest is the corpus's source of truth: it records provenance,
 * licensing, and the category assigned by a human curator. The Phase 2 batch
 * pipeline discovers work from this file, and `npm run corpus:verify` proves
 * the files on disk still match it.
 *
 * Deliberate design point: `category` is curation ground truth. It is not
 * derived from a filename and it is not what the vision model will produce.
 * Comparing the two in Phase 2 is how the vision pipeline gets evaluated.
 */

import { z } from 'zod';

export const CATEGORIES = [
  'fox',
  'wolf',
  'dog',
  'bear',
  'deer',
  'other',
  'unverified',
];

/** Categories that count toward the "4+ categories" requirement. */
export const EVALUATED_CATEGORIES = ['fox', 'wolf', 'dog', 'bear', 'deer', 'other'];

export const imageEntrySchema = z.object({
  /** Stable id, and the filename stem under dataset/. */
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be lowercase hyphenated'),

  /** Path relative to dataset/, e.g. "images/fox/fox-001.jpg". */
  image: z.string().regex(/^(images|unverified)\//, 'image must live under dataset/images or dataset/unverified'),

  category: z.enum(CATEGORIES),

  /** How the category was decided. Never "filename". */
  categorySource: z.string().min(1),

  /** The source's own words describing the image, when known. */
  sourceDescription: z.string().nullable(),

  source: z.string().min(1),
  sourcePage: z.string().url().nullable(),
  sourceUrl: z.string().url().nullable(),

  photographer: z.string().nullable(),
  license: z.string().min(1),
  licenseUrl: z.string().url().nullable(),

  provenance: z.enum(['verified', 'unverified']),
  note: z.string().optional(),

  /** How the local bytes were obtained. */
  fetchedBy: z.string().optional(),

  /** Set by `npm run corpus:fetch` from the actual downloaded file. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  byteSize: z.number().int().positive().nullable(),

  /** Original provider id, when the source exposes one. */
  unsplashId: z.string().optional(),
});

export const manifestSchema = z.object({
  version: z.number().int().positive(),
  description: z.string().min(1),
  categories: z.array(z.enum(CATEGORIES)).min(4, 'the corpus must declare at least 4 categories'),
  target: z.object({
    minImages: z.number().int().positive(),
    minCategories: z.number().int().positive(),
  }),
  counts: z
    .object({
      total: z.number().int().nonnegative(),
      verified: z.number().int().nonnegative(),
      unverified: z.number().int().nonnegative(),
      byCategory: z.record(z.string(), z.number().int().nonnegative()),
    })
    .optional(),
  images: z.array(imageEntrySchema).min(1),
});

/**
 * Validate a parsed manifest object.
 *
 * @param {unknown} value
 * @returns {{ success: true, data: object } | { success: false, issues: { path: string, message: string }[] }}
 */
export function validateManifest(value) {
  const result = manifestSchema.safeParse(value);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}
