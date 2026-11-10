import { describe, it, expect } from 'vitest';
import { createApp } from '../src/api/app.js';

describe('GET /health', () => {
  it('returns 200 and db ok when ping succeeds', async () => {
    const app = createApp({ pingDb: async () => true, version: '9.9.9' });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: '9.9.9', db: 'ok' });
  });

  it('returns 503 and db error when ping fails', async () => {
    const app = createApp({ pingDb: async () => false, version: '9.9.9' });
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'degraded', version: '9.9.9', db: 'error' });
  });

  it('uses the package.json version by default', async () => {
    const app = createApp({ pingDb: async () => true });
    const body = await (await app.request('/health')).json();
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const app = createApp({ pingDb: async () => true });
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });
});
