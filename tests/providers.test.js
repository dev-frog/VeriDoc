import { describe, it, expect, vi } from 'vitest';
import { createReranker, createApiReranker } from '../src/core/rerank/index.js';
import { createChatClient, createLlm } from '../src/core/llm/index.js';
import { createChatOcr, createOcr, needsOcr, ocrTextToSections } from '../src/core/ocr/index.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fakeFetch(respond) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return respond(url, init);
  });
  fn.calls = calls;
  return fn;
}
const http = (fetch) => ({ fetch, sleep: async () => {}, retries: 0 });

describe('reranker', () => {
  it('none keeps the incoming order', async () => {
    const r = createReranker({ RERANK_PROVIDER: 'none' });
    expect(await r.rerank('q', ['a', 'b', 'c'], 2)).toEqual([{ index: 0, score: null }, { index: 1, score: null }]);
  });

  it('cohere: default URL and model, sorted by relevance_score', async () => {
    const fetch = fakeFetch(() => json({ results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }] }));
    const r = createReranker({ RERANK_PROVIDER: 'cohere', RERANK_API_KEY: 'k' }, { http: http(fetch) });
    expect(await r.rerank('q', ['a', 'b'], 5)).toEqual([{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }]);
    expect(fetch.calls[0].url).toBe('https://api.cohere.com/v2/rerank');
    expect(fetch.calls[0].body).toEqual({ model: 'rerank-v3.5', query: 'q', documents: ['a', 'b'], top_n: 2 });
    expect(fetch.calls[0].headers.authorization).toBe('Bearer k');
  });

  it('works through a gateway like OpenRouter with RERANK_BASE_URL and RERANK_MODEL', async () => {
    const fetch = fakeFetch(() => json({ results: [{ index: 0, relevance_score: 0.5 }] }));
    const r = createReranker(
      { RERANK_PROVIDER: 'cohere', RERANK_API_KEY: 'k', RERANK_BASE_URL: 'https://openrouter.ai/api/v1/', RERANK_MODEL: 'cohere/rerank-v3.5' },
      { http: http(fetch) },
    );
    await r.rerank('q', ['a'], 1);
    expect(fetch.calls[0].url).toBe('https://openrouter.ai/api/v1/rerank');
    expect(fetch.calls[0].body.model).toBe('cohere/rerank-v3.5');
    expect(r.name).toBe('cohere/cohere/rerank-v3.5');
  });

  it('voyage uses top_k and the data[] response shape', async () => {
    const fetch = fakeFetch(() => json({ data: [{ index: 1, relevance_score: 0.7 }] }));
    const r = createApiReranker({ provider: 'voyage', apiKey: 'k', http: http(fetch) });
    expect(await r.rerank('q', ['a', 'b'], 1)).toEqual([{ index: 1, score: 0.7 }]);
    expect(fetch.calls[0].body).toMatchObject({ model: 'rerank-2.5', top_k: 1 });
  });

  it('ignores out-of-range indexes and needs a key', async () => {
    const fetch = fakeFetch(() => json({ results: [{ index: 7, relevance_score: 1 }, { index: 0, relevance_score: 0.2 }] }));
    const r = createApiReranker({ provider: 'jina', apiKey: 'k', http: http(fetch) });
    expect(await r.rerank('q', ['a'], 3)).toEqual([{ index: 0, score: 0.2 }]);
    await expect(createApiReranker({ provider: 'jina' }).rerank('q', ['a'], 1)).rejects.toMatchObject({ code: 'config_error' });
  });
});

describe('LLM client', () => {
  it('posts an OpenAI-style chat completion and returns the text', async () => {
    const fetch = fakeFetch(() => json({ choices: [{ message: { content: '  Hi [Source 1] ' } }], usage: { total_tokens: 9 } }));
    const llm = createLlm(
      { LLM_BASE_URL: 'https://openrouter.ai/api/v1', LLM_API_KEY: 'k', LLM_MODEL: 'openrouter/free', LLM_MAX_TOKENS: 300 },
      { http: http(fetch) },
    );
    expect(await llm.chat([{ role: 'user', content: 'x' }])).toEqual({ text: 'Hi [Source 1]', usage: { total_tokens: 9 } });
    expect(fetch.calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(fetch.calls[0].body).toEqual({ model: 'openrouter/free', messages: [{ role: 'user', content: 'x' }], max_tokens: 300 });
  });

  it('only sends temperature when configured, and uses api-key for Azure', async () => {
    const fetch = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }));
    const llm = createChatClient({ baseUrl: 'https://r.openai.azure.com/openai/v1', apiKey: 'az', model: 'dep', temperature: 0.2, http: http(fetch) });
    await llm.chat([]);
    expect(fetch.calls[0].body.temperature).toBe(0.2);
    expect(fetch.calls[0].headers['api-key']).toBe('az');
  });

  it('reports a missing key or model as config errors', async () => {
    await expect(createChatClient({ baseUrl: 'https://x/v1', model: 'm' }).chat([])).rejects.toThrow('LLM_API_KEY is not set');
    await expect(createChatClient({ baseUrl: 'https://x/v1', apiKey: 'k' }).chat([])).rejects.toThrow('LLM_MODEL is not set');
  });

  it('treats an empty completion as a retryable provider error', async () => {
    const fetch = fakeFetch(() => json({ choices: [{ message: { content: null } }] }));
    await expect(createChatClient({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', http: http(fetch) }).chat([])).rejects.toMatchObject({
      code: 'provider_error',
      retryable: true,
    });
  });
});

describe('OCR', () => {
  it('needsOcr: true for image-only PDFs, false when pages have text', () => {
    expect(needsOcr([{ text: '' }, { text: '2' }])).toBe(true);
    expect(needsOcr([{ text: 'This page has a real paragraph of text on it, long enough.' }])).toBe(false);
  });

  it('ocrTextToSections splits on page markers and keeps headings', () => {
    const out = ocrTextToSections('=== Page 1 ===\n# Intro\nHello there.\n\n=== Page 2 ===\nPlain text.\n## Details\nMore.');
    expect(out).toEqual([
      { page: 1, heading: 'Intro', text: 'Hello there.' },
      { page: 2, heading: null, text: 'Plain text.' },
      { page: 2, heading: 'Details', text: 'More.' },
    ]);
    expect(ocrTextToSections('```markdown\nNo markers\n```')).toEqual([{ page: null, heading: null, text: 'No markers' }]);
  });

  it('sends the PDF as a file part, with the OpenRouter PDF engine when set', async () => {
    const fetch = fakeFetch(() => json({ choices: [{ message: { content: '=== Page 1 ===\nScanned text' } }] }));
    const ocr = createChatOcr({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'google/gemma', pdfEngine: 'mistral-ocr', http: http(fetch) });
    expect(await ocr.ocrPdf(new Uint8Array([37, 80, 68, 70]), 'scan.pdf')).toEqual([{ page: 1, heading: null, text: 'Scanned text' }]);
    const body = fetch.calls[0].body;
    expect(body.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]);
    expect(body.messages[0].content[1]).toEqual({ type: 'file', file: { filename: 'scan.pdf', file_data: 'data:application/pdf;base64,JVBERg==' } });
  });

  it('createOcr returns null when disabled', () => {
    expect(createOcr({ OCR_PROVIDER: 'none' })).toBeNull();
  });
});
