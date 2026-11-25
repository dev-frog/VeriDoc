import { CoreError, ErrorCodes } from '../errors.js';
import { postJson } from '../http.js';

/**
 * @typedef {object} Reranker
 * @property {string} name  provider / model, for logs and diagnostics
 * @property {(query: string, documents: string[], topN: number) => Promise<{ index: number, score: number | null }[]>} rerank
 *   Returns at most topN items, best first. `index` points into `documents`.
 */

/** Default rerank model per provider, used when RERANK_MODEL is empty. */
export const DEFAULT_RERANK_MODELS = Object.freeze({
  cohere: 'rerank-v3.5',
  voyage: 'rerank-2.5',
  jina: 'jina-reranker-v2-base-multilingual',
});

const DEFAULT_URLS = Object.freeze({
  cohere: 'https://api.cohere.com/v2/rerank',
  voyage: 'https://api.voyageai.com/v1/rerank',
  jina: 'https://api.jina.ai/v1/rerank',
});

/**
 * Keeps the incoming order (used when RERANK_PROVIDER=none).
 * @returns {Reranker}
 */
export function createNoopReranker() {
  return {
    name: 'none',
    async rerank(_query, documents, topN) {
      return documents.slice(0, topN).map((_, index) => ({ index, score: null }));
    },
  };
}

/**
 * Cohere-style /rerank API. Cohere, Jina, Voyage and gateways such as
 * OpenRouter (`baseUrl: https://openrouter.ai/api/v1`) all take
 * `{ model, query, documents }` and return `[{ index, relevance_score }]`.
 * @param {{ provider: 'cohere' | 'voyage' | 'jina', apiKey?: string, model?: string, baseUrl?: string,
 *   http?: import('../http.js').RetryOptions }} opts
 * @returns {Reranker}
 */
export function createApiReranker({ provider, apiKey, model, baseUrl, http }) {
  const url = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/rerank` : DEFAULT_URLS[provider];
  const modelName = model ?? DEFAULT_RERANK_MODELS[provider];
  if (!url || !modelName) throw new Error(`Unknown RERANK_PROVIDER: ${provider}`);
  return {
    name: `${provider}/${modelName}`,
    async rerank(query, documents, topN) {
      if (!apiKey) throw new CoreError(ErrorCodes.CONFIG_ERROR, 'RERANK_API_KEY is not set');
      if (documents.length === 0) return [];
      const n = Math.min(topN, documents.length);
      const body = { model: modelName, query, documents, ...(provider === 'voyage' ? { top_k: n } : { top_n: n }) };
      const json = await postJson('Rerank API', url, body, { authorization: `Bearer ${apiKey}` }, http);
      const items = json?.results ?? json?.data;
      if (!Array.isArray(items)) throw new CoreError(ErrorCodes.PROVIDER_ERROR, 'Rerank API returned no results array');
      return items
        .map((r) => ({ index: r.index, score: r.relevance_score ?? r.score ?? null }))
        .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < documents.length)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, n);
    },
  };
}

/**
 * @param {{ RERANK_PROVIDER: 'cohere' | 'voyage' | 'jina' | 'none', RERANK_API_KEY?: string,
 *   RERANK_MODEL?: string, RERANK_BASE_URL?: string }} config
 * @param {{ http?: import('../http.js').RetryOptions }} [deps]
 * @returns {Reranker}
 */
export function createReranker(config, { http } = {}) {
  if (config.RERANK_PROVIDER === 'none') return createNoopReranker();
  return createApiReranker({
    provider: config.RERANK_PROVIDER,
    apiKey: config.RERANK_API_KEY,
    model: config.RERANK_MODEL,
    baseUrl: config.RERANK_BASE_URL,
    http,
  });
}
