/**
 * Error taxonomy.
 *
 * Domain layer, because the meaning of an error code (and its HTTP status) is
 * a business decision rather than an HTTP-layer concern. The Express error
 * handler maps these to the JSON error shape documented in docs/API.md.
 */

export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

const STATUS_BY_CODE = {
  [ERROR_CODES.VALIDATION_ERROR]: 400,
  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.CONFLICT]: 409,
  [ERROR_CODES.UNSUPPORTED_MEDIA_TYPE]: 415,
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 503,
  [ERROR_CODES.INTERNAL_ERROR]: 500,
};

export class AppError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message human-readable, safe to return to the client
   * @param {object} [options]
   * @param {unknown} [options.details] extra context for development output
   * @param {Error} [options.cause] original error, kept for server-side logs
   */
  constructor(code, message, { details, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code] ?? 500;
    this.details = details;
    this.expose = true;
  }
}

export const validationError = (message, details) =>
  new AppError(ERROR_CODES.VALIDATION_ERROR, message, { details });

export const notFoundError = (message) => new AppError(ERROR_CODES.NOT_FOUND, message);

export const conflictError = (message) => new AppError(ERROR_CODES.CONFLICT, message);

export const serviceUnavailableError = (message, cause) =>
  new AppError(ERROR_CODES.SERVICE_UNAVAILABLE, message, { cause });

export const internalError = (message = 'Internal server error', cause) =>
  new AppError(ERROR_CODES.INTERNAL_ERROR, message, { cause });

export function isAppError(value) {
  return value instanceof AppError;
}

export function statusForCode(code) {
  return STATUS_BY_CODE[code] ?? 500;
}
