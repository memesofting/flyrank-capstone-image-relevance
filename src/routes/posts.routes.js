/**
 * Post routes.
 *
 * Validation middleware runs before the controller, so `req.body`,
 * `req.params`, and `req.query` are already parsed and typed here.
 *
 * `GET /api/posts/:id/images` is intentionally absent: ranked image matching
 * is Phase 3 and does not exist yet (docs/API.md).
 */

import { Router } from 'express';

import * as postsController from '../controllers/posts.controller.js';
import { validate } from '../middleware/validate.js';
import {
  createPostBodySchema,
  listPostsQuerySchema,
  postIdParamsSchema,
} from '../validators/post.validator.js';

const router = Router();

router.post('/posts', validate({ body: createPostBodySchema }), postsController.createPost);
router.get('/posts', validate({ query: listPostsQuerySchema }), postsController.listPosts);
router.get('/posts/:id', validate({ params: postIdParamsSchema }), postsController.getPost);

export default router;
