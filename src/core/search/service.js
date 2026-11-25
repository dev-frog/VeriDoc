import { CoreError, ErrorCodes } from '../errors.js';
import { embeddingInput } from '../ingest/service.js';

/**
 * @typedef {object} SearchResult
 * @property {number} rank        1-based
 * @property {string} chunkId
 * @property {string} documentId
 * @property {string} fileName
 * @property {number | null} page
 * @property {string | null} heading
 * @property {string} text
 * @property {number} score       reranker relevance score, or the fused (RRF) score when reranking is off
 */

export const MAX_QUERY_CHARS = 2000;

/**
 * Hybrid retrieval: embed the query, fetch topK candidates with BM25 +
 * vector search fused by rank (in the repo), rerank, keep topN.
 * @param {object} deps
 * @param {import('../../db/search-repo.js').SearchRepo} deps.repo
 * @param {import('../embed/index.js').Embedder} deps.embedder
 * @param {import('../rerank/index.js').Reranker} deps.reranker
 * @param {number} [deps.topK=30]
 * @param {number} [deps.topN=5]
 */
export function createSearchService({ repo, embedder, reranker, topK = 30, topN = 5 }) {
  return {
    /**
     * @param {{ query: string, documentIds?: string[], topK?: number, topN?: number }} q
     * @returns {Promise<{ results: SearchResult[], reranker: string, candidates: number }>}
     */
    async search({ query, documentIds, topK: k = topK, topN: n = topN }) {
      const text = query?.trim() ?? '';
      if (!text) throw new CoreError(ErrorCodes.INVALID_INPUT, 'query must not be empty');
      if (text.length > MAX_QUERY_CHARS) {
        throw new CoreError(ErrorCodes.INVALID_INPUT, `query must be at most ${MAX_QUERY_CHARS} characters`);
      }
      n = Math.min(n, k);

      const [vector] = await embedder.embed([text], { inputType: 'query' });
      const candidates = await repo.hybridSearch({ vector, text, limit: k, documentIds });
      if (candidates.length === 0) return { results: [], reranker: reranker.name, candidates: 0 };

      const ranked = await reranker.rerank(text, candidates.map(embeddingInput), n);
      const results = ranked.slice(0, n).map(({ index, score }, i) => {
        const c = candidates[index];
        return {
          rank: i + 1,
          chunkId: c.id,
          documentId: c.docId,
          fileName: c.fileName,
          page: c.page,
          heading: c.heading,
          text: c.text,
          score: score ?? c.score,
        };
      });
      return { results, reranker: reranker.name, candidates: candidates.length };
    },
  };
}

/** @typedef {ReturnType<typeof createSearchService>} SearchService */
