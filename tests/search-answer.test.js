import { describe, it, expect, vi } from 'vitest';
import { createSearchService } from '../src/core/search/service.js';
import { createAnswerService, buildMessages } from '../src/core/answer/service.js';
import { createNoopReranker } from '../src/core/rerank/index.js';
import { createMemoryRepo } from './helpers/memory-repo.js';

/** Toy embedder: one dimension per keyword, so similarity follows shared words. */
const VOCAB = ['refund', 'days', 'holiday', 'office', 'password', 'laptop'];
const embedder = {
  dimensions: VOCAB.length,
  embed: vi.fn(async (texts) => texts.map((t) => VOCAB.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)))),
};

async function seed() {
  const repo = createMemoryRepo();
  const add = async (fileName, status, chunks) => {
    const id = await repo.insertDocument({ fileName, status });
    await repo.insertChunks(id, chunks.map((c, i) => ({ chunkIndex: i, page: c.page ?? null, heading: c.heading ?? null, text: c.text })));
    const vecs = await embedder.embed(chunks.map((c) => c.text));
    const stored = await repo.findChunksWithoutEmbedding(id, 100);
    await repo.setEmbeddings(stored.map((s, i) => ({ id: s.id, embedding: vecs[i] })));
    return id;
  };
  const policy = await add('policy.pdf', 'ready', [
    { page: 2, heading: 'Refunds', text: 'Customers can request a refund within 30 days of purchase.' },
    { page: 5, heading: 'Office', text: 'The office is closed on every public holiday.' },
  ]);
  const it = await add('it.md', 'ready', [{ heading: 'Security', text: 'Change your password every 90 days.' }]);
  const draft = await add('draft.md', 'processing', [{ text: 'Refund window is 14 days (draft, not final).' }]);
  return { repo, ids: { policy, it, draft } };
}

describe('search service', () => {
  it('returns ranked chunks with document info and skips documents that are not ready', async () => {
    const { repo } = await seed();
    const search = createSearchService({ repo, embedder, reranker: createNoopReranker(), topK: 10, topN: 3 });
    const { results, candidates } = await search.search({ query: 'How many days for a refund?' });
    expect(candidates).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({ rank: 1, fileName: 'policy.pdf', page: 2, heading: 'Refunds' });
    expect(results.map((r) => r.fileName)).not.toContain('draft.md');
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('filters by documentIds and embeds the query as a query', async () => {
    const { repo, ids } = await seed();
    embedder.embed.mockClear();
    const search = createSearchService({ repo, embedder, reranker: createNoopReranker() });
    const { results } = await search.search({ query: 'days', documentIds: [ids.it] });
    expect(results.every((r) => r.documentId === ids.it)).toBe(true);
    expect(embedder.embed).toHaveBeenCalledWith(['days'], { inputType: 'query' });
  });

  it('applies the reranker order and scores', async () => {
    const { repo } = await seed();
    const reranker = { name: 'fake', rerank: vi.fn(async (_q, docs) => docs.map((_, i) => ({ index: docs.length - 1 - i, score: 0.9 - i / 10 }))) };
    const search = createSearchService({ repo, embedder, reranker, topK: 10, topN: 2 });
    const { results } = await search.search({ query: 'refund office holiday password' });
    expect(reranker.rerank).toHaveBeenCalledWith('refund office holiday password', expect.any(Array), 2);
    expect(results.map((r) => r.score)).toEqual([0.9, 0.8]);
    // rerank input includes the heading path, like the embedding input
    expect(reranker.rerank.mock.calls[0][1].some((t) => t.startsWith('Refunds\n\n'))).toBe(true);
  });

  it('rejects empty queries', async () => {
    const { repo } = await seed();
    const search = createSearchService({ repo, embedder, reranker: createNoopReranker() });
    await expect(search.search({ query: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('answer service', () => {
  const makeAnswer = async (reply) => {
    const { repo } = await seed();
    const search = createSearchService({ repo, embedder, reranker: createNoopReranker(), topK: 10, topN: 3 });
    const llm = { model: 'fake-model', chat: vi.fn(async () => ({ text: reply, usage: { total_tokens: 42 } })) };
    return { answer: createAnswerService({ search, llm }), llm };
  };

  it('answers with verified citations mapped to their sources', async () => {
    const { answer, llm } = await makeAnswer('You can request a refund within 30 days of purchase. [Source 1]');
    const res = await answer.ask({ question: 'How long do I have to request a refund?' });
    expect(res.verification.status).toBe('verified');
    expect(res.citations).toEqual([
      expect.objectContaining({ n: 1, fileName: 'policy.pdf', page: 2, heading: 'Refunds', label: 'policy.pdf · page 2 · Refunds' }),
    ]);
    expect(res.model).toBe('fake-model');
    const prompt = llm.chat.mock.calls[0][0][1].content;
    expect(prompt).toContain('[Source 1] (policy.pdf · page 2 · Refunds)');
    expect(prompt).toContain('Question: How long do I have to request a refund?');
  });

  it('flags citations to sources that were never retrieved', async () => {
    const { answer } = await makeAnswer('Refunds take 30 days [Source 1]. Laptops are replaced yearly [Source 9].');
    const res = await answer.ask({ question: 'refund days' });
    expect(res.verification.status).toBe('partial');
    expect(res.verification.invalidCitations).toEqual([9]);
    expect(res.citations.map((c) => c.n)).toEqual([1]);
  });

  it('does not call the LLM when nothing is retrieved', async () => {
    const repo = createMemoryRepo();
    const llm = { model: 'm', chat: vi.fn() };
    const search = createSearchService({ repo, embedder, reranker: createNoopReranker() });
    const res = await createAnswerService({ search, llm }).ask({ question: 'anything?' });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(res.verification.status).toBe('no_sources');
    expect(res.answer).toMatch(/couldn't find/);
  });

  it('reports no_answer when the model says the sources lack the answer', async () => {
    const { answer } = await makeAnswer("I couldn't find this in the provided documents.");
    expect((await answer.ask({ question: 'Who is the CEO?' })).verification.status).toBe('no_answer');
  });

  it('buildMessages numbers sources in order', () => {
    const msgs = buildMessages('Q?', [
      { fileName: 'a.md', page: null, heading: null, text: 'A' },
      { fileName: 'b.pdf', page: 3, heading: 'H', text: 'B' },
    ]);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toMatch(/\[Source 1\] \(a\.md\)\nA[\s\S]*\[Source 2\] \(b\.pdf · page 3 · H\)\nB/);
  });
});
