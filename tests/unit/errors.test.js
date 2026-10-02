import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError, z } from 'zod';

import { errorHandler } from '../../src/middleware/errorHandler.js';
import { notFoundHandler } from '../../src/middleware/notFound.js';
import {
  AppError,
  ERROR_CODES,
  conflictError,
  isAppError,
  notFoundError,
  serviceUnavailableError,
  statusForCode,
  validationError,
} from '../../src/domain/errors.js';

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function handle(error) {
  const res = fakeRes();
  errorHandler(error, { method: 'GET', originalUrl: '/test' }, res, () => {});
  return res;
}

describe('error taxonomy', () => {
  it('maps codes to HTTP statuses', () => {
    assert.equal(statusForCode(ERROR_CODES.VALIDATION_ERROR), 400);
    assert.equal(statusForCode(ERROR_CODES.NOT_FOUND), 404);
    assert.equal(statusForCode(ERROR_CODES.CONFLICT), 409);
    assert.equal(statusForCode(ERROR_CODES.SERVICE_UNAVAILABLE), 503);
    assert.equal(statusForCode(ERROR_CODES.INTERNAL_ERROR), 500);
  });

  it('builds errors with the right code and status', () => {
    assert.equal(validationError('bad').status, 400);
    assert.equal(notFoundError('gone').status, 404);
    assert.equal(conflictError('dupe').status, 409);
    assert.equal(serviceUnavailableError('db down').status, 503);
  });

  it('recognises its own errors only', () => {
    assert.equal(isAppError(new AppError(ERROR_CODES.NOT_FOUND, 'x')), true);
    assert.equal(isAppError(new Error('x')), false);
  });

  it('keeps the original error as the cause', () => {
    const cause = new Error('connection refused');
    assert.equal(serviceUnavailableError('db down', cause).cause, cause);
  });
});

describe('error handler', () => {
  it('returns an AppError with its own status and code', () => {
    const res = handle(notFoundError('Post 123 was not found'));

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, {
      error: { code: 'NOT_FOUND', message: 'Post 123 was not found', details: [] },
    });
  });

  it('returns a validation error as 400, never 500', () => {
    const res = handle(validationError('Invalid request body: title', [{ path: 'title', message: 'Required' }]));

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('converts a stray ZodError into a 400 rather than a 500', () => {
    const zodError = new ZodError([
      { code: 'invalid_type', path: ['title'], message: 'Required', input: undefined, expected: 'string' },
    ]);
    const res = handle(zodError);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('converts malformed JSON into a 400', () => {
    const res = handle(Object.assign(new Error('Unexpected token'), { type: 'entity.parse.failed' }));

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('hides an unknown error behind a generic 500 without leaking its message', () => {
    const res = handle(new Error('ECONNREFUSED 10.0.0.5:5432 password=hunter2'));

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
    assert.equal(res.body.error.message, 'Internal server error');
    assert.ok(!JSON.stringify(res.body).includes('hunter2'));
  });

  it('never includes a stack trace in the response', () => {
    const res = handle(new Error('boom'));

    assert.ok(!('stack' in res.body.error));
    assert.ok(!JSON.stringify(res.body).includes('at '));
  });

  it('always includes a details array so clients parse one shape', () => {
    const withDetails = handle(validationError('Invalid request body', [{ path: 'title', message: 'Required' }]));
    const withoutDetails = handle(notFoundError('nope'));
    const parseFailure = handle(Object.assign(new Error('bad'), { type: 'entity.parse.failed' }));
    const unknown = handle(new Error('boom'));

    assert.deepEqual(withDetails.body.error.details, [{ path: 'title', message: 'Required' }]);
    for (const res of [withoutDetails, parseFailure, unknown]) {
      assert.ok(Array.isArray(res.body.error.details), 'details must be an array');
      assert.deepEqual(res.body.error.details, []);
    }
  });

  it('exposes exactly the same top-level keys for every error', () => {
    const bodies = [
      handle(validationError('Invalid request body', [])),
      handle(notFoundError('nope')),
      handle(new Error('boom')),
    ].map((res) => Object.keys(res.body).sort());

    for (const keys of bodies) {
      assert.deepEqual(keys, ['error']);
    }
  });
});

describe('not found handler', () => {
  it('throws a NOT_FOUND AppError naming the method and path', () => {
    assert.throws(
      () => notFoundHandler({ method: 'DELETE', path: '/api/posts/1' }),
      (error) => {
        assert.equal(error.code, ERROR_CODES.NOT_FOUND);
        assert.equal(error.status, 404);
        assert.equal(error.message, 'Cannot DELETE /api/posts/1');
        return true;
      },
    );
  });

  it('lets errorHandler produce the body, so the shape cannot drift', () => {
    const res = handle(
      (() => {
        try {
          notFoundHandler({ method: 'GET', path: '/api/nope' });
        } catch (error) {
          return error;
        }
        throw new Error('notFoundHandler should have thrown');
      })(),
    );

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, {
      error: { code: 'NOT_FOUND', message: 'Cannot GET /api/nope', details: [] },
    });
  });
});

describe('zod error shape used by the handler', () => {
  it('reports dotted paths', () => {
    const result = z.object({ post: z.object({ id: z.string().uuid() }) }).safeParse({ post: { id: 'x' } });

    assert.equal(result.success, false);
    assert.equal(result.error.issues[0].path.join('.'), 'post.id');
  });
});
