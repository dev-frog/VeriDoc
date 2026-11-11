import { ObjectId } from 'mongodb';
import { documentsCollection, chunksCollection } from './collections.js';

/** @param {string} id @returns {ObjectId | null} */
function toObjectId(id) {
  return typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;
}

/** @param {any} doc @returns {import('../core/ingest/service.js').DocumentInfo | null} */
function toInfo(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toHexString(), processedCount: 0, parsedAt: null, ...rest };
}

/** @param {unknown} err */
function isOnlyDuplicateKeyErrors(err) {
  const e = /** @type {any} */ (err);
  if (e?.code === 11000) return true;
  const writeErrors = e?.writeErrors ? [].concat(e.writeErrors) : [];
  return writeErrors.length > 0 && writeErrors.every((w) => (w.code ?? w.err?.code) === 11000);
}

/**
 * MongoDB implementation of the core IngestRepo.
 * @returns {import('../core/ingest/service.js').IngestRepo & {
 *   findDocumentBySourceUrl: (url: string) => Promise<import('../core/ingest/service.js').DocumentInfo | null> }}
 */
export function createMongoIngestRepo() {
  return {
    async insertDocument(doc) {
      const { insertedId } = await (await documentsCollection()).insertOne({ ...doc });
      return insertedId.toHexString();
    },

    async getDocument(id) {
      const _id = toObjectId(id);
      return _id ? toInfo(await (await documentsCollection()).findOne({ _id })) : null;
    },

    async listDocuments({ limit, cursor, status }) {
      /** @type {Record<string, unknown>} */
      const filter = {};
      if (status) filter.status = status;
      const after = cursor ? toObjectId(cursor) : null;
      if (after) filter._id = { $lt: after };
      const docs = await (await documentsCollection())
        .find(filter)
        .sort({ _id: -1 })
        .limit(limit + 1)
        .toArray();
      const items = docs.slice(0, limit).map(toInfo);
      return { items, nextCursor: docs.length > limit ? items[items.length - 1].id : null };
    },

    async updateDocument(id, set) {
      const _id = toObjectId(id);
      if (!_id) return null;
      const doc = await (await documentsCollection()).findOneAndUpdate(
        { _id },
        { $set: set },
        { returnDocument: 'after' },
      );
      return toInfo(doc);
    },

    async deleteDocument(id) {
      const _id = toObjectId(id);
      if (!_id) return false;
      // Chunks first: a leftover document is visible and can be deleted again;
      // leftover chunks would silently stay searchable.
      await (await chunksCollection()).deleteMany({ docId: _id });
      const { deletedCount } = await (await documentsCollection()).deleteOne({ _id });
      return deletedCount > 0;
    },

    async insertChunks(docId, chunks) {
      const _docId = toObjectId(docId);
      if (!_docId || chunks.length === 0) return;
      try {
        await (await chunksCollection()).insertMany(
          chunks.map((c) => ({ ...c, docId: _docId })),
          { ordered: false },
        );
      } catch (err) {
        // The unique (docId, chunkIndex) index rejects chunks a previous or
        // concurrent call already inserted. That's expected; anything else isn't.
        if (!isOnlyDuplicateKeyErrors(err)) throw err;
      }
    },

    async findChunksWithoutEmbedding(docId, limit) {
      const _docId = toObjectId(docId);
      if (!_docId) return [];
      const rows = await (await chunksCollection())
        .find({ docId: _docId, embedding: { $exists: false } }, { projection: { text: 1, heading: 1 } })
        .sort({ chunkIndex: 1 })
        .limit(limit)
        .toArray();
      return rows.map((r) => ({ id: r._id.toHexString(), text: r.text, heading: r.heading ?? null }));
    },

    async setEmbeddings(items) {
      if (items.length === 0) return;
      await (await chunksCollection()).bulkWrite(
        items.map(({ id, embedding }) => ({
          updateOne: { filter: { _id: new ObjectId(id) }, update: { $set: { embedding } } },
        })),
        { ordered: false },
      );
    },

    async countEmbeddedChunks(docId) {
      const _docId = toObjectId(docId);
      if (!_docId) return 0;
      return (await chunksCollection()).countDocuments({ docId: _docId, embedding: { $exists: true } });
    },

    async findDocumentBySourceUrl(url) {
      return toInfo(await (await documentsCollection()).findOne({ sourceUrl: url }, { sort: { _id: -1 } }));
    },
  };
}
