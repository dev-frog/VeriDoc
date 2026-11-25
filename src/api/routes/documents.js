import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { onInvalid } from './validation.js';

const CreateBody = z.object({
  url: z.url({ protocol: /^https$/, error: 'must be an https URL' }),
  fileName: z.string().trim().min(1).max(255),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  status: z.enum(['pending', 'processing', 'ready', 'failed']).optional(),
});

/** @param {import('../../core/ingest/service.js').DocumentInfo} d */
export function toDocumentJson(d) {
  return {
    id: d.id,
    fileName: d.fileName,
    mimeType: d.mimeType,
    sourceUrl: d.sourceUrl,
    pageCount: d.pageCount,
    status: d.status,
    error: d.error,
    chunkCount: d.chunkCount,
    processedCount: d.processedCount,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/**
 * @param {import('../../core/ingest/service.js').IngestService} ingest
 * @returns {Hono}
 */
export function documentRoutes(ingest) {
  const r = new Hono();

  r.post('/', zValidator('json', CreateBody, onInvalid), async (c) => {
    const { id } = await ingest.createDocument(c.req.valid('json'));
    return c.json({ id, status: 'pending' }, 202, { Location: `/documents/${id}` });
  });

  r.get('/', zValidator('query', ListQuery, onInvalid), async (c) => {
    const { items, nextCursor } = await ingest.listDocuments(c.req.valid('query'));
    return c.json({ items: items.map(toDocumentJson), nextCursor });
  });

  r.get('/:id', async (c) => c.json(toDocumentJson(await ingest.getDocument(c.req.param('id')))));

  r.post('/:id/process', async (c) => {
    const { status, processed, total, error } = await ingest.processNext(c.req.param('id'));
    return c.json({ status, processed, total, ...(error && { error }) });
  });

  r.delete('/:id', async (c) => {
    const id = c.req.param('id');
    await ingest.deleteDocument(id);
    return c.json({ id, deleted: true });
  });

  return r;
}
