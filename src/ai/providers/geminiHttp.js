/**
 * Gemini HTTP transport: endpoints, headers, timeouts, error classification.
 *
 * This module exists because two hand-written requests to the Gemini API failed
 * during Phase 2 planning, each for a different shape reason:
 *
 *   - `embedContent` takes singular `content`, not `contents`.
 *   - `generateContent` accepts `inline_data`/`mime_type` (snake_case) but the
 *     model list will happily accept an unknown field elsewhere.
 *
 * Both failures surfaced as an opaque 400 or 404 rather than a local error, so
 * every wire detail is centralised here instead of being re-derived at each
 * call site. `fetchImpl` is injectable so tests never touch the network.
 */

import { AI_REQUEST_TIMEOUT_MS, GEMINI_API_BASE } from '../../config/constants.js';

/**
 * HTTP statuses worth retrying.
 *
 * 429 is rate limiting, 5xx is the provider struggling. A 503 "high demand" was
 * observed from gemini-3.8-flash in practice, so this path is exercised by
 * reality, not only by injected failures.
 */
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Statuses that will never succeed on retry.
 *
 * Retrying these is worse than failing fast: a revoked API key would burn three
 * attempts on all 61 images — 183 doomed requests — before the operator saw a
 * single useful error.
 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 413, 422]);

/**
 * An error from a provider call, carrying enough structure for the job runner
 * to decide whether to retry and for the cost tracker to persist a real reason.
 */
export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   * @param {string} [details.provider]
   * @param {string} [details.model]
   * @param {number} [details.status] HTTP status, 0 for a transport failure
   * @param {boolean} [details.transient]
   * @param {unknown} [details.body] parsed provider error payload
   */
  constructor(message, { provider, model, status = 0, transient = false, body } = {}) {
    super(message, { cause: body });
    this.name = 'ProviderError';
    this.provider = provider;
    this.model = model;
    this.status = status;
    this.transient = transient;
    this.body = body;
  }
}

/**
 * Classify an HTTP status into retry / do-not-retry.
 *
 * @param {number} status
 * @returns {boolean} true when the request is worth repeating
 */
export function isTransientStatus(status) {
  if (TRANSIENT_STATUSES.has(status)) {
    return true;
  }

  if (PERMANENT_STATUSES.has(status)) {
    return false;
  }

  // Unlisted: a server-side fault (>= 500) is worth one more try, while an
  // unlisted 4xx is a client-side mistake that repeating cannot fix.
  return status >= 500;
}

/**
 * Perform one Gemini REST call.
 *
 * The API key is read from the closure, never logged, and never included in an
 * error message or a ProviderError body: `redactSecrets` strips it from any
 * provider text that does get persisted.
 *
 * @param {object} options
 * @param {string} options.model bare model id, e.g. 'gemini-3.5-flash'
 * @param {string} options.method e.g. 'generateContent'
 * @param {unknown} options.body request payload
 * @param {string} options.apiKey
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ data: unknown, usage: Record<string, unknown> | null }>}
 */
export async function callGemini({
  model,
  method,
  body,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = AI_REQUEST_TIMEOUT_MS,
  signal: externalSignal,
}) {
  const url = `${GEMINI_API_BASE}/models/${model}:${method}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  let response;

  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Header form rather than `?key=`: it keeps the credential out of URLs,
        // which are far more likely to be logged or cached than headers.
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    // A timeout, DNS failure or dropped socket: transport-level, therefore
    // worth retrying even though no status was ever received.
    throw new ProviderError(
      controller.signal.aborted
        ? `Gemini request to ${model}:${method} timed out after ${timeoutMs}ms`
        : `Gemini request to ${model}:${method} failed: ${error.message}`,
      { provider: 'gemini', model, status: 0, transient: true },
    );
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }

  const text = await response.text();

  let payload = null;
  try {
    payload = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    payload = { rawBody: text.slice(0, 500) };
  }

  if (!response.ok) {
    const message = payload?.error?.message
      ?? `HTTP ${response.status} from ${model}:${method}`;

    throw new ProviderError(message, {
      provider: 'gemini',
      model,
      status: response.status,
      transient: isTransientStatus(response.status),
      body: payload?.error ?? payload,
    });
  }

  if (payload === null) {
    throw new ProviderError(`Gemini returned an empty body from ${model}:${method}`, {
      provider: 'gemini',
      model,
      status: response.status,
      transient: true,
    });
  }

  // A 200 can still carry an error block, and a candidate list can come back
  // empty when the request was blocked. Both would otherwise surface as an
  // unhelpful "cannot read properties of undefined" further downstream.
  const blockReason = payload?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new ProviderError(`Gemini blocked the request: ${blockReason}`, {
      provider: 'gemini',
      model,
      status: response.status,
      transient: false,
      body: payload.promptFeedback,
    });
  }

  if (!Array.isArray(payload?.candidates) || payload.candidates.length === 0) {
    throw new ProviderError(`Gemini returned no candidates from ${model}:${method}`, {
      provider: 'gemini',
      model,
      status: response.status,
      transient: true,
      body: payload,
    });
  }

  return { data: payload, usage: payload.usageMetadata ?? null };
}

/**
 * Pull the model's text out of a generateContent response.
 *
 * Returns the concatenated text parts rather than assuming parts[0], because a
 * response may legitimately split text across parts.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function extractCandidateText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return '';
  }

  return parts
    .filter((part) => typeof part?.text === 'string')
    .map((part) => part.text)
    .join('');
}

/**
 * Parse model text as JSON, tolerating only a markdown code fence.
 *
 * This is the narrowest possible accommodation. It does not repair truncated
 * output, does not add trailing commas, does not coerce types, and does not
 * wrap bare text in braces. A fenced JSON body is a presentation artefact;
 * anything else is malformed output that requirement 1 says must be recorded
 * as invalid rather than quietly turned into a valid object.
 *
 * @param {string} text
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: string }}
 */
export function parseJsonText(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';

  if (trimmed.length === 0) {
    return { ok: false, reason: 'model returned empty text' };
  }

  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (error) {
    return { ok: false, reason: `model output was not valid JSON: ${error.message}` };
  }
}

/**
 * Remove anything that looks like a credential from provider-supplied text.
 *
 * Provider error messages echo back the request in some cases, and a provider
 * error body is persisted to ai_calls.error and to job.last_error. Anything
 * matching a real key shape is replaced rather than stored.
 */
const KEY_SHAPES = [
  /AIza[0-9A-Za-z_-]{10,}/g,
  /AQ\.A[0-9A-Za-z._-]{10,}/g,
  /ya29\.[0-9A-Za-z._-]{10,}/g,
  /sk-[0-9A-Za-z]{16,}/g,
];

export function redactSecrets(text) {
  let output = String(text);

  for (const pattern of KEY_SHAPES) {
    output = output.replace(pattern, '[redacted]');
  }

  return output;
}