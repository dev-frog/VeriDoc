import { CoreError, ErrorCodes } from '../errors.js';
import { postJson, toBatches } from './http.js';
import { readVectors } from './openai.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

/**
 * Voyage AI embeddings. Voyage distinguishes "document" and "query" inputs.
 * Supported output dimensions depend on the model (e.g. 256/512/1024/2048
 * for voyage-3.5); check https://docs.voyageai.com/reference/embeddings-api
 * @param {{ apiKey?: string, model: string, dimensions: number, batchSize?: number,
 *   url?: string, http?: import('./http.js').RetryOptions }} opts
 * @returns {import('./index.js').Embedder}
 */
export function createVoyageEmbedder({ apiKey, model, dimensions, batchSize = 64, url = VOYAGE_URL, http }) {
  return {
    dimensions,
    async embed(texts, { inputType = 'document' } = {}) {
      if (!apiKey) throw new CoreError(ErrorCodes.CONFIG_ERROR, 'VOYAGE_API_KEY is not set');
      /** @type {number[][]} */
      const out = [];
      for (const batch of toBatches(texts, batchSize)) {
        const body = { model, input: batch, input_type: inputType, output_dimension: dimensions };
        const json = await postJson('Voyage embeddings', url, body, { authorization: `Bearer ${apiKey}` }, http);
        out.push(...readVectors(json, batch.length, dimensions, 'Voyage'));
      }
      return out;
    },
  };
}
