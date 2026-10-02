/**
 * Centralized Express error handling.
 *
 * Produces one JSON shape for every failure, per docs/API.md:
 *
 *   { "error": { "code", "message", "details": [] } }
 *
 * Contract:
 *  - Validation problems are 4xx, never 500.
 *  - Unknown errors are logged in full and returned as a generic 500.
 *  - `details` is always present so clients can parse one shape.
 *  - Stack traces and internal error text never reach the client.
 *
 * `details` is safe to expose in every environment: it is built only from Zod
 * issue messages about the caller's own input. Server-internal failure text is
 * withheld separately, by `normalize()` above replacing the message and by the
 * 500 path below.
 */

import { ZodError } from 'zod';

import { ERROR_CODES, isAppError } from '../domain/errors.js';
import { logger } from '../utils/logger.js';

function normalize(error) {
  if (isAppError(error)) {
    return {
      status: error.status,
      code: error.code,
      message: error.expose ? error.message : 'Internal server error',
      details: error.details ?? [],
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Request validation failed',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  // Raised by express.json() for malformed payloads.
  if (error?.type === 'entity.parse.failed') {
    return {
      status: 400,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Request body is not valid JSON',
      details: [],
    };
  }

  return {
    status: 500,
    code: ERROR_CODES.INTERNAL_ERROR,
    message: 'Internal server error',
    details: [],
  };
}

/**
 * Express error middleware. Identified by its four parameters; the unused
 * `next` is required by the framework and intentionally left in place.
 */
export function errorHandler(error, req, res, next) {
  void next;

  const { status, code, message, details } = normalize(error);

  const logContext = { method: req.method, path: req.originalUrl, status, code, error };

  if (status >= 500) {
    logger.error('Request failed', logContext);
  } else {
    logger.warn('Request rejected', logContext);
  }

  res.status(status).json({ error: { code, message, details } });
}
