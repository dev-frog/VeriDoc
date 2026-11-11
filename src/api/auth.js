import { createHash, timingSafeEqual } from 'node:crypto';

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  // Hash both so lengths match and the comparison takes constant time.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Requires `Authorization: Bearer <VERIDOC_API_KEY>`.
 * If no key is configured: requests pass when `required` is false (local
 * dev), and fail with 500 when it's true (production must set a key).
 * @param {{ apiKey?: string, required?: boolean }} opts
 * @returns {import('hono').MiddlewareHandler}
 */
export function apiKeyAuth({ apiKey, required = false }) {
  return async (c, next) => {
    if (!apiKey) {
      if (required) {
        return c.json({ error: { code: 'server_misconfigured', message: 'VERIDOC_API_KEY is not set' } }, 500);
      }
      return next();
    }
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
    if (!m || !safeEqual(m[1].trim(), apiKey)) {
      return c.json({ error: { code: 'unauthorized', message: 'Missing or invalid API key' } }, 401, {
        'WWW-Authenticate': 'Bearer',
      });
    }
    return next();
  };
}
