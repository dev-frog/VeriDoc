import { describe, it, expect } from 'vitest';
import { ObjectId } from 'mongodb';
import { hybridSearchPipeline } from '../src/db/search-repo.js';

describe('hybridSearchPipeline', () => {
  it('fuses vector and BM25 search with $rankFusion and keeps only ready documents', () => {
    const p = hybridSearchPipeline({ vector: [0.1, 0.2], text: 'refund', limit: 30 });
    const fusion = p[0].$rankFusion;
    expect(Object.keys(fusion.input.pipelines)).toEqual(['vector', 'text']);
    expect(fusion.input.pipelines.vector[0].$vectorSearch).toMatchObject({
      index: 'chunks_vector', path: 'embedding', queryVector: [0.1, 0.2], numCandidates: 300, limit: 30,
    });
    expect(fusion.input.pipelines.text).toEqual([
      { $search: { index: 'chunks_text', text: { query: 'refund', path: ['text', 'heading'] } } },
      { $limit: 30 },
    ]);
    expect(p[1]).toEqual({ $addFields: { _score: { $meta: 'score' } } });
    expect(p).toContainEqual({ $match: { 'doc.status': 'ready' } });
  });

  it('filters both searches by document ids', () => {
    const ids = [new ObjectId()];
    const p = hybridSearchPipeline({ vector: [1], text: 'x', limit: 5, documentIds: ids });
    const { vector, text } = p[0].$rankFusion.input.pipelines;
    expect(vector[0].$vectorSearch.filter).toEqual({ docId: { $in: ids } });
    expect(text[0].$search.compound.filter).toEqual([{ in: { path: 'docId', value: ids } }]);
    expect(vector[0].$vectorSearch.numCandidates).toBe(100);
  });
});
