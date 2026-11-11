import { createApp } from './app.js';
import { getConfig } from '../config.js';
import { pingDb } from '../db/client.js';
import { createMongoIngestRepo } from '../db/ingest-repo.js';
import { createIngestService, createEmbedder, createFileFetcher, isAllowedSourceUrl } from '../core/index.js';

const config = getConfig();

const ingest = createIngestService({
  repo: createMongoIngestRepo(),
  embedder: createEmbedder(config),
  fetchFile: createFileFetcher({ maxBytes: config.MAX_FILE_MB * 1024 * 1024 }),
  chunkOptions: { maxTokens: config.CHUNK_TOKENS, overlap: config.CHUNK_OVERLAP },
  batchSize: config.INGEST_BATCH_SIZE,
  isSourceUrlAllowed: (url) => isAllowedSourceUrl(url, config.SOURCE_URL_HOSTS),
});

/** The production app wired to real dependencies. */
export const app = createApp({
  pingDb,
  ingest,
  auth: { apiKey: config.VERIDOC_API_KEY, required: config.NODE_ENV === 'production' },
});
