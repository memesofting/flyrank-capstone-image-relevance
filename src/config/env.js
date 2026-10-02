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

  // --- Phase 2: AI pipeline -------------------------------------------------
  // Cross-field rules live in `parseEnv` below: selecting a provider requires
  // that provider's credentials, so a missing key fails with one clear message
  // instead of surfacing later as a 401 from the provider.
  VISION_PROVIDER: z.enum(['gemini', 'ollama']).optional(),
  EMBEDDING_PROVIDER: z.enum(['gemini', 'ollama']).optional(),

  GEMINI_API_KEY: z
    .string()
    // dotenv strips surrounding quotes; a pasted key often keeps stray
    // whitespace or an inline comment fragment, both of which produce an
    // opaque 401 from the provider rather than a local config error.
    .transform((value) => value.trim())
    .pipe(z.string().min(1, 'GEMINI_API_KEY must not be blank'))
    .optional(),

  OLLAMA_BASE_URL: z.string().url('OLLAMA_BASE_URL must be a URL').optional(),
  OLLAMA_VISION_MODEL: z.string().min(1).optional(),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1).optional(),

  // Model overrides exist because provider availability moves faster than this
  // project does: gemini-2.5-flash is listed by the API but returns 404 for new
  // accounts. See docs/adr/004-vision-model-availability.md.
  VISION_MODEL: z.string().min(1).optional(),
  VISION_MODEL_FALLBACK: z.string().min(1).optional(),
  EMBEDDING_MODEL: z.string().min(1).optional(),

  // 0 disables the Gemini thinking budget. This task is classification, not
  // reasoning: measured on gemini-3.5-flash, thinking added 220 tokens per
  // image for no accuracy benefit (docs/adr/004-vision-model-availability.md).
  GEMINI_THINKING_BUDGET: z.coerce.number().int().min(0).default(0),

  AI_DAILY_BUDGET_USD: z.coerce.number().nonnegative().optional(),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().optional(),
  MAX_IMAGE_BATCH_SIZE: z.coerce.number().int().positive().optional(),

  // Test runs use a deterministic in-memory provider so the suite needs no API
  // key and spends no quota (src/ai/providers/createProvider.js).
  AI_PROVIDER_MODE: z.enum(['live', 'stub']).optional(),
});

/**
 * Cross-field validation that a per-field schema cannot express.
 *
 * @param {z.infer<typeof envSchema>} data
 * @returns {{ path: string, message: string }[]}
 */
function collectEnvIssues(data) {
  const issues = [];

  if (data.VISION_PROVIDER === 'gemini' && !data.GEMINI_API_KEY) {
    issues.push({
      path: 'GEMINI_API_KEY',
      message: 'GEMINI_API_KEY is required when VISION_PROVIDER=gemini',
    });
  }

  if (data.EMBEDDING_PROVIDER === 'gemini' && !data.GEMINI_API_KEY) {
    issues.push({
      path: 'GEMINI_API_KEY',
      message: 'GEMINI_API_KEY is required when EMBEDDING_PROVIDER=gemini',
    });
  }

  if ((data.VISION_PROVIDER === 'ollama' || data.EMBEDDING_PROVIDER === 'ollama')
      && !data.OLLAMA_BASE_URL) {
    issues.push({
      path: 'OLLAMA_BASE_URL',
      message: 'OLLAMA_BASE_URL is required when a provider is set to ollama',
    });
  }

  return issues;
}

/**
 * Validate a candidate environment.
 *
 * @param {Record<string, string | undefined>} source
 * @returns {{ success: true, data: object } | { success: false, issues: { path: string, message: string }[] }}
 */
export function parseEnv(source = process.env) {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    return {
      success: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  const crossFieldIssues = collectEnvIssues(result.data);

  if (crossFieldIssues.length > 0) {
    return { success: false, issues: crossFieldIssues };
  }

  return { success: true, data: result.data };
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
