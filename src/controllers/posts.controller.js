/**
 * Post controller: HTTP in, HTTP out. No business rules, no SQL.
 */

import * as postService from '../services/post.service.js';

/** POST /api/posts */
export async function createPost(req, res) {
  const post = await postService.createPost(req.body);
  res.status(201).json({ ...postService.toPostResponse(post), status: 'CREATED' });
}

/** GET /api/posts */
export async function listPosts(req, res) {
  const { posts, total, limit, offset } = await postService.getPosts(req.query);
  res.status(200).json({
    total,
    limit,
    offset,
    posts: posts.map(postService.toPostResponse),
  });
}

/** GET /api/posts/:id */
export async function getPost(req, res) {
  const post = await postService.getPost(req.params.id);
  res.status(200).json(postService.toPostResponse(post));
}
