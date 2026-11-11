import { createOpenAIEmbedder } from './openai.js';
import { createVoyageEmbedder } from './voyage.js';

/**
 * @typedef {object} Embedder
 * @property {number} dimensions
 * @property {(texts: string[], opts?: { inputType?: 'document' | 'query' }) => Promise<number[][]>} embed
 *   Returns one vector per input, in input order.
 */

/**
 * @param {{ EMBED_PROVIDER: 'openai' | 'voyage', EMBED_MODEL: string, EMBED_DIMENSIONS: number,
 *   EMBED_BATCH_SIZE: number, OPENAI_API_KEY?: string, OPENAI_BASE_URL: string, VOYAGE_API_KEY?: string }} config
 * @param {{ http?: import('./http.js').RetryOptions }} [deps]
 * @returns {Embedder}
 */
export function createEmbedder(config, { http } = {}) {
  const common = { model: config.EMBED_MODEL, dimensions: config.EMBED_DIMENSIONS, batchSize: config.EMBED_BATCH_SIZE, http };
  switch (config.EMBED_PROVIDER) {
    case 'openai':
      return createOpenAIEmbedder({ ...common, apiKey: config.OPENAI_API_KEY, baseUrl: config.OPENAI_BASE_URL });
    case 'voyage':
      return createVoyageEmbedder({ ...common, apiKey: config.VOYAGE_API_KEY });
    default:
      throw new Error(`Unknown EMBED_PROVIDER: ${config.EMBED_PROVIDER}`);
  }
}

export { createOpenAIEmbedder, createVoyageEmbedder };
