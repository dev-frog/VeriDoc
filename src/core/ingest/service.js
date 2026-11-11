import { CoreError, ErrorCodes } from '../errors.js';
import { mimeTypeForFileName, SUPPORTED_EXTENSIONS } from './file-types.js';
import { parseDocument } from './parsers/index.js';
import { chunkSections } from './chunker.js';

/**
 * Storage the ingest service needs. src/db/ingest-repo.js implements it
 * with MongoDB; tests use an in-memory fake. Ids are opaque strings.
 * @typedef {object} IngestRepo
 * @property {(doc: Omit<DocumentInfo, 'id'>) => Promise<string>} insertDocument
 * @property {(id: string) => Promise<DocumentInfo | null>} getDocument
 * @property {(q: { limit: number, cursor?: string, status?: string }) => Promise<{ items: DocumentInfo[], nextCursor: string | null }>} listDocuments
 * @property {(id: string, set: Partial<DocumentInfo>) => Promise<DocumentInfo | null>} updateDocument
 * @property {(id: string) => Promise<boolean>} deleteDocument  also deletes its chunks
 * @property {(docId: string, chunks: (import('./chunker.js').ChunkDraft & { createdAt: Date })[]) => Promise<void>} insertChunks
 *   must ignore chunks that already exist (same docId + chunkIndex)
 * @property {(docId: string, limit: number) => Promise<{ id: string, text: string, heading: string | null }[]>} findChunksWithoutEmbedding
 *   ordered by chunkIndex
 * @property {(items: { id: string, embedding: number[] }[]) => Promise<void>} setEmbeddings
 * @property {(docId: string) => Promise<number>} countEmbeddedChunks
 */

/**
 * A document as returned by the service (stored shape with a string id).
 * @typedef {object} DocumentInfo
 * @property {string} id
 * @property {string} fileName
 * @property {string} mimeType
 * @property {string} sourceUrl
 * @property {number | null} pageCount
 * @property {import('../types.js').DocumentStatus} status
 * @property {string | null} error
 * @property {number} chunkCount
 * @property {number} processedCount
 * @property {Date | null} parsedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * @typedef {object} ProcessResult
 * @property {string} id
 * @property {import('../types.js').DocumentStatus} status
 * @property {number} processed  chunks embedded so far
 * @property {number} total      total chunks (0 until the file is parsed)
 * @property {string | null} error
 */

/**
 * Text sent to the embedding model. The heading path is prepended so a
 * chunk like "Run the installer." still carries its context ("Install > Windows").
 * The stored chunk text is unchanged.
 * @param {{ text: string, heading: string | null }} chunk
 */
export function embeddingInput(chunk) {
  return chunk.heading ? `${chunk.heading}\n\n${chunk.text}` : chunk.text;
}

/**
 * @param {object} deps
 * @param {IngestRepo} deps.repo
 * @param {import('../embed/index.js').Embedder} deps.embedder
 * @param {import('./fetch-file.js').FetchFile} deps.fetchFile
 * @param {import('./chunker.js').ChunkOptions} [deps.chunkOptions]
 * @param {number} [deps.batchSize=256]  chunks embedded per processNext call
 * @param {(url: string) => boolean} [deps.isSourceUrlAllowed]
 * @param {() => Date} [deps.now]
 */
