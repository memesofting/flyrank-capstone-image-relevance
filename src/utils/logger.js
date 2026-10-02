/**
 * Minimal level-filtered logger.
 *
 * Deliberately not a logging framework: the capstone needs structured lines
 * that are easy to read and impossible to leak secrets into. Any key whose
 * name looks credential-ish is replaced with '[redacted]'.
 */

import { env } from '../config/env.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_PATTERN = /(key|token|secret|password|passwd|credential|authorization)/i;

export const REDACTED = '[redacted]';

function redact(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (typeof value === 'object' && depth < 4) {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(item, depth + 1);
    }
    return output;
  }

  return value;
}

function serializeError(error) {
  if (!error) {
    return undefined;
  }
  return {
    name: error.name,
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
  };
}

function emit(level, message, context = {}) {
  if (LEVELS[level] < LEVELS[env.LOG_LEVEL]) {
    return;
  }

  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...(context.error ? { error: serializeError(context.error) } : {}),
  };

  const { error: _omitted, ...rest } = context;
  if (Object.keys(rest).length > 0) {
    entry.context = redact(rest);
  }

  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message, context) => emit('debug', message, context),
  info: (message, context) => emit('info', message, context),
  warn: (message, context) => emit('warn', message, context),
  error: (message, context) => emit('error', message, context),
};
