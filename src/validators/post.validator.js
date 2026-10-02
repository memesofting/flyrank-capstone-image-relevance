/**
 * Request schemas for post endpoints.
 *
 * Zod owns every boundary rule so that services and repositories can assume
 * their input is already typed and constrained.
 */

import { z } from 'zod';

export const uuidSchema = z.string().uuid('must be a valid UUID');

/** Path params for routes keyed by post id. */
export const postIdParamsSchema = z.object({ id: uuidSchema });

/** Body for POST /api/posts. */
export const createPostBodySchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'title is required')
      .max(200, 'title must be 200 characters or fewer'),
    content: z
      .string()
      .trim()
      .min(1, 'content is required')
      .max(50_000, 'content must be 50000 characters or fewer'),
    // Optional override. When omitted the service derives a slug from the
    // title and de-duplicates it (see src/services/post.service.js).
    slug: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase words separated by hyphens')
      .optional(),
  })
  .strict();

/** Query for GET /api/posts. */
export const listPostsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
