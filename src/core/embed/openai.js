import { CoreError, ErrorCodes } from '../errors.js';
import { postJson, toBatches } from './http.js';

/**
 * Azure OpenAI wants an `api-key` header; OpenAI and most compatible APIs
 * want `Authorization: Bearer`.
 * @param {string} baseUrl
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
export function openAIAuthHeaders(baseUrl, apiKey) {
  const host = new URL(baseUrl).hostname;
  return host.endsWith('.openai.azure.com') || host.endsWith('.cognitiveservices.azure.com')
    ? { 'api-key': apiKey }
    : { authorization: `Bearer ${apiKey}` };
}

/**
 * Embeddings via any OpenAI-compatible /embeddings endpoint (OpenAI, OpenRouter, Azure v1, ...).
 * @param {{ apiKey?: string, baseUrl: string, model: string, dimensions: number,
 *   batchSize?: number, http?: import('./http.js').RetryOptions }} opts
 * @returns {import('./index.js').Embedder}
 */
export function createOpenAIEmbedder({ apiKey, baseUrl, model, dimensions, batchSize = 64, http }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`;
  // Only text-embedding-3-* accepts a custom `dimensions`.
  const sendDimensions = /text-embedding-3/.test(model);

  return {
    dimensions,
    async embed(texts) {
      if (!apiKey) throw new CoreError(ErrorCodes.CONFIG_ERROR, 'EMBED_API_KEY is not set');
      /** @type {number[][]} */
      const out = [];
      for (const batch of toBatches(texts, batchSize)) {
        const body = { model, input: batch, ...(sendDimensions && { dimensions }) };
        const json = await postJson('Embeddings API', url, body, openAIAuthHeaders(baseUrl, apiKey), http);
        out.push(...readVectors(json, batch.length, dimensions, 'Embeddings API'));
      }
      return out;
    },
  };
}

/**
 * Validate and order `{ data: [{ index, embedding }] }` responses.
 * @param {any} json
 * @param {number} expectedCount
 * @param {number} dimensions
 * @param {string} provider
 * @returns {number[][]}
 */
export function readVectors(json, expectedCount, dimensions, provider) {
  const data = Array.isArray(json?.data) ? [...json.data] : null;
  if (!data || data.length !== expectedCount) {
    throw new CoreError(ErrorCodes.PROVIDER_ERROR, `${provider} returned ${data?.length ?? 0} embeddings, expected ${expectedCount}`);
  }
  data.sort((a, b) => a.index - b.index);
  return data.map((d) => {
    if (!Array.isArray(d.embedding) || d.embedding.length !== dimensions) {
      throw new CoreError(
        ErrorCodes.PROVIDER_ERROR,
        `${provider} returned vectors of length ${d.embedding?.length}, but EMBED_DIMENSIONS is ${dimensions}`,
      );
    }
    return d.embedding;
  });
}
