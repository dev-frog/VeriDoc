import { CoreError, ErrorCodes } from '../errors.js';

/**
 * Is this URL allowed as a document source? Only https, and the host must
 * match one of the patterns: "*" (any host), "*.example.com" (subdomains of
 * example.com) or an exact host name. This stops the server from being used
 * to fetch arbitrary internal URLs.
 * @param {string} url
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function isAllowedSourceUrl(url, patterns) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase();
    if (pat === '*') return true;
    if (pat.startsWith('*.')) return host.endsWith(pat.slice(1)) && host.length > pat.length - 1;
    return host === pat;
  });
}

/**
 * @typedef {(url: string) => Promise<Uint8Array>} FetchFile
 */

/**
 * Downloads a file with a size limit and timeout. Redirects are refused
 * (they could point outside the host allowlist).
 * Errors: CoreError FETCH_FAILED; retryable for network errors, 408, 429
 * and 5xx, permanent otherwise.
 * @param {{ fetch?: typeof globalThis.fetch, maxBytes?: number, timeoutMs?: number }} [opts]
 * @returns {FetchFile}
 */
export function createFileFetcher({ fetch = globalThis.fetch, maxBytes = 50 * 1024 * 1024, timeoutMs = 60_000 } = {}) {
  const tooLarge = () =>
    new CoreError(ErrorCodes.FETCH_FAILED, `File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);

  return async function fetchFile(url) {
    let res;
    try {
      res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new CoreError(ErrorCodes.FETCH_FAILED, `Could not download file: ${err.message}`, {
        retryable: true,
        cause: err,
      });
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new CoreError(ErrorCodes.FETCH_FAILED, `Source URL redirected (HTTP ${res.status}); redirects are not allowed`);
    }
    if (!res.ok) {
      await res.body?.cancel();
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw new CoreError(ErrorCodes.FETCH_FAILED, `Could not download file: HTTP ${res.status}`, { retryable });
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) {
      await res.body?.cancel();
      throw tooLarge();
    }
    if (!res.body) return new Uint8Array(0);

    /** @type {Uint8Array[]} */
    const parts = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      parts.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.byteLength;
    }
    return out;
  };
}
