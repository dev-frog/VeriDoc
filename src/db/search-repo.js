import { ObjectId } from 'mongodb';
import { chunksCollection, COLLECTIONS } from './collections.js';
import { VECTOR_INDEX_NAME, TEXT_INDEX_NAME } from './indexes.js';

/** @param {string} id */
const toObjectId = (id) => (typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null);

/**
 * Build the hybrid search pipeline: Atlas Vector Search and Atlas Search
 * (BM25) fused with $rankFusion (reciprocal rank fusion), then joined with
 * the parent document so only `ready` documents are returned.
 * Exported for unit tests.
 * @param {{ vector: number[], text: string, limit: number, documentIds?: ObjectId[],
 *   weights?: { vector?: number, text?: number } }} q
 * @returns {object[]}
 */
export function hybridSearchPipeline({ vector, text, limit, documentIds, weights = {} }) {
  const textOp = { text: { query: text, path: ['text', 'heading'] } };
  const vectorSearch = {
    index: VECTOR_INDEX_NAME,
    path: 'embedding',
    queryVector: vector,
    numCandidates: Math.min(Math.max(limit * 10, 100), 10_000),
    limit,
    ...(documentIds && { filter: { docId: { $in: documentIds } } }),
  };
  const search = {
    index: TEXT_INDEX_NAME,
    ...(documentIds ? { compound: { must: [textOp], filter: [{ in: { path: 'docId', value: documentIds } }] } } : textOp),
  };
  return [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [{ $vectorSearch: vectorSearch }],
            text: [{ $search: search }, { $limit: limit }],
          },
        },
        combination: { weights: { vector: weights.vector ?? 1, text: weights.text ?? 1 } },
      },
    },
    { $addFields: { _score: { $meta: 'score' } } },
    { $limit: limit },
    {
      $lookup: {
        from: COLLECTIONS.documents,
        localField: 'docId',
        foreignField: '_id',
        as: 'doc',
        pipeline: [{ $project: { fileName: 1, status: 1 } }],
      },
    },
    { $unwind: '$doc' },
    { $match: { 'doc.status': 'ready' } },
    { $project: { _id: 1, docId: 1, chunkIndex: 1, text: 1, page: 1, heading: 1, fileName: '$doc.fileName', score: '$_score' } },
  ];
}

/**
 * @typedef {object} SearchCandidate
 * @property {string} id         chunk id
 * @property {string} docId
 * @property {string} fileName
 * @property {number} chunkIndex
 * @property {string} text
 * @property {number | null} page
 * @property {string | null} heading
 * @property {number} score      fused (RRF) score, higher is better
 */

/**
 * @typedef {object} SearchRepo
 * @property {(q: { vector: number[], text: string, limit: number, documentIds?: string[] }) => Promise<SearchCandidate[]>} hybridSearch
 */

/** @returns {SearchRepo} */
export function createMongoSearchRepo() {
  return {
    async hybridSearch({ vector, text, limit, documentIds }) {
      let ids;
      if (documentIds?.length) {
        ids = documentIds.map(toObjectId).filter(Boolean);
        if (ids.length === 0) return [];
      }
      const rows = await (await chunksCollection())
        .aggregate(hybridSearchPipeline({ vector, text, limit, documentIds: ids }))
        .toArray();
      return rows.map((r) => ({
        id: r._id.toHexString(),
        docId: r.docId.toHexString(),
        fileName: r.fileName,
        chunkIndex: r.chunkIndex,
        text: r.text,
        page: r.page ?? null,
        heading: r.heading ?? null,
        score: r.score ?? 0,
      }));
    },
  };
}
