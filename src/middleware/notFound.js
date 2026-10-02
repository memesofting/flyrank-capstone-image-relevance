/**
 * Catch-all for unmatched routes.
 *
 * Registered after every router so an unknown path returns the same JSON error
 * shape as any other failure instead of Express's HTML page.
 *
 * This throws rather than writing a response directly: `errorHandler` is the
 * single place that shapes an error body, and an unmatched route must not be
 * the one exception to that rule.
 */

import { notFoundError } from '../domain/errors.js';

export function notFoundHandler(req) {
  throw notFoundError(`Cannot ${req.method} ${req.path}`);
}