// Public API of the VeriDoc engine. Nothing here knows about HTTP or MongoDB.
export { CoreError, ErrorCodes } from './errors.js';

export { createIngestService, embeddingInput } from './ingest/service.js';
export { chunkSections } from './ingest/chunker.js';
export { countTokens } from './ingest/tokens.js';
export { parseDocument } from './ingest/parsers/index.js';
export { mimeTypeForFileName, SUPPORTED_EXTENSIONS, MIME } from './ingest/file-types.js';
export { createFileFetcher, isAllowedSourceUrl } from './ingest/fetch-file.js';

export { createEmbedder, createOpenAIEmbedder, createVoyageEmbedder } from './embed/index.js';

export { createReranker, createApiReranker, createNoopReranker, DEFAULT_RERANK_MODELS } from './rerank/index.js';
export { createLlm, createChatClient } from './llm/index.js';
export { createOcr, createChatOcr, needsOcr } from './ocr/index.js';
export { createSearchService } from './search/service.js';
export { createAnswerService, buildMessages } from './answer/service.js';
export { verifyCitations, extractCitations, NO_ANSWER } from './answer/citations.js';
