import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/api/app.js';
import { createIngestService } from '../src/core/ingest/service.js';
import { createSearchService } from '../src/core/search/service.js';
import { createAnswerService } from '../src/core/answer/service.js';
import { createNoopReranker } from '../src/core/rerank/index.js';
import { CoreError } from '../src/core/errors.js';
import { createMemoryRepo } from './helpers/memory-repo.js';

const KEY = 'test-key';
const auth = { authorization: `Bearer ${KEY}` };
const embedder = { dimensions: 2, embed: async (t) => t.map((s) => [s.includes('refund') ? 1 : 0, 1]) };

async function makeApp({ llmReply = 'Refunds are possible within 30 days [Source 1].', handleUpload, blobToken = 'blob_rw' } = {}) {
  const repo = createMemoryRepo();
  const ingest = createIngestService({
    repo,
    embedder,
    fetchFile: async () => new TextEncoder().encode('# Refunds\nRefunds are possible within 30 days of purchase.'),
  });
  const { id } = await ingest.createDocument({ url: 'https://x/policy.md', fileName: 'policy.md' });
  await ingest.processNext(id);
  const search = createSearchService({ repo, embedder, reranker: createNoopReranker() });
  const llm = { model: 'm', chat: vi.fn(async () => ({ text: llmReply, usage: null })) };
  const answer = createAnswerService({ search, llm });
  const app = createApp({
    pingDb: async () => true,
    ingest,
    search,
    answer,
    uploads: { token: blobToken, maxBytes: 1000, handleUpload },
    auth: { apiKey: KEY },
  });
  return { app, id, llm };
}

const post = (app, path, body, headers = auth) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('POST /search', () => {
  it('requires the API key', async () => {
    const { app } = await makeApp();
    expect((await post(app, '/search', { query: 'refund' }, {})).status).toBe(401);
    expect((await post(app, '/ask', { question: 'refund?' }, {})).status).toBe(401);
  });

  it('returns ranked results with their source location', async () => {
    const { app, id } = await makeApp();
    const res = await post(app, '/search', { query: 'refund window', topN: 3 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ query: 'refund window', reranker: 'none' });
    expect(body.results[0]).toMatchObject({ rank: 1, documentId: id, fileName: 'policy.md', heading: 'Refunds' });
  });

  it('validates the body', async () => {
    const { app } = await makeApp();
    for (const bad of [{}, { query: '' }, { query: 'x', topN: 0 }, { query: 'x', documentIds: ['nope'] }, { query: 'x'.repeat(2001) }]) {
      const res = await post(app, '/search', bad);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_request');
    }
  });
});

describe('POST /ask', () => {
  it('answers with citations and verification', async () => {
    const { app, llm } = await makeApp();
    const res = await post(app, '/ask', { question: 'How long is the refund window?' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer).toBe('Refunds are possible within 30 days [Source 1].');
    expect(body.verification.status).toBe('verified');
    expect(body.citations[0]).toMatchObject({ n: 1, fileName: 'policy.md', label: 'policy.md · Refunds' });
    expect(body.sources).toHaveLength(1);
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('maps LLM provider failures to 502 retryable', async () => {
    const { app, llm } = await makeApp();
    llm.chat.mockRejectedValueOnce(new CoreError('provider_error', 'LLM returned HTTP 503: busy', { retryable: true }));
    const res = await post(app, '/ask', { question: 'refund?' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'provider_error', message: 'LLM returned HTTP 503: busy', retryable: true } });
  });
});

describe('POST /uploads', () => {
  const tokenRequest = (pathname) => ({ type: 'blob.generate-client-token', payload: { pathname, callbackUrl: '', clientPayload: null, multipart: false } });

  it('requires the API key and a blob token', async () => {
    const { app } = await makeApp({ handleUpload: vi.fn() });
    expect((await post(app, '/uploads', tokenRequest('a.pdf'), {})).status).toBe(401);
    const noToken = await makeApp({ blobToken: null, handleUpload: vi.fn() });
    const res = await post(noToken.app, '/uploads', tokenRequest('a.pdf'));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('config_error');
  });

  it('issues a client token only for supported files, with size limit and random suffix', async () => {
    const handleUpload = vi.fn(async ({ body, onBeforeGenerateToken }) => {
      const opts = await onBeforeGenerateToken(body.payload.pathname, null, false);
      return { type: 'blob.generate-client-token', clientToken: `tok:${JSON.stringify(opts)}` };
    });
    const { app } = await makeApp({ handleUpload });
    const ok = await post(app, '/uploads', tokenRequest('guide.pdf'));
    expect(ok.status).toBe(200);
    const { clientToken } = await ok.json();
    const opts = JSON.parse(clientToken.slice(4));
    expect(opts).toMatchObject({ maximumSizeInBytes: 1000, addRandomSuffix: true });
    expect(opts.allowedContentTypes).toContain('application/pdf');
    expect(handleUpload.mock.calls[0][0].token).toBe('blob_rw');

    const bad = await post(app, '/uploads', tokenRequest('photo.png'));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toMatch(/Unsupported file type/);
  });

  it('rejects anything that is not a token request', async () => {
    const { app } = await makeApp({ handleUpload: vi.fn() });
    expect((await post(app, '/uploads', { type: 'blob.upload-completed', payload: {} })).status).toBe(400);
  });
});
