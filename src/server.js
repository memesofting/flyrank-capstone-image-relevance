/**
 * HTTP server entry point.
 *
 * Responsibilities: load validated configuration, start listening, and shut
 * down cleanly so in-flight requests and pooled connections are released.
 *
 * `npm run dev` (nodemon) and `npm start` both land here.
 */

import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/pool.js';
import { logger } from './utils/logger.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info('HTTP server listening', {
    port: env.PORT,
    env: env.NODE_ENV,
    health: `http://localhost:${env.PORT}/health`,
  });
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info('Shutting down', { signal });

  const forcedExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  forcedExit.unref();

  server.close(async (error) => {
    if (error) {
      logger.error('Error while closing the HTTP server', { error });
    }
    await closePool();
    clearTimeout(forcedExit);
    process.exit(error ? 1 : 0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: reason });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception; exiting', { error });
  process.exit(1);
});
