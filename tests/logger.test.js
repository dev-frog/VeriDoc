import { describe, it, expect } from 'vitest';
import { createApp } from '../src/api/app.js';
import { formatEntry, levelForStatus } from '../src/api/logger.js';
import { loadConfig } from '../src/config.js';
import { CoreError } from '../src/core/errors.js';

function appWithLogs(format, ingest = {}) {
  const lines = [];
  const app = createApp({
    pingDb: async () => true,
    ingest,
    auth: { apiKey: 'secret-key' },
    log: { format, write: (line, level) => lines.push({ line, level }) },
  });
  return { app, lines };
}

describe('request logging', () => {
  it('logs one JSON line per request with request id, status and duration', async () => {
    const { app, lines } = appWithLogs('json');
    const res = await app.request('/health?x=1');
    expect(lines).toHaveLength(1);
    const e = JSON.parse(lines[0].line);
    expect(e).toMatchObject({ level: 'info', method: 'GET', path: '/health?x=1', status: 200 });
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
    expect(e.requestId).toBe(res.headers.get('x-request-id'));
  });

  it('reuses an incoming X-Request-Id, else Vercel id', async () => {
    const { app, lines } = appWithLogs('json');
    await app.request('/health', { headers: { 'x-request-id': 'abc-123' } });
    await app.request('/health', { headers: { 'x-vercel-id': 'fra1::xyz' } });
    expect(lines.map((l) => JSON.parse(l.line).requestId)).toEqual(['abc-123', 'fra1::xyz']);
  });

  it('logs failures with warn/error level and the error code', async () => {
    const ingest = {
      processNext: async () => {
        throw new CoreError('provider_error', 'boom', { retryable: true });
      },
    };
    const { app, lines } = appWithLogs('json', ingest);
    await app.request('/documents'); // 401
    await app.request('/documents/x/process', { method: 'POST', headers: { authorization: 'Bearer secret-key' } }); // 502
    const [unauth, failed] = lines.map((l) => JSON.parse(l.line));
    expect(unauth).toMatchObject({ level: 'warn', status: 401 });
    expect(failed).toMatchObject({ level: 'error', status: 502, error: 'provider_error' });
    expect(lines[1].level).toBe('error');
  });

  it('never logs the Authorization header or API key', async () => {
    const { app, lines } = appWithLogs('json');
    await app.request('/documents', { headers: { authorization: 'Bearer secret-key' } }).catch(() => {});
    expect(lines.map((l) => l.line).join('\n')).not.toContain('secret-key');
  });

  it('is off unless enabled', async () => {
    const app = createApp({ pingDb: async () => true, ingest: {} });
    const res = await app.request('/health');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('pretty format is a readable single line', () => {
    const line = formatEntry(
      { level: 'info', time: '2026-11-11T14:02:11.000Z', requestId: 'r1', method: 'GET', path: '/health', status: 200, durationMs: 4 },
      { format: 'pretty' },
    );
    expect(line).toBe('14:02:11 GET /health 200 4ms  req=r1');
  });

  it('levelForStatus', () => {
    expect([200, 302, 404, 500].map(levelForStatus)).toEqual(['info', 'info', 'warn', 'error']);
  });

  it('LOG_FORMAT defaults to json in production, pretty otherwise', () => {
    const base = { MONGODB_URI: 'mongodb://x' };
    expect(loadConfig(base).LOG_FORMAT).toBe('pretty');
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).LOG_FORMAT).toBe('json');
    expect(loadConfig({ ...base, LOG_FORMAT: 'off' }).LOG_FORMAT).toBe('off');
  });
});
