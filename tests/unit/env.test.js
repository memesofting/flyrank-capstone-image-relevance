import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatEnvIssues, parseEnv } from '../../src/config/env.js';

const valid = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/image_matcher',
  LOG_LEVEL: 'info',
};

describe('env validation', () => {
  it('accepts a minimal valid configuration and applies defaults', () => {
    const result = parseEnv({ DATABASE_URL: valid.DATABASE_URL });

    assert.equal(result.success, true);
    assert.equal(result.data.PORT, 3000);
    assert.equal(result.data.NODE_ENV, 'development');
    assert.equal(result.data.LOG_LEVEL, 'info');
  });

  it('coerces PORT from a string to a number', () => {
    const result = parseEnv({ ...valid, PORT: '8080' });
    assert.equal(result.success, true);
    assert.equal(result.data.PORT, 8080);
  });

  it('rejects a missing DATABASE_URL', () => {
    const result = parseEnv({ ...valid, DATABASE_URL: '' });

    assert.equal(result.success, false);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].path, 'DATABASE_URL');
    assert.match(result.issues[0].message, /required/i);
  });

  it('rejects a DATABASE_URL that is not a postgresql connection string', () => {
    const result = parseEnv({ ...valid, DATABASE_URL: 'mysql://user:pass@host/db' });

    assert.equal(result.success, false);
    assert.match(result.issues[0].message, /postgresql/);
  });

  it('rejects a non-numeric PORT', () => {
    const result = parseEnv({ ...valid, PORT: 'abc' });
    assert.equal(result.success, false);
    assert.equal(result.issues[0].path, 'PORT');
  });

  it('rejects a PORT outside the valid range', () => {
    assert.equal(parseEnv({ ...valid, PORT: '70000' }).success, false);
    assert.equal(parseEnv({ ...valid, PORT: '0' }).success, false);
  });

  it('rejects an unknown NODE_ENV', () => {
    const result = parseEnv({ ...valid, NODE_ENV: 'staging' });
    assert.equal(result.success, false);
    assert.equal(result.issues[0].path, 'NODE_ENV');
  });

  it('rejects an unknown LOG_LEVEL', () => {
    const result = parseEnv({ ...valid, LOG_LEVEL: 'trace' });
    assert.equal(result.success, false);
    assert.equal(result.issues[0].path, 'LOG_LEVEL');
  });

  it('treats deferred AI settings as optional', () => {
    const result = parseEnv(valid);
    assert.equal(result.success, true);
    assert.equal(result.data.VISION_PROVIDER, undefined);
    assert.equal(result.data.GEMINI_API_KEY, undefined);
  });

  it('validates deferred AI settings when they are present', () => {
    const result = parseEnv({ ...valid, VISION_PROVIDER: 'not-a-provider' });
    assert.equal(result.success, false);
    assert.equal(result.issues[0].path, 'VISION_PROVIDER');
  });

  it('rejects a negative budget', () => {
    const result = parseEnv({ ...valid, AI_DAILY_BUDGET_USD: '-5' });
    assert.equal(result.success, false);
    assert.equal(result.issues[0].path, 'AI_DAILY_BUDGET_USD');
  });

  it('never includes the offending value in the formatted output', () => {
    const secret = 'postgresql://user:sup3rs3cret@host/db';
    const result = parseEnv({ ...valid, DATABASE_URL: secret, PORT: 'abc' });

    assert.equal(result.success, false);
    const output = formatEnvIssues(result.issues);
    assert.ok(!output.includes('sup3rs3cret'), 'formatted issues must not leak the value');
  });

  it('points the developer at .env.example', () => {
    const result = parseEnv({});
    const output = formatEnvIssues(result.issues);
    assert.match(output, /\.env\.example/);
  });
});
