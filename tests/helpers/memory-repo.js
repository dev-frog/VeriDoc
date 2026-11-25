/**
 * In-memory IngestRepo for tests. Mirrors the Mongo repo's contract,
 * including ignoring duplicate (docId, chunkIndex) inserts.
 * @returns {import('../../src/core/ingest/service.js').IngestRepo & { docs: Map<string, any>, chunks: Map<string, any> }}
 */
export function createMemoryRepo() {
  const docs = new Map();
  const chunks = new Map();
  let seq = 0;
  const nextId = () => (++seq).toString(16).padStart(24, '0');
  const clone = (d) => (d ? structuredClone(d) : null);

  return {
    docs,
    chunks,
    async insertDocument(doc) {
      const id = nextId();
      docs.set(id, { ...doc, id });
      return id;
    },
    async getDocument(id) {
      return clone(docs.get(id));
    },
    async listDocuments({ limit, cursor, status }) {
      let all = [...docs.values()].sort((a, b) => (a.id < b.id ? 1 : -1));
      if (status) all = all.filter((d) => d.status === status);
      if (cursor) all = all.filter((d) => d.id < cursor);
      const items = all.slice(0, limit).map(clone);
      return { items, nextCursor: all.length > limit ? items[items.length - 1].id : null };
    },
    async updateDocument(id, set) {
      const d = docs.get(id);
      if (!d) return null;
      Object.assign(d, set);
      return clone(d);
    },
    async deleteDocument(id) {
      for (const [cid, c] of chunks) if (c.docId === id) chunks.delete(cid);
      return docs.delete(id);
    },
    async insertChunks(docId, list) {
      for (const c of list) {
        const exists = [...chunks.values()].some((x) => x.docId === docId && x.chunkIndex === c.chunkIndex);
        if (!exists) {
          const id = nextId();
          chunks.set(id, { ...c, id, docId });
        }
      }
    },
    async findChunksWithoutEmbedding(docId, limit) {
      return [...chunks.values()]
        .filter((c) => c.docId === docId && !c.embedding)
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .slice(0, limit)
        .map((c) => ({ id: c.id, text: c.text, heading: c.heading }));
    },
    async setEmbeddings(items) {
      for (const { id, embedding } of items) {
        const c = chunks.get(id);
        if (c) c.embedding = embedding;
      }
    },
    async countEmbeddedChunks(docId) {
      return [...chunks.values()].filter((c) => c.docId === docId && c.embedding).length;
    },

    /** Same contract as the Mongo SearchRepo: cosine + keyword ranks fused with RRF (k=60), ready docs only. */
    async hybridSearch({ vector, text, limit, documentIds }) {
      const pool = [...chunks.values()].filter(
        (c) => docs.get(c.docId)?.status === 'ready' && (!documentIds?.length || documentIds.includes(c.docId)),
      );
      const cos = (a, b) => {
        let d = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
        return na && nb ? d / Math.sqrt(na * nb) : 0;
      };
      const terms = text.toLowerCase().match(/\w+/g) ?? [];
      const byVector = pool.filter((c) => c.embedding).map((c) => ({ c, s: cos(vector, c.embedding) }));
      const byText = pool
        .map((c) => ({ c, s: terms.filter((t) => `${c.heading ?? ''} ${c.text}`.toLowerCase().includes(t)).length }))
        .filter((x) => x.s > 0);
      const fused = new Map();
      for (const list of [byVector, byText]) {
        list.sort((a, b) => b.s - a.s).slice(0, limit).forEach(({ c }, i) => {
          fused.set(c.id, { c, score: (fused.get(c.id)?.score ?? 0) + 1 / (60 + i + 1) });
        });
      }
      return [...fused.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ c, score }) => ({
          id: c.id, docId: c.docId, fileName: docs.get(c.docId).fileName, chunkIndex: c.chunkIndex,
          text: c.text, page: c.page ?? null, heading: c.heading ?? null, score,
        }));
    },
  };
}
