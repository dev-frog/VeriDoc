import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { requestLogger } from './logger.js';
import pkg from '../../package.json' with { type: 'json' };
import { CoreError, ErrorCodes } from '../core/index.js';
import { apiKeyAuth } from './auth.js';
import { documentRoutes } from './routes/documents.js';
import { queryRoutes } from './routes/query.js';
import { uploadRoutes } from './routes/uploads.js';

/**
 * @typedef {object} AppDeps
 * @property {() => Promise<boolean>} pingDb  resolves true if MongoDB answered
 * @property {import('../core/ingest/service.js').IngestService} ingest
 * @property {import('../core/search/service.js').SearchService} [search]   enables POST /search
 * @property {import('../core/answer/service.js').AnswerService} [answer]   enables POST /ask
 * @property {Parameters<typeof uploadRoutes>[0]} [uploads]                 enables POST /uploads
 * @property {{ apiKey?: string, required?: boolean }} [auth]
 * @property {Parameters<typeof requestLogger>[0] | false} [log]  request logging; false/omitted = off
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
export function createApp({ pingDb, ingest, search, answer, uploads, auth = {}, log = false, version = pkg.version }) {
  const app = new Hono();

  // Reuse a valid incoming X-Request-Id, else Vercel's id, else a UUID.
  // The id is echoed back in the X-Request-Id response header.
  app.use(requestId({ generator: (c) => c.req.header('x-vercel-id') ?? crypto.randomUUID() }));
  if (log) app.use(requestLogger(log));

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

  if (search && answer) {
    app.use('/search', requireKey);
    app.use('/ask', requireKey);
    app.route('/', queryRoutes({ search, answer }));
  }

  if (uploads) {
    app.use('/uploads', requireKey);
    app.route('/uploads', uploadRoutes(uploads));
  }

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` } }, 404),
  );

  app.onError((err, c) => {
    const rid = c.get('requestId');
    if (err instanceof CoreError) {
      const status = STATUS_BY_CODE[err.code] ?? 500;
      c.set('errorCode', err.code);
      if (status >= 500) console.error(`[req=${rid}] ${err.code}: ${err.message}`, err.cause ?? '');
      return c.json({ error: { code: err.code, message: err.message, ...(err.retryable && { retryable: true }) } }, status);
    }
    if (err instanceof HTTPException) {
      c.set('errorCode', 'http_error');
      return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
    }
    c.set('errorCode', 'internal_error');
    console.error(`[req=${rid}] unhandled error`, err);
    return c.json({ error: { code: 'internal_error', message: 'Internal server error', requestId: rid } }, 500);
  });

  return app;
}
