/**
 * Express application factory.
 *
 * Builds and configures the app. It does not listen: starting the HTTP server
 * is server.js's job. Keeping the two apart lets tests mount the app on an
 * ephemeral port without booting a server of their own design.
 *
 * Current surface (Phase 1):
 *   GET  /health         liveness, no dependencies
 *   GET  /health/ready   readiness, probes PostgreSQL
 *   POST /api/posts
 *   GET  /api/posts
 *   GET  /api/posts/:id
 *
 * Image, matching, suggestion, review, and job endpoints are Phase 2-4 and
 * are deliberately not registered. See docs/API.md.
 */

import express from 'express';

import { API_BASE_PATH } from './config/constants.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFoundHandler } from './middleware/notFound.js';
import healthRoutes from './routes/health.routes.js';
import apiRoutes from './routes/index.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.use(healthRoutes);
  app.use(API_BASE_PATH, apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