export function createIngestService({
  repo,
  embedder,
  fetchFile,
  chunkOptions = {},
  batchSize = 256,
  isSourceUrlAllowed = () => true,
  now = () => new Date(),
}) {
  /** @param {string} id */
  const mustGet = async (id) => {
    const doc = await repo.getDocument(id);
    if (!doc) throw new CoreError(ErrorCodes.NOT_FOUND, `Document ${id} not found`);
    return doc;
  };

  /** @param {string} id @param {Partial<DocumentInfo>} set */
  const update = async (id, set) => {
    const doc = await repo.updateDocument(id, { ...set, updatedAt: now() });
    if (!doc) throw new CoreError(ErrorCodes.NOT_FOUND, `Document ${id} not found`);
    return doc;
  };

  /** @param {DocumentInfo} doc @returns {ProcessResult} */
  const result = (doc) => ({
    id: doc.id,
    status: doc.status,
    processed: doc.processedCount,
    total: doc.chunkCount,
    error: doc.error,
  });

  /**
   * Download, parse and chunk the file, then store chunks without embeddings.
   * Permanent problems mark the document failed; retryable ones are thrown.
   * @param {DocumentInfo} doc
   * @returns {Promise<DocumentInfo>}
   */
  async function parseAndStoreChunks(doc) {
    if (doc.status === 'pending') doc = await update(doc.id, { status: 'processing' });
    let drafts;
    let pageCount;
    try {
      const data = await fetchFile(doc.sourceUrl);
      const sections = await parseDocument(data, doc.mimeType);
      const pages = sections.map((s) => s.page).filter((p) => p !== null);
      pageCount = pages.length ? Math.max(...pages) : null;
      drafts = chunkSections(sections, chunkOptions);
      if (drafts.length === 0) {
        throw new CoreError(
          ErrorCodes.PARSE_FAILED,
          'No extractable text found (scanned PDFs need OCR, which is not supported)',
        );
      }
    } catch (err) {
      if (err instanceof CoreError && !err.retryable) {
        return update(doc.id, { status: 'failed', error: err.message });
      }
      throw err;
    }
    const createdAt = now();
    await repo.insertChunks(doc.id, drafts.map((d) => ({ ...d, createdAt })));
    return update(doc.id, { chunkCount: drafts.length, pageCount, parsedAt: createdAt });
  }

  return {
    /**
     * Register a document. Processing happens in processNext().
     * @param {{ url: string, fileName: string }} input
     * @returns {Promise<{ id: string }>}
     */
    async createDocument({ url, fileName }) {
      const mimeType = mimeTypeForFileName(fileName);
      if (!mimeType) {
        throw new CoreError(
          ErrorCodes.UNSUPPORTED_TYPE,
          `Unsupported file type for "${fileName}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
        );
      }
      if (!isSourceUrlAllowed(url)) {
        throw new CoreError(ErrorCodes.INVALID_INPUT, 'url must be https and on an allowed host (see SOURCE_URL_HOSTS)');
      }
      const t = now();
      const id = await repo.insertDocument({
        fileName,
        mimeType,
        sourceUrl: url,
        pageCount: null,
        status: 'pending',
        error: null,
        chunkCount: 0,
        processedCount: 0,
        parsedAt: null,
        createdAt: t,
        updatedAt: t,
      });
      return { id };
    },

    /**
     * Do the next slice of work for a document and report progress.
     * First call: download + parse + chunk + store chunks, then embed a batch.
     * Later calls: embed the next batch of chunks without an embedding.
     * When every chunk has an embedding, status becomes "ready".
     *
     * Safe to call repeatedly or concurrently: chunks are keyed by
     * (docId, chunkIndex) and only chunks without an embedding are picked up.
     * Concurrent calls may embed the same batch twice, which wastes API
     * calls but gives the same result.
     * @param {string} id
     * @returns {Promise<ProcessResult>}
     */
    async processNext(id) {
      let doc = await mustGet(id);
      if (doc.status === 'ready' || doc.status === 'failed') return result(doc);

      if (!doc.parsedAt) {
        doc = await parseAndStoreChunks(doc);
        if (doc.status === 'failed') return result(doc);
      }

      const pending = await repo.findChunksWithoutEmbedding(id, batchSize);
      if (pending.length) {
        const vectors = await embedder.embed(pending.map(embeddingInput), { inputType: 'document' });
        await repo.setEmbeddings(pending.map((c, i) => ({ id: c.id, embedding: vectors[i] })));
      }

      const processed = await repo.countEmbeddedChunks(id);
      if (pending.length === 0 && processed < doc.chunkCount) {
        // Nothing left to embed but chunks are missing (e.g. deleted by hand).
        return result(
          await update(id, {
            status: 'failed',
            processedCount: processed,
            error: `Expected ${doc.chunkCount} chunks but found ${processed}; delete and re-ingest the document`,
          }),
        );
      }
      const done = processed >= doc.chunkCount;
      doc = await update(id, { processedCount: processed, ...(done && { status: 'ready' }) });
      return result(doc);
    },

    /** @param {string} id */
    getDocument: mustGet,

    /** @param {{ limit?: number, cursor?: string, status?: string }} [q] */
    async listDocuments({ limit = 20, cursor, status } = {}) {
      return repo.listDocuments({ limit, cursor, status });
    },

    /** @param {string} id */
    async deleteDocument(id) {
      const deleted = await repo.deleteDocument(id);
      if (!deleted) throw new CoreError(ErrorCodes.NOT_FOUND, `Document ${id} not found`);
    },
  };
}

/** @typedef {ReturnType<typeof createIngestService>} IngestService */
