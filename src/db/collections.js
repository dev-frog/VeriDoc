import { getDb } from './client.js';

export const COLLECTIONS = Object.freeze({
  documents: 'documents',
  chunks: 'chunks',
});

/** @returns {Promise<import('mongodb').Collection<import('../core/types.js').Document>>} */
export async function documentsCollection() {
  return (await getDb()).collection(COLLECTIONS.documents);
}

/** @returns {Promise<import('mongodb').Collection<import('../core/types.js').Chunk>>} */
export async function chunksCollection() {
  return (await getDb()).collection(COLLECTIONS.chunks);
}
