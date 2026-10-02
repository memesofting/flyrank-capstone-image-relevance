/**
 * Post persistence.
 *
 * All SQL for the posts table lives here. Route and controller files never
 * contain queries (docs/PROJECT-ARCHITECTURE.md).
 */

import { query } from '../db/pool.js';

const COLUMNS = 'id, title, content, slug, created_at, updated_at';

/**
 * Insert a post.
 *
 * The unique index on `slug` is the last line of defence against duplicates;
 * the service derives unique slugs first, so a violation here means a real bug.
 *
 * @param {{ title: string, content: string, slug: string }} post
 */
export async function insertPost({ title, content, slug }) {
  const { rows } = await query(
    `INSERT INTO posts (title, content, slug)
     VALUES ($1, $2, $3)
     RETURNING ${COLUMNS}`,
    [title, content, slug],
  );
  return rows[0];
}

export async function findPostById(id) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM posts WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listPosts({ limit, offset }) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM posts
     ORDER BY created_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

export async function countPosts() {
  const { rows } = await query('SELECT COUNT(*)::int AS total FROM posts');
  return rows[0].total;
}

export async function slugExists(slug) {
  const { rows } = await query('SELECT 1 FROM posts WHERE slug = $1', [slug]);
  return rows.length > 0;
}
