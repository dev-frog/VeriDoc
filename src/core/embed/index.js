import { createOpenAIEmbedder } from './openai.js';
import { createVoyageEmbedder } from './voyage.js';

/**
 * @typedef {object} Embedder
 * @property {number} dimensions
 * @property {(texts: string[], opts?: { inputType?: 'document' | 'query' }) => Promise<number[][]>} embed
 *   Returns one vector per input, in input order.
 */

/**
 * @param {{ EMBED_PROVIDER: 'openai-compatible' | 'voyage', EMBED_MODEL: string, EMBED_DIMENSIONS: number,
 *   EMBED_BATCH_SIZE: number, EMBED_API_KEY?: string, EMBED_BASE_URL: string }} config
 * @param {{ http?: import('./http.js').RetryOptions }} [deps]
 * @returns {Embedder}
 */
export function createEmbedder(config, { http } = {}) {
  const common = { model: config.EMBED_MODEL, dimensions: config.EMBED_DIMENSIONS, batchSize: config.EMBED_BATCH_SIZE, http };
  switch (config.EMBED_PROVIDER) {
    case 'openai-compatible':
      return createOpenAIEmbedder({ ...common, apiKey: config.EMBED_API_KEY, baseUrl: config.EMBED_BASE_URL });
    case 'voyage':
      return createVoyageEmbedder({ ...common, apiKey: config.EMBED_API_KEY });
    default:
      throw new Error(`Unknown EMBED_PROVIDER: ${config.EMBED_PROVIDER}`);
  }
}

export { createOpenAIEmbedder, createVoyageEmbedder };
