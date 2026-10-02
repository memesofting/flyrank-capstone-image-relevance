/**
 * Post workflows.
 *
 * Business rules only: slug derivation and de-duplication. No SQL, no HTTP.
 *
 * Phase 3 will enqueue a post-embedding job after creation. That is
 * deliberately absent here: this phase establishes the request/response
 * contract without pretending background work exists.
 */

import { randomUUID } from 'node:crypto';

import { notFoundError } from '../domain/errors.js';
import * as postsRepository from '../repositories/posts.repository.js';

/** Maximum slug length, matching the practical use of the unique index. */
const MAX_SLUG_LENGTH = 80;

/** Turn a title into a URL-safe slug fragment. Pure, so it is unit testable. */
export function slugify(title) {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

/**
 * Derive a slug that is unique.
 *
 * The client's slug is used as-is when supplied. Otherwise the title is
 * slugified and a short random suffix is appended only if the plain slug is
 * already taken, so ordinary posts get readable URLs.
 */
export async function resolveSlug(title, requestedSlug) {
  if (requestedSlug) {
    return requestedSlug;
  }

  const base = slugify(title) || 'post';
  if (!(await postsRepository.slugExists(base))) {
    return base;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = randomUUID().slice(0, 8);
    const candidate = `${base}-${suffix}`;
    if (!(await postsRepository.slugExists(candidate))) {
      return candidate;
    }
  }

  throw new Error('Could not derive a unique slug for the post.');
}

export async function createPost({ title, content, slug: requestedSlug }) {
  const slug = await resolveSlug(title, requestedSlug);
  return postsRepository.insertPost({ title, content, slug });
}

export async function getPost(id) {
  const post = await postsRepository.findPostById(id);
  if (!post) {
    throw notFoundError(`Post ${id} was not found`);
  }
  return post;
}

export async function getPosts({ limit, offset }) {
  const [posts, total] = await Promise.all([
    postsRepository.listPosts({ limit, offset }),
    postsRepository.countPosts(),
  ]);
  return { posts, total, limit, offset };
}

/** Database row -> API response shape (camelCase, no internal columns). */
export function toPostResponse(row) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
