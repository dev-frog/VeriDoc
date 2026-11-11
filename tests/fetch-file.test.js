import { describe, it, expect } from 'vitest';
import { createFileFetcher, isAllowedSourceUrl } from '../src/core/ingest/fetch-file.js';

describe('isAllowedSourceUrl', () => {
  const blob = ['*.public.blob.vercel-storage.com'];
  it('allows https on matching hosts', () => {
    expect(isAllowedSourceUrl('https://abc.public.blob.vercel-storage.com/a.pdf', blob)).toBe(true);
  });
  it('rejects other hosts, http, bad URLs and the bare suffix', () => {
    expect(isAllowedSourceUrl('https://evil.com/a.pdf', blob)).toBe(false);
    expect(isAllowedSourceUrl('https://public.blob.vercel-storage.com.evil.com/a', blob)).toBe(false);
    expect(isAllowedSourceUrl('http://abc.public.blob.vercel-storage.com/a.pdf', blob)).toBe(false);
    expect(isAllowedSourceUrl('not a url', blob)).toBe(false);
    expect(isAllowedSourceUrl('https://.public.blob.vercel-storage.com/a', blob)).toBe(false);
  });
  it('supports "*" and exact hosts', () => {
    expect(isAllowedSourceUrl('https://anything.io/x', ['*'])).toBe(true);
    expect(isAllowedSourceUrl('https://raw.githubusercontent.com/x', ['raw.githubusercontent.com'])).toBe(true);
    expect(isAllowedSourceUrl('https://sub.raw.githubusercontent.com/x', ['raw.githubusercontent.com'])).toBe(false);
  });
});

describe('createFileFetcher', () => {
  const fetchReturning = (res) => async () => res;

  it('returns the body bytes', async () => {
    const f = createFileFetcher({ fetch: fetchReturning(new Response('hello')) });
    expect(new TextDecoder().decode(await f('https://x'))).toBe('hello');
  });

  it('rejects files over the limit (by header and by streamed size)', async () => {
    const big = 'x'.repeat(20);
    const withHeader = createFileFetcher({
      maxBytes: 10,
      fetch: fetchReturning(new Response(big, { headers: { 'content-length': '20' } })),
    });
    await expect(withHeader('https://x')).rejects.toMatchObject({ code: 'fetch_failed', retryable: false });

    const streamed = createFileFetcher({ maxBytes: 10, fetch: fetchReturning(new Response(big)) });
    await expect(streamed('https://x')).rejects.toThrow(/larger than/);
  });

  it('classifies HTTP errors as permanent (4xx) or retryable (5xx/429)', async () => {
    const f404 = createFileFetcher({ fetch: fetchReturning(new Response('', { status: 404 })) });
    await expect(f404('https://x')).rejects.toMatchObject({ retryable: false });
    const f503 = createFileFetcher({ fetch: fetchReturning(new Response('', { status: 503 })) });
    await expect(f503('https://x')).rejects.toMatchObject({ retryable: true });
    const f429 = createFileFetcher({ fetch: fetchReturning(new Response('', { status: 429 })) });
    await expect(f429('https://x')).rejects.toMatchObject({ retryable: true });
  });

  it('refuses redirects', async () => {
    const f = createFileFetcher({
      fetch: fetchReturning(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })),
    });
    await expect(f('https://x')).rejects.toThrow(/redirect/);
  });

  it('treats network errors as retryable', async () => {
    const f = createFileFetcher({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(f('https://x')).rejects.toMatchObject({ code: 'fetch_failed', retryable: true });
  });
});
