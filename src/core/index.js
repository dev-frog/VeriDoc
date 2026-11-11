// Public API of the VeriDoc engine. Nothing here knows about HTTP or MongoDB.
export { CoreError, ErrorCodes } from './errors.js';

export { createIngestService, embeddingInput } from './ingest/service.js';
export { chunkSections } from './ingest/chunker.js';
export { countTokens } from './ingest/tokens.js';
export { parseDocument } from './ingest/parsers/index.js';
export { mimeTypeForFileName, SUPPORTED_EXTENSIONS, MIME } from './ingest/file-types.js';
export { createFileFetcher, isAllowedSourceUrl } from './ingest/fetch-file.js';

export { createEmbedder, createOpenAIEmbedder, createVoyageEmbedder } from './embed/index.js';
