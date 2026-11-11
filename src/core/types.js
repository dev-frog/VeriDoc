/**
 * Shared data shapes. This file has no runtime code; it only exists for JSDoc.
 * `ObjectId` is referenced as a type only, so core stays free of a
 * runtime dependency on the MongoDB driver.
 */

/**
 * @typedef {'pending' | 'processing' | 'ready' | 'failed'} DocumentStatus
 */

/**
 * A source file uploaded to VeriDoc (collection: `documents`).
 * @typedef {object} Document
 * @property {import('mongodb').ObjectId} _id
 * @property {string} fileName      original file name, e.g. "handbook.pdf"
 * @property {string} mimeType      e.g. "application/pdf", "text/markdown"
 * @property {string} sourceUrl     Vercel Blob URL the file was fetched from
 * @property {number | null} pageCount  null for formats without pages (md, txt)
 * @property {DocumentStatus} status
 * @property {string | null} error  set when status is "failed"
 * @property {number} chunkCount      total chunks (0 until parsed)
 * @property {number} processedCount  chunks that have an embedding
 * @property {Date | null} parsedAt   set once chunks are stored
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * One retrievable piece of a document (collection: `chunks`).
 * @typedef {object} Chunk
 * @property {import('mongodb').ObjectId} _id
 * @property {import('mongodb').ObjectId} docId  -> Document._id
 * @property {number} chunkIndex    0-based position within the document
 * @property {string} text
 * @property {number[]} [embedding] length === EMBED_DIMENSIONS; absent until embedded
 * @property {number | null} page   1-based page number, null if unknown
 * @property {string | null} heading  nearest section heading, if any
 * @property {number} tokenCount
 * @property {Date} createdAt
 */

export {};
