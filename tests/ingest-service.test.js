import { describe, it, expect, vi } from 'vitest';
import { createIngestService, embeddingInput } from '../src/core/ingest/service.js';
import { CoreError } from '../src/core/errors.js';
import { createMemoryRepo } from './helpers/memory-repo.js';
import { makePdf } from './helpers/make-pdf.js';

const URL_MD = 'https://files.example.com/guide.md';
const enc = (s) => new TextEncoder().encode(s);
const words = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

/** 3 sections x 4 sentences of 5 words => 12 chunks at maxTokens 5 */
const MD = ['# A', '## B', '# C']
  .map((h, i) => `${h}\n${Array.from({ length: 4 }, (_, j) => `Sec${i} s${j} w w w.`).join(' ')}`)
  .join('\n');

function setup({ file = enc(MD), fetchFile, embed, batchSize = 5 } = {}) {
  const repo = createMemoryRepo();
  const embedder = {
    dimensions: 2,
    embed: vi.fn(embed ?? (async (texts) => texts.map((t) => [t.length, 1]))),
  };
  const service = createIngestService({
    repo,
    embedder,
    fetchFile: vi.fn(fetchFile ?? (async () => file)),
    chunkOptions: { maxTokens: 5, overlap: 0, countTokens: words },
    batchSize,
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  return { repo, embedder, service };
}

describe('createDocument', () => {
  it('creates a pending document with derived mimeType', async () => {
    const { service, repo } = setup();
    const { id } = await service.createDocument({ url: URL_MD, fileName: 'guide.md' });
    expect(repo.docs.get(id)).toMatchObject({
      fileName: 'guide.md',
      mimeType: 'text/markdown',
      sourceUrl: URL_MD,
      status: 'pending',
      chunkCount: 0,
      processedCount: 0,
      error: null,
    });
  });

  it('rejects unsupported file types and disallowed URLs', async () => {
    const { service } = setup();
    await expect(service.createDocument({ url: URL_MD, fileName: 'x.exe' })).rejects.toMatchObject({
      code: 'unsupported_type',
    });
    const strict = createIngestService({ ...setup(), repo: createMemoryRepo(), isSourceUrlAllowed: () => false });
    await expect(strict.createDocument({ url: URL_MD, fileName: 'a.md' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('processNext', () => {
  it('parses once, then embeds in batches until ready', async () => {
    const { service, repo, embedder } = setup({ batchSize: 5 });
    const { id } = await service.createDocument({ url: URL_MD, fileName: 'guide.md' });

    expect(await service.processNext(id)).toMatchObject({ status: 'processing', processed: 5, total: 12 });
    expect(await service.processNext(id)).toMatchObject({ status: 'processing', processed: 10, total: 12 });
    expect(await service.processNext(id)).toMatchObject({ status: 'ready', processed: 12, total: 12, error: null });

    expect(repo.chunks.size).toBe(12);
    expect(embedder.embed).toHaveBeenCalledTimes(3);
    expect(embedder.embed.mock.calls[0][1]).toEqual({ inputType: 'document' });
    const chunks = [...repo.chunks.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
    expect(chunks.map((c) => c.heading)).toEqual([...Array(4).fill('A'), ...Array(4).fill('A > B'), ...Array(4).fill('C')]);
    expect(chunks.every((c) => Array.isArray(c.embedding))).toBe(true);
  });

  it('is idempotent: extra calls after ready do nothing', async () => {
    const { service, embedder } = setup({ batchSize: 100 });
    const { id } = await service.createDocument({ url: URL_MD, fileName: 'guide.md' });
    await service.processNext(id);
    const calls = embedder.embed.mock.calls.length;
    expect(await service.processNext(id)).toMatchObject({ status: 'ready', processed: 12 });
    expect(await service.processNext(id)).toMatchObject({ status: 'ready', processed: 12 });
    expect(embedder.embed.mock.calls.length).toBe(calls);
  });

  it('does not duplicate chunks if parsing runs twice (crash after insert)', async () => {
    const { service, repo } = setup({ batchSize: 100 });
    const { id } = await service.createDocument({ url: URL_MD, fileName: 'guide.md' });
    // Simulate a crash between inserting chunks and setting parsedAt.
    const realUpdate = repo.updateDocument;
    let failOnce = true;
    repo.updateDocument = async (docId, set) => {
      if (set.parsedAt && failOnce) {
        failOnce = false;
        throw new Error('crash');
      }
      return realUpdate(docId, set);
    };
    await expect(service.processNext(id)).rejects.toThrow('crash');
    expect(await service.processNext(id)).toMatchObject({ status: 'ready', total: 12 });
    expect(repo.chunks.size).toBe(12);
  });

  it('prepends the heading to the embedding input only', async () => {
    const { service, embedder, repo } = setup({ batchSize: 1 });
    const { id } = await service.createDocument({ url: URL_MD, fileName: 'guide.md' });
    await service.processNext(id);
    expect(embedder.embed.mock.calls[0][0]).toEqual(['A\n\nSec0 s0 w w w.']);
    expect([...repo.chunks.values()][0].text).toBe('Sec0 s0 w w w.');
    expect(embeddingInput({ text: 't', heading: null })).toBe('t');
  });

  it('records pageCount for PDFs', async () => {
    const { service, repo } = setup({ file: makePdf(['One two three four five.', '', 'Six seven.']) });
    const { id } = await service.createDocument({ url: 'https://f/a.pdf', fileName: 'a.pdf' });
    await service.processNext(id);
    expect(repo.docs.get(id).pageCount).toBe(3);
    expect([...repo.chunks.values()].map((c) => c.page)).toEqual([1, 3]);
  });

  it('marks the document failed on a parse error', async () => {
    const { service, embedder } = setup({ file: enc('not a pdf') });
    const { id } = await service.createDocument({ url: 'https://f/a.pdf', fileName: 'a.pdf' });
    const r = await service.processNext(id);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Could not parse/);
    expect(embedder.embed).not.toHaveBeenCalled();
    expect((await service.processNext(id)).status).toBe('failed');
  });

  it('marks the document failed when no text is extracted', async () => {
    const { service } = setup({ file: makePdf(['', '']) });
    const { id } = await service.createDocument({ url: 'https://f/a.pdf', fileName: 'a.pdf' });
    expect(await service.processNext(id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/OCR/) });
  });

  it('marks failed on permanent fetch errors, rethrows retryable ones', async () => {
    const perm = setup({
      fetchFile: async () => {
        throw new CoreError('fetch_failed', 'HTTP 404');
      },
    });
    const a = await perm.service.createDocument({ url: URL_MD, fileName: 'a.md' });
    expect(await perm.service.processNext(a.id)).toMatchObject({ status: 'failed', error: 'HTTP 404' });

    let attempts = 0;
    const transient = setup({
      fetchFile: async () => {
        if (attempts++ === 0) throw new CoreError('fetch_failed', 'HTTP 503', { retryable: true });
        return enc(MD);
      },
      batchSize: 100,
    });
    const b = await transient.service.createDocument({ url: URL_MD, fileName: 'b.md' });
    await expect(transient.service.processNext(b.id)).rejects.toMatchObject({ retryable: true });
    expect(transient.repo.docs.get(b.id).status).toBe('processing');
    expect(await transient.service.processNext(b.id)).toMatchObject({ status: 'ready' });
  });

  it('leaves the document processing when embedding fails, and resumes later', async () => {
    let fail = true;
    const { service, repo } = setup({
      batchSize: 100,
      embed: async (texts) => {
        if (fail) throw new CoreError('provider_error', 'HTTP 500', { retryable: true });
        return texts.map(() => [0, 0]);
      },
    });
    const { id } = await service.createDocument({ url: URL_MD, fileName: 'a.md' });
    await expect(service.processNext(id)).rejects.toMatchObject({ code: 'provider_error' });
    expect(repo.docs.get(id)).toMatchObject({ status: 'processing', chunkCount: 12, processedCount: 0 });
    fail = false;
    expect(await service.processNext(id)).toMatchObject({ status: 'ready', processed: 12 });
  });

  it('fails instead of looping forever if chunks went missing', async () => {
    const { service, repo } = setup({ batchSize: 100 });
    const { id } = await service.createDocument({ url: URL_MD, fileName: 'a.md' });
    const realSet = repo.setEmbeddings;
    repo.setEmbeddings = async (items) => {
      repo.chunks.delete(items[0].id);
      return realSet(items);
    };
    expect(await service.processNext(id)).toMatchObject({ status: 'processing', processed: 11 });
    expect(await service.processNext(id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/Expected 12/) });
  });

  it('throws not_found for unknown ids', async () => {
    const { service } = setup();
    await expect(service.processNext('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('list / get / delete', () => {
  it('lists newest first with a cursor', async () => {
    const { service } = setup();
    const ids = [];
    for (const n of ['a', 'b', 'c']) ids.push((await service.createDocument({ url: URL_MD, fileName: `${n}.md` })).id);
    const page1 = await service.listDocuments({ limit: 2 });
    expect(page1.items.map((d) => d.fileName)).toEqual(['c.md', 'b.md']);
    const page2 = await service.listDocuments({ limit: 2, cursor: page1.nextCursor });
    expect(page2).toMatchObject({ items: [{ fileName: 'a.md' }], nextCursor: null });
  });

  it('deletes a document and its chunks', async () => {
    const { service, repo } = setup({ batchSize: 100 });
    const { id } = await service.createDocument({ url: URL_MD, fileName: 'a.md' });
    await service.processNext(id);
    await service.deleteDocument(id);
    expect(repo.chunks.size).toBe(0);
    await expect(service.getDocument(id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.deleteDocument(id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
