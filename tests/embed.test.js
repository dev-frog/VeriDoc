import { describe, it, expect, vi } from 'vitest';
import { fetchWithRetry, parseRetryAfter, toBatches } from '../src/core/embed/http.js';
import { createOpenAIEmbedder, openAIAuthHeaders } from '../src/core/embed/openai.js';
import { createVoyageEmbedder } from '../src/core/embed/voyage.js';
import { createEmbedder } from '../src/core/embed/index.js';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** fetch fake that returns queued responses (functions get the request). */
function fakeFetch(...queue) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, init) : next.clone();
  });
  fn.calls = calls;
  return fn;
}

const noSleep = { sleep: async () => {}, random: () => 0.5 };

/** Echo embeddings: vector [i, len] per input, returned in shuffled order. */
const echoEmbeddings = (dims) => (_url, init) => {
  const { input } = JSON.parse(init.body);
  const data = input.map((t, i) => ({ index: i, embedding: Array(dims).fill(0).map((_, d) => (d === 0 ? t.length : i)) }));
  return json({ data: data.reverse() });
};

describe('fetchWithRetry', () => {
  it('retries 429 and 5xx, then returns the success', async () => {
    const fetch = fakeFetch(json({}, 429), json({}, 503), json({ ok: true }));
    const sleep = vi.fn(async () => {});
    const res = await fetchWithRetry('u', {}, { fetch, sleep, random: () => 0.5 });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([375, 750]); // 500*2^n*0.75
  });

  it('retries network errors', async () => {
    const fetch = fakeFetch(new TypeError('fetch failed'), json({ ok: true }));
    expect((await fetchWithRetry('u', {}, { fetch, ...noSleep })).status).toBe(200);
  });

  it('does not retry 4xx (other than 429)', async () => {
    const fetch = fakeFetch(json({}, 400));
    expect((await fetchWithRetry('u', {}, { fetch, ...noSleep })).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after `retries` retries and returns the last response', async () => {
    const fetch = fakeFetch(json({}, 500));
    const res = await fetchWithRetry('u', {}, { fetch, retries: 2, ...noSleep });
    expect(res.status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('honors Retry-After, capped at maxDelayMs', async () => {
    const sleep = vi.fn(async () => {});
    const fetch = fakeFetch(json({}, 429, { 'retry-after': '2' }), json({}, 429, { 'retry-after': '120' }), json({}));
    await fetchWithRetry('u', {}, { fetch, sleep, maxDelayMs: 10_000 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 10_000]);
  });

  it('parseRetryAfter handles seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('garbage')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('toBatches', () => {
  it('splits into fixed-size batches', () => {
    expect(toBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(toBatches([], 2)).toEqual([]);
  });
});

describe('OpenAI embedder', () => {
  const base = { apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimensions: 3 };

  it('batches requests and returns vectors in input order', async () => {
    const fetch = fakeFetch(echoEmbeddings(3));
    const e = createOpenAIEmbedder({ ...base, batchSize: 2, http: { fetch, ...noSleep } });
    const out = await e.embed(['a', 'bb', 'ccc', 'dddd', 'eeeee']);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(out.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
    expect(fetch.calls[0].url).toBe('https://api.openai.com/v1/embeddings');
    expect(fetch.calls[0].body).toEqual({ model: 'text-embedding-3-small', input: ['a', 'bb'], dimensions: 3 });
    expect(fetch.calls[0].init.headers.authorization).toBe('Bearer sk-test');
  });

  it('uses the api-key header for Azure endpoints', () => {
    expect(openAIAuthHeaders('https://x.openai.azure.com/openai/v1', 'k')).toEqual({ 'api-key': 'k' });
    expect(openAIAuthHeaders('https://api.openai.com/v1', 'k')).toEqual({ authorization: 'Bearer k' });
  });

  it('throws config_error without an API key', async () => {
    const e = createOpenAIEmbedder({ ...base, apiKey: undefined });
    await expect(e.embed(['x'])).rejects.toMatchObject({ code: 'config_error' });
  });

  it('throws provider_error on wrong vector length', async () => {
    const fetch = fakeFetch(echoEmbeddings(5));
    const e = createOpenAIEmbedder({ ...base, http: { fetch, ...noSleep } });
    await expect(e.embed(['x'])).rejects.toThrow(/length 5.*EMBED_DIMENSIONS is 3/);
  });

  it('surfaces provider error messages (not the key)', async () => {
    const fetch = fakeFetch(json({ error: { message: 'Invalid model' } }, 400));
    const e = createOpenAIEmbedder({ ...base, http: { fetch, ...noSleep } });
    const err = await e.embed(['x']).catch((x) => x);
    expect(err).toMatchObject({ code: 'provider_error', retryable: false });
    expect(err.message).toContain('HTTP 400: Invalid model');
    expect(err.message).not.toContain('sk-test');
  });

  it('marks exhausted 429s as retryable', async () => {
    const fetch = fakeFetch(json({ error: { message: 'slow down' } }, 429));
    const e = createOpenAIEmbedder({ ...base, http: { fetch, retries: 1, ...noSleep } });
    await expect(e.embed(['x'])).rejects.toMatchObject({ code: 'provider_error', retryable: true });
  });
});

describe('Voyage embedder', () => {
  it('sends input_type and output_dimension', async () => {
    const fetch = fakeFetch(echoEmbeddings(4));
    const e = createVoyageEmbedder({ apiKey: 'v', model: 'voyage-3.5', dimensions: 4, http: { fetch, ...noSleep } });
    await e.embed(['q'], { inputType: 'query' });
    expect(fetch.calls[0].url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(fetch.calls[0].body).toEqual({ model: 'voyage-3.5', input: ['q'], input_type: 'query', output_dimension: 4 });
  });
});

describe('createEmbedder', () => {
  const config = {
    EMBED_MODEL: 'm',
    EMBED_DIMENSIONS: 2,
    EMBED_BATCH_SIZE: 64,
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
  };
  it('picks the provider from config', () => {
    expect(createEmbedder({ ...config, EMBED_PROVIDER: 'openai' }).dimensions).toBe(2);
    expect(createEmbedder({ ...config, EMBED_PROVIDER: 'voyage' }).dimensions).toBe(2);
    expect(() => createEmbedder({ ...config, EMBED_PROVIDER: 'x' })).toThrow(/Unknown/);
  });
});
