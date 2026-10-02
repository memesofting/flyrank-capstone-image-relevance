/**
 * Health routes. Route files map methods to controllers and nothing else.
 */

import { Router } from 'express';

import * as healthController from '../controllers/health.controller.js';

const router = Router();

router.get('/health', healthController.getLiveness);
router.get('/health/ready', healthController.getReadiness);

export default router;
