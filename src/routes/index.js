/**
 * API router.
 *
 * Mounted at API_BASE_PATH (/api) by app.js. Resource routers are registered
 * here as their Phase 1 surface grows; docs/API.md is the contract.
 */

import { Router } from 'express';

import postsRoutes from './posts.routes.js';

const router = Router();

router.use(postsRoutes);

export default router;
