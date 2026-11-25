import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { onInvalid } from './validation.js';
import { MAX_QUERY_CHARS } from '../../core/search/service.js';

const ObjectIdString = z.string().regex(/^[0-9a-f]{24}$/i, 'must be a 24-character hex id');
const common = {
  documentIds: z.array(ObjectIdString).min(1).max(100).optional(),
  topK: z.number().int().min(1).max(200).optional(),
  topN: z.number().int().min(1).max(50).optional(),
};

const SearchBody = z.object({ query: z.string().trim().min(1).max(MAX_QUERY_CHARS), ...common });
const AskBody = z.object({ question: z.string().trim().min(1).max(MAX_QUERY_CHARS), ...common });

/**
 * POST /search and POST /ask.
 * @param {{ search: import('../../core/search/service.js').SearchService,
 *   answer: import('../../core/answer/service.js').AnswerService }} deps
 * @returns {Hono}
 */
export function queryRoutes({ search, answer }) {
  const r = new Hono();

  r.post('/search', zValidator('json', SearchBody, onInvalid), async (c) => {
    const body = c.req.valid('json');
    const { results, reranker, candidates } = await search.search(body);
    return c.json({ query: body.query, results, reranker, candidates });
  });

  r.post('/ask', zValidator('json', AskBody, onInvalid), async (c) => {
    const body = c.req.valid('json');
    const res = await answer.ask(body);
    return c.json({ question: body.question, ...res });
  });

  return r;
}
