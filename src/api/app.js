import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import pkg from '../../package.json' with { type: 'json' };

/**
 * @typedef {object} AppDeps
 * @property {() => Promise<boolean>} pingDb  resolves true if MongoDB answered
 * @property {string} [version]
 */

/**
 * Build the Hono app. Dependencies are injected so routes are testable
 * without MongoDB.
 * @param {AppDeps} deps
 * @returns {Hono}
 */
export function createApp({ pingDb, version = pkg.version }) {
  const app = new Hono();

  app.get('/health', async (c) => {
    const dbOk = await pingDb();
    return c.json(
      { status: dbOk ? 'ok' : 'degraded', version, db: dbOk ? 'ok' : 'error' },
      dbOk ? 200 : 503,
    );
  });

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` } }, 404),
  );

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
    }
    console.error(err);
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
  });

  return app;
}
