/**
 * Boundary validation.
 *
 * Every request body, route parameter, and query parameter is parsed with Zod
 * before it reaches a service. Parsed output replaces the raw value, so
 * controllers only ever see validated data.
 */

import { validationError } from '../domain/errors.js';

function toDetails(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function parseOrThrow(schema, value, label) {
  const result = schema.safeParse(value);

  if (!result.success) {
    const details = toDetails(result.error);
    const fields = details.map((detail) => detail.path).filter(Boolean);
    const message = fields.length
      ? `Invalid ${label}: ${[...new Set(fields)].join(', ')}`
      : `Invalid ${label}`;
    throw validationError(message, details);
  }

  return result.data;
}

/**
 * Build a validation middleware.
 *
 * @param {{ body?: import('zod').ZodType, params?: import('zod').ZodType, query?: import('zod').ZodType }} schemas
 * @returns {import('express').RequestHandler}
 */
export function validate(schemas) {
  return function validationMiddleware(req, _res, next) {
    try {
      if (schemas.params) {
        req.params = parseOrThrow(schemas.params, req.params, 'path parameters');
      }
      if (schemas.query) {
        // req.query is a getter in Express 5; define instead of assign.
        Object.defineProperty(req, 'query', {
          value: parseOrThrow(schemas.query, req.query, 'query parameters'),
          writable: true,
          configurable: true,
        });
      }
      if (schemas.body) {
        req.body = parseOrThrow(schemas.body, req.body, 'request body');
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
