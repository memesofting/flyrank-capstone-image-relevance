import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { validate } from '../../src/middleware/validate.js';
import { createPostBodySchema, listPostsQuerySchema, postIdParamsSchema } from '../../src/validators/post.validator.js';

const validPost = {
  title: 'The Behavior of Red Foxes',
  content: 'Red foxes are small omnivorous canids.',
};

/** Run a middleware chain and capture the error it forwards. */
function runMiddleware(middlewares, { body, params, query }) {
  const req = { body, params, query };
  let error = null;

  for (const middleware of middlewares) {
    middleware(req, {}, (thrown) => {
      if (thrown) {
        error = thrown;
      }
    });
    if (error) break;
  }

  return { req, error };
}

describe('validate middleware', () => {
  it('passes a valid body through unchanged', () => {
    const { req, error } = runMiddleware([validate({ body: createPostBodySchema })], {
      body: { ...validPost },
    });

    assert.equal(error, null);
    assert.equal(req.body.title, validPost.title);
  });

  it('trims whitespace from string fields', () => {
    const { req, error } = runMiddleware([validate({ body: createPostBodySchema })], {
      body: { title: '  Foxes  ', content: '  Foxes are canids.  ' },
    });

    assert.equal(error, null);
    assert.equal(req.body.title, 'Foxes');
    assert.equal(req.body.content, 'Foxes are canids.');
  });

  it('rejects a missing body with a 400 VALIDATION_ERROR', () => {
    const { error } = runMiddleware([validate({ body: createPostBodySchema })], { body: {} });

    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.status, 400);
    assert.ok(error.details.some((detail) => detail.path === 'title'));
    assert.ok(error.details.some((detail) => detail.path === 'content'));
  });

  it('rejects an empty title after trimming', () => {
    const { error } = runMiddleware([validate({ body: createPostBodySchema })], {
      body: { ...validPost, title: '   ' },
    });

    assert.equal(error.code, 'VALIDATION_ERROR');
  });

  it('rejects unknown body fields instead of silently dropping them', () => {
    const { error } = runMiddleware([validate({ body: createPostBodySchema })], {
      body: { ...validPost, status: 'HACKED' },
    });

    assert.equal(error.code, 'VALIDATION_ERROR');
  });

  it('rejects an over-long title', () => {
    const { error } = runMiddleware([validate({ body: createPostBodySchema })], {
      body: { ...validPost, title: 'x'.repeat(201) },
    });

    assert.equal(error.code, 'VALIDATION_ERROR');
  });

  it('validates route params', () => {
    const ok = runMiddleware([validate({ params: postIdParamsSchema })], {
      params: { id: '5788dd8a-f8e5-46be-a18f-ba19799cdd24' },
    });
    assert.equal(ok.error, null);

    const bad = runMiddleware([validate({ params: postIdParamsSchema })], {
      params: { id: 'not-a-uuid' },
    });
    assert.equal(bad.error.code, 'VALIDATION_ERROR');
    assert.equal(bad.error.details[0].path, 'id');
  });

  it('coerces and defaults query parameters', () => {
    const { req, error } = runMiddleware([validate({ query: listPostsQuerySchema })], {
      query: { limit: '5' },
    });

    assert.equal(error, null);
    assert.equal(req.query.limit, 5);
    assert.equal(req.query.offset, 0);
  });

  it('rejects a negative offset and an oversized limit', () => {
    assert.equal(
      runMiddleware([validate({ query: listPostsQuerySchema })], { query: { offset: '-1' } }).error.code,
      'VALIDATION_ERROR',
    );
    assert.equal(
      runMiddleware([validate({ query: listPostsQuerySchema })], { query: { limit: '101' } }).error.code,
      'VALIDATION_ERROR',
    );
  });

  it('validates all three sources in one middleware', () => {
    const { error } = runMiddleware([
      validate({ body: createPostBodySchema, params: postIdParamsSchema, query: listPostsQuerySchema }),
    ], {
      body: {},
      params: { id: 'nope' },
      query: {},
    });

    assert.equal(error.code, 'VALIDATION_ERROR');
  });
});

describe('post schemas', () => {
  it('accepts an optional well-formed slug', () => {
    const result = createPostBodySchema.safeParse({ ...validPost, slug: 'red-foxes' });
    assert.equal(result.success, true);
  });

  it('rejects a slug that is not lowercase-hyphenated', () => {
    const result = createPostBodySchema.safeParse({ ...validPost, slug: 'Red Foxes!' });
    assert.equal(result.success, false);
  });

  it('rejects a non-string confidence-shaped field type mismatch', () => {
    const result = createPostBodySchema.safeParse({ ...validPost, content: 42 });
    assert.equal(result.success, false);
  });
});

describe('zod integration sanity', () => {
  it('produces issues with dotted paths for nested shapes', () => {
    const schema = z.object({ outer: z.object({ inner: z.string() }) });
    const result = schema.safeParse({ outer: { inner: 1 } });

    assert.equal(result.success, false);
    assert.equal(result.error.issues[0].path.join('.'), 'outer.inner');
  });
});
