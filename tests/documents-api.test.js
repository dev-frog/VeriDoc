import { describe, it, expect } from 'vitest';
import { createApp } from '../src/api/app.js';
import { createIngestService } from '../src/core/ingest/service.js';
import { isAllowedSourceUrl } from '../src/core/ingest/fetch-file.js';
import { CoreError } from '../src/core/errors.js';
import { createMemoryRepo } from './helpers/memory-repo.js';

const KEY = 'test-key';
const auth = { authorization: `Bearer ${KEY}` };
const BLOB = 'https://abc.public.blob.vercel-storage.com/guide.md';

function makeApp({ embed, authOpts = { apiKey: KEY } } = {}) {
  const repo = createMemoryRepo();
  const ingest = createIngestService({
    repo,
    embedder: { dimensions: 1, embed: embed ?? (async (t) => t.map(() => [1])) },
    fetchFile: async () => new TextEncoder().encode('# Title\nHello there. General Kenobi.'),
    batchSize: 1,
    isSourceUrlAllowed: (u) => isAllowedSourceUrl(u, ['*.public.blob.vercel-storage.com']),
  });
  const app = createApp({ pingDb: async () => true, ingest, auth: authOpts });
  return { app, repo };
}

const post = (app, path, body, headers = auth) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('auth', () => {
  it('requires the API key on /documents routes, but not /health', async () => {
    const { app } = makeApp();
    expect((await app.request('/health')).status).toBe(200);
    for (const path of ['/documents', '/documents/abc']) {
      const res = await app.request(path);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'Missing or invalid API key' } });
    }
    expect((await app.request('/documents', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await app.request('/documents', { headers: auth })).status).toBe(200);
  });

  it('allows requests without a key only when not required', async () => {
    expect((await makeApp({ authOpts: {} }).app.request('/documents')).status).toBe(200);
    const res = await makeApp({ authOpts: { required: true } }).app.request('/documents');
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_misconfigured');
  });
});

describe('POST /documents', () => {
  it('creates a pending document and returns 202', async () => {
    const { app } = makeApp();
    const res = await post(app, '/documents', { url: BLOB, fileName: 'guide.md' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ id: expect.any(String), status: 'pending' });
    expect(res.headers.get('location')).toBe(`/documents/${body.id}`);
  });

  it('validates the body', async () => {
    const { app } = makeApp();
    for (const body of [{}, { url: 'not-a-url', fileName: 'a.md' }, { url: 'http://x.com/a', fileName: 'a.md' }, { url: BLOB, fileName: '' }]) {
      const res = await post(app, '/documents', body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_request');
    }
  });

  it('returns 415 for unsupported types and 400 for disallowed hosts', async () => {
    const { app } = makeApp();
    expect((await post(app, '/documents', { url: BLOB, fileName: 'a.exe' })).status).toBe(415);
    const res = await post(app, '/documents', { url: 'https://evil.com/a.md', fileName: 'a.md' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_input');
  });

  it('returns 400 for malformed JSON', async () => {
    const { app } = makeApp();
    const res = await app.request('/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeDefined();
  });
});

describe('process / get / list / delete', () => {
  it('runs the full lifecycle', async () => {
    const { app, repo } = makeApp();
    const { id } = await (await post(app, '/documents', { url: BLOB, fileName: 'guide.md' })).json();

    let r;
    let calls = 0;
    do {
      r = await (await post(app, `/documents/${id}/process`, {})).json();
      calls++;
    } while (r.status !== 'ready' && calls < 10);
    expect(r).toEqual({ status: 'ready', processed: 1, total: 1 });

    const doc = await (await app.request(`/documents/${id}`, { headers: auth })).json();
    expect(doc).toMatchObject({ id, fileName: 'guide.md', status: 'ready', chunkCount: 1, processedCount: 1 });
    expect(doc).not.toHaveProperty('parsedAt');

    const list = await (await app.request('/documents?limit=10&status=ready', { headers: auth })).json();
    expect(list.items.map((d) => d.id)).toEqual([id]);
    expect(list.nextCursor).toBeNull();

    const del = await app.request(`/documents/${id}`, { method: 'DELETE', headers: auth });
    expect(await del.json()).toEqual({ id, deleted: true });
    expect(repo.chunks.size).toBe(0);
    expect((await app.request(`/documents/${id}`, { headers: auth })).status).toBe(404);
  });

  it('validates list query params', async () => {
    const { app } = makeApp();
    expect((await app.request('/documents?limit=1000', { headers: auth })).status).toBe(400);
    expect((await app.request('/documents?status=bogus', { headers: auth })).status).toBe(400);
  });

  it('returns 404 for unknown documents', async () => {
    const { app } = makeApp();
    const res = await post(app, '/documents/doesnotexist/process', {});
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('maps provider errors to 502 with retryable flag', async () => {
    const { app } = makeApp({
      embed: async () => {
        throw new CoreError('provider_error', 'OpenAI embeddings returned HTTP 503', { retryable: true });
      },
    });
    const { id } = await (await post(app, '/documents', { url: BLOB, fileName: 'guide.md' })).json();
    const res = await post(app, `/documents/${id}/process`, {});
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'provider_error', message: 'OpenAI embeddings returned HTTP 503', retryable: true },
    });
  });
});
