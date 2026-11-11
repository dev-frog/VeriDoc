/**
 * One log line per request: method, path, status, duration, request id and
 * (for failures) the error code. Never logs headers or bodies, so API keys
 * and document contents stay out of the logs.
 *
 *  pretty: 14:02:11 POST /documents/66f…/process 200 812ms  req=3f2a…
 *  json:   {"level":"info","time":"…","requestId":"…","method":"POST",…}
 */

/** @typedef {'pretty' | 'json'} LogFormat */

/**
 * @typedef {object} RequestLogEntry
 * @property {'info' | 'warn' | 'error'} level
 * @property {string} time         ISO timestamp of when the request finished
 * @property {string} requestId
 * @property {string} method
 * @property {string} path         path + query string
 * @property {number} status
 * @property {number} durationMs
 * @property {string} [error]      error code, set by the app's onError
 */

const COLORS = { info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' };

/** @param {number} status @returns {RequestLogEntry['level']} */
export function levelForStatus(status) {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

/**
 * @param {RequestLogEntry} e
 * @param {{ format: LogFormat, color?: boolean }} opts
 * @returns {string}
 */
export function formatEntry(e, { format, color = false }) {
  if (format === 'json') return JSON.stringify(e);
  const c = color ? COLORS : { info: '', warn: '', error: '', dim: '', reset: '' };
  const time = e.time.slice(11, 19);
  const err = e.error ? ` ${e.error}` : '';
  return `${c.dim}${time}${c.reset} ${e.method} ${e.path} ${c[e.level]}${e.status}${c.reset} ${e.durationMs}ms${err}  ${c.dim}req=${e.requestId}${c.reset}`;
}

/**
 * Hono middleware. Register it after `requestId()` so the id is available.
 * @param {{ format?: LogFormat, write?: (line: string, level: RequestLogEntry['level']) => void,
 *   color?: boolean, now?: () => number }} [opts]
 * @returns {import('hono').MiddlewareHandler}
 */
export function requestLogger({
  format = 'pretty',
  write = (line, level) => (level === 'error' ? console.error(line) : console.log(line)),
  color = format === 'pretty' && Boolean(process.stdout?.isTTY),
  now = () => performance.now(),
} = {}) {
  return async (c, next) => {
    const start = now();
    await next(); // Hono runs onError inside next(), so c.res is the final response
    const url = new URL(c.req.url);
    /** @type {RequestLogEntry} */
    const entry = {
      level: levelForStatus(c.res.status),
      time: new Date().toISOString(),
      requestId: c.get('requestId') ?? '-',
      method: c.req.method,
      path: url.pathname + url.search,
      status: c.res.status,
      durationMs: Math.round(now() - start),
      ...(c.get('errorCode') && { error: c.get('errorCode') }),
    };
    write(formatEntry(entry, { format, color }), entry.level);
  };
}
