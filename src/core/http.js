import { CoreError, ErrorCodes } from './errors.js';

/**
 * @typedef {object} RetryOptions
 * @property {typeof globalThis.fetch} [fetch]
 * @property {number} [retries=5]       retries after the first attempt
 * @property {number} [baseDelayMs=500]
 * @property {number} [maxDelayMs=20000]
 * @property {number} [timeoutMs=60000] per attempt
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [random]
 * @property {number} [giveUpAfterMs=300000]  don't retry a 429 whose reset is further away than this
 *   (e.g. a daily free-tier quota): waiting won't help and every retry may count against the quota
 */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Parse a Retry-After header (seconds or HTTP date) into milliseconds.
 * @param {string | null} value
 * @param {number} [nowMs]
 * @returns {number | null}
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/**
 * When a rate limit resets, from X-RateLimit-Reset (epoch seconds or ms, as
 * sent by OpenRouter and others). Returns ms from now, or null.
 * @param {string | null} value
 * @param {number} [nowMs]
 * @returns {number | null}
 */
export function parseRateLimitReset(value, nowMs = Date.now()) {
  const n = Number(value);
  if (!value || !Number.isFinite(n) || n <= 0) return null;
  const atMs = n < 1e12 ? n * 1000 : n;
  return Math.max(0, atMs - nowMs);
}

/**
 * fetch with retry + exponential backoff (with jitter) on network errors,
 * 429 and 5xx. Honors Retry-After (capped at maxDelayMs). Returns the last
 * response, which may still be an error response.
 * @param {string} url
 * @param {RequestInit} init
 * @param {RetryOptions} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(
  url,
  init,
  {
    fetch = globalThis.fetch,
    retries = 5,
    baseDelayMs = 500,
    maxDelayMs = 20_000,
    timeoutMs = 60_000,
    sleep = defaultSleep,
    random = Math.random,
    giveUpAfterMs = 300_000,
  } = {},
) {
  for (let attempt = 0; ; attempt++) {
    /** @type {Response | undefined} */
    let res;
    /** @type {unknown} */
    let error;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      error = err;
    }
    const retryable = error !== undefined || res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      if (error !== undefined) throw error;
      return /** @type {Response} */ (res);
    }
    const hinted = res ? parseRetryAfter(res.headers.get('retry-after')) : null;
    const resetIn = res?.status === 429 ? parseRateLimitReset(res.headers.get('x-ratelimit-reset')) : null;
    if (Math.max(hinted ?? 0, resetIn ?? 0) > giveUpAfterMs) return /** @type {Response} */ (res);
    // Free the connection; don't await (a teed body may never settle).
    res?.body?.cancel().catch(() => {});
    const backoff = baseDelayMs * 2 ** attempt * (0.5 + random() / 2);
    await sleep(Math.min(maxDelayMs, hinted ?? backoff));
  }
}

/**
 * POST JSON and return the parsed response, or throw CoreError PROVIDER_ERROR.
 * Error messages include the provider's status and message, never the request headers.
 * @param {string} provider  name used in error messages
 * @param {string} url
 * @param {unknown} body
 * @param {Record<string, string>} headers
 * @param {RetryOptions} [opts]
 * @returns {Promise<any>}
 */
export async function postJson(provider, url, body, headers, opts) {
  let res;
  try {
    res = await fetchWithRetry(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
      opts,
    );
  } catch (err) {
    throw new CoreError(ErrorCodes.PROVIDER_ERROR, `${provider} request failed: ${err.message}`, {
      retryable: true,
      cause: err,
    });
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.detail ?? j?.message ?? detail;
    } catch {}
    const resetIn = res.status === 429 ? parseRateLimitReset(res.headers.get('x-ratelimit-reset')) : null;
    const resetNote = resetIn && resetIn > 60_000 ? ` (rate limit resets at ${new Date(Date.now() + resetIn).toISOString()})` : '';
    throw new CoreError(ErrorCodes.PROVIDER_ERROR, `${provider} returned HTTP ${res.status}: ${detail}${resetNote}`, {
      retryable: res.status === 429 || res.status >= 500,
      details: { status: res.status },
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CoreError(ErrorCodes.PROVIDER_ERROR, `${provider} returned invalid JSON`);
  }
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
export function toBatches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
