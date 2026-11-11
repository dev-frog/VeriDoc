import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import pkg from '../../package.json' with { type: 'json' };
import { CoreError, ErrorCodes } from '../core/index.js';
import { apiKeyAuth } from './auth.js';
import { documentRoutes } from './routes/documents.js';

/**
 * @typedef {object} AppDeps
 * @property {() => Promise<boolean>} pingDb  resolves true if MongoDB answered
 * @property {import('../core/ingest/service.js').IngestService} ingest
 * @property {{ apiKey?: string, required?: boolean }} [auth]
 * @property {string} [version]
 */

/** HTTP status for each core error code. */
const STATUS_BY_CODE = {
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.INVALID_INPUT]: 400,
  [ErrorCodes.UNSUPPORTED_TYPE]: 415,
  [ErrorCodes.PARSE_FAILED]: 422,
  [ErrorCodes.FETCH_FAILED]: 502,
  [ErrorCodes.PROVIDER_ERROR]: 502,
  [ErrorCodes.CONFIG_ERROR]: 500,
};

/**
 * Build the Hono app. Dependencies are injected so routes are testable
 * without MongoDB or network access.
 * @param {AppDeps} deps
 * @returns {Hono}
 */
export function createApp({ pingDb, ingest, auth = {}, version = pkg.version }) {
  const app = new Hono();

  app.get('/health', async (c) => {
    const dbOk = await pingDb();
    return c.json(
      { status: dbOk ? 'ok' : 'degraded', version, db: dbOk ? 'ok' : 'error' },
      dbOk ? 200 : 503,
    );
  });

  const requireKey = apiKeyAuth(auth);
  app.use('/documents', requireKey);
  app.use('/documents/*', requireKey);
  app.route('/documents', documentRoutes(ingest));

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` } }, 404),
  );

  app.onError((err, c) => {
    if (err instanceof CoreError) {
      const status = STATUS_BY_CODE[err.code] ?? 500;
      if (status >= 500) console.error(err);
      return c.json({ error: { code: err.code, message: err.message, ...(err.retryable && { retryable: true }) } }, status);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
    }
    console.error(err);
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
  });

  return app;
}
