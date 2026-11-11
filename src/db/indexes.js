/**
 * Index definitions for the chunks and documents collections, plus helpers
 * that create them idempotently. The helpers take a collection object, so
 * they can be unit-tested with fakes.
 *
 * Atlas docs to check if anything here fails:
 *  - Vector index: https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-type/
 *  - Search index: https://www.mongodb.com/docs/atlas/atlas-search/define-field-mappings/
 *  - Driver API:   https://www.mongodb.com/docs/drivers/node/current/indexes/#atlas-search-and-vector-search-indexes
 */

export const VECTOR_INDEX_NAME = 'chunks_vector';
export const TEXT_INDEX_NAME = 'chunks_text';

/**
 * @typedef {object} SearchIndexSpec
 * @property {string} name
 * @property {'vectorSearch' | 'search'} type
 * @property {object} definition
 */

/**
 * Atlas Vector Search index on chunks.embedding, with docId as a pre-filter.
 * @param {number} dimensions  must match EMBED_DIMENSIONS
 * @returns {SearchIndexSpec}
 */
export function vectorIndexSpec(dimensions) {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192) {
    throw new RangeError(`vector dimensions must be an integer in 1..8192, got ${dimensions}`);
  }
  return {
    name: VECTOR_INDEX_NAME,
    type: 'vectorSearch',
    definition: {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: dimensions, similarity: 'cosine' },
        { type: 'filter', path: 'docId' },
      ],
    },
  };
}

/**
 * Atlas Search (BM25) index on chunks.text and chunks.heading.
 * docId is also indexed (as objectId) so that full-text search can be
 * filtered to the same documents as vector search.
 * @returns {SearchIndexSpec}
 */
export function textIndexSpec() {
  return {
    name: TEXT_INDEX_NAME,
    type: 'search',
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          text: { type: 'string', analyzer: 'lucene.standard' },
          heading: { type: 'string', analyzer: 'lucene.standard' },
          docId: { type: 'objectId' },
        },
      },
    },
  };
}

/**
 * @param {{ EMBED_DIMENSIONS: number }} config
 * @returns {SearchIndexSpec[]}
 */
export function chunkSearchIndexSpecs(config) {
  return [vectorIndexSpec(config.EMBED_DIMENSIONS), textIndexSpec()];
}

/** Regular (B-tree) indexes, keyed by collection name. */
export const REGULAR_INDEXES = Object.freeze({
  chunks: [{ key: { docId: 1, chunkIndex: 1 }, name: 'docId_chunkIndex', unique: true }],
  documents: [{ key: { createdAt: -1 }, name: 'createdAt_desc' }],
});

/**
 * Create a search index unless one with that name exists. If it exists and
 * `update` is true, replace its definition.
 * @param {Pick<import('mongodb').Collection, 'listSearchIndexes' | 'createSearchIndex' | 'updateSearchIndex'>} coll
 * @param {SearchIndexSpec} spec
 * @param {{ update?: boolean }} [opts]
 * @returns {Promise<'created' | 'updated' | 'exists'>}
 */
export async function ensureSearchIndex(coll, spec, { update = false } = {}) {
  const existing = await coll.listSearchIndexes(spec.name).toArray();
  if (existing.length === 0) {
    await coll.createSearchIndex(spec);
    return 'created';
  }
  if (update) {
    await coll.updateSearchIndex(spec.name, spec.definition);
    return 'updated';
  }
  return 'exists';
}

/**
 * Report the differences that matter between a live vector index and the
 * expected spec (dimensions and similarity). Returns [] when they match.
 * @param {any} latestDefinition  from listSearchIndexes()
 * @param {SearchIndexSpec} spec
 * @returns {string[]}
 */
export function vectorIndexDrift(latestDefinition, spec) {
  const want = spec.definition.fields.find((f) => f.type === 'vector');
  const have = latestDefinition?.fields?.find((f) => f.type === 'vector');
  if (!have) return ['no vector field in live index'];
  const out = [];
  if (have.numDimensions !== want.numDimensions) {
    out.push(`numDimensions is ${have.numDimensions}, expected ${want.numDimensions}`);
  }
  if (have.similarity !== want.similarity) {
    out.push(`similarity is ${have.similarity}, expected ${want.similarity}`);
  }
  return out;
}

/**
 * Poll until every named search index is READY and queryable.
 * @param {Pick<import('mongodb').Collection, 'listSearchIndexes'>} coll
 * @param {string[]} names
 * @param {{ timeoutMs?: number, intervalMs?: number,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   onPoll?: (statuses: Record<string, string>) => void }} [opts]
 * @returns {Promise<void>}
 */
export async function waitForSearchIndexes(
  coll,
  names,
  {
    timeoutMs = 10 * 60_000,
    intervalMs = 5_000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    onPoll = () => {},
  } = {},
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const all = await coll.listSearchIndexes().toArray();
    /** @type {Record<string, string>} */
    const statuses = {};
    let allReady = true;
    for (const name of names) {
      const idx = all.find((i) => i.name === name);
      const status = idx?.status ?? 'MISSING';
      statuses[name] = idx?.queryable && status === 'READY' ? 'READY' : status;
      if (status === 'FAILED') {
        throw new Error(`Search index "${name}" FAILED to build. Check the Atlas UI for details.`);
      }
      if (statuses[name] !== 'READY') allReady = false;
    }
    onPoll(statuses);
    if (allReady) return;
    if (now() >= deadline) {
      throw new Error(`Timed out waiting for search indexes: ${JSON.stringify(statuses)}`);
    }
    await sleep(intervalMs);
  }
}
