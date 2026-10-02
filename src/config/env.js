/**
 * Environment loading and validation.
 *
 * Rules enforced here:
 *  - `.env` is the only place secrets come from; nothing is hard-coded.
 *  - Configuration required in Phase 1 is validated at startup and the process
 *    refuses to boot with an unreadable, actionable message.
 *  - Configuration for later phases is declared as optional so the shape is
 *    documented without being required before it is used.
 *
 * Importing this module validates `process.env` as a side effect. Use
 * `parseEnv` with an explicit source object to validate a candidate config in
 * tests.
 */

import dotenv from 'dotenv';
import { z } from 'zod';

// `quiet` suppresses dotenv's startup banner so application logs stay clean.
dotenv.config({ quiet: true });

export const envSchema = z.object({
  // --- Required now -------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce
    .number()
    .int('PORT must be an integer')
    .min(1)
    .max(65535)
    .default(3000),
  DATABASE_URL: z
    .string()
    .trim()
    .min(1, 'DATABASE_URL is required')
    // Skips empty strings so a missing value reports one clear problem rather
    // than "required" plus "must be a postgresql:// string".
    .refine(
      (value) => value.length === 0 || /^postgres(ql)?:\/\//.test(value),
      'DATABASE_URL must be a postgresql:// connection string',
    ),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // --- Deferred: Phase 2/3 (declared, not used in Phase 1) -----------------
  VISION_PROVIDER: z.enum(['gemini', 'ollama']).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  OLLAMA_BASE_URL: z.string().min(1).optional(),
  EMBEDDING_PROVIDER: z.enum(['gemini', 'ollama']).optional(),
  AI_DAILY_BUDGET_USD: z.coerce.number().nonnegative().optional(),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().optional(),
  MAX_IMAGE_BATCH_SIZE: z.coerce.number().int().positive().optional(),
});

/**
 * Validate a candidate environment.
 *
 * @param {Record<string, string | undefined>} source
 * @returns {{ success: true, data: object } | { success: false, issues: { path: string, message: string }[] }}
 */
export function parseEnv(source = process.env) {
  const result = envSchema.safeParse(source);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/**
 * Format a validation failure for the console.
 *
 * Issue messages only — never the offending value, because it may be a
 * password inside DATABASE_URL or an API key.
 */
export function formatEnvIssues(issues) {
  const lines = issues.map((issue) => `  - ${issue.path || '(root)'}: ${issue.message}`);
  return [
    'Invalid environment configuration.',
    '',
    ...lines,
    '',
    'Copy .env.example to .env and fill in the required values.',
  ].join('\n');
}

function loadEnv() {
  const parsed = parseEnv(process.env);

  if (!parsed.success) {
    console.error(formatEnvIssues(parsed.issues));
    process.exit(1);
  }

  return Object.freeze({
    ...parsed.data,
    isProduction: parsed.data.NODE_ENV === 'production',
    isTest: parsed.data.NODE_ENV === 'test',
  });
}

export const env = loadEnv();
