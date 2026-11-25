import { createMongoIngestRepo } from './db/ingest-repo.js';
import { createMongoSearchRepo } from './db/search-repo.js';
import { createIngestService, createEmbedder, createFileFetcher, isAllowedSourceUrl } from './core/index.js';
import { createReranker } from './core/rerank/index.js';
import { createLlm } from './core/llm/index.js';
import { createOcr } from './core/ocr/index.js';
import { createSearchService } from './core/search/service.js';
import { createAnswerService } from './core/answer/service.js';

/**
 * Wire the engine to MongoDB and the configured AI providers. Used by the
 * API, the CLI scripts and the eval script, so they all behave the same.
 * @param {import('./config.js').Config} config
 * @param {{ fetchFile?: import('./core/ingest/fetch-file.js').FetchFile, allowAnySource?: boolean }} [opts]
 */
export function createServices(config, { fetchFile, allowAnySource = false } = {}) {
  const embedder = createEmbedder(config);
  const ingestRepo = createMongoIngestRepo();
  const ingest = createIngestService({
    repo: ingestRepo,
    embedder,
    fetchFile: fetchFile ?? createFileFetcher({ maxBytes: config.MAX_FILE_MB * 1024 * 1024 }),
    chunkOptions: { maxTokens: config.CHUNK_TOKENS, overlap: config.CHUNK_OVERLAP },
    batchSize: config.INGEST_BATCH_SIZE,
    isSourceUrlAllowed: allowAnySource ? () => true : (url) => isAllowedSourceUrl(url, config.SOURCE_URL_HOSTS),
    ocr: createOcr(config),
  });
  const search = createSearchService({
    repo: createMongoSearchRepo(),
    embedder,
    reranker: createReranker(config),
    topK: config.TOP_K,
    topN: config.TOP_N,
  });
  const answer = createAnswerService({ search, llm: createLlm(config) });
  return { ingest, ingestRepo, search, answer };
}
