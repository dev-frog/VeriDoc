import { CoreError, ErrorCodes } from '../errors.js';
import { NO_ANSWER, verifyCitations, extractCitations } from './citations.js';

/**
 * @param {{ fileName: string, page: number | null, heading: string | null }} s
 * @returns {string}
 */
export function sourceLabel(s) {
  return [s.fileName, s.page ? `page ${s.page}` : null, s.heading].filter(Boolean).join(' · ');
}

const SYSTEM_PROMPT = `You answer questions using ONLY the numbered sources provided.

Rules:
- Every sentence that states a fact must end with a citation like [Source 2], or [Source 1, Source 3] when several sources support it.
- Only cite sources that directly support the sentence. Never cite a number that isn't in the list.
- Do not use outside knowledge. If the sources don't contain the answer, reply exactly: "${NO_ANSWER}"
- If the sources only partly answer the question, answer that part and say what is missing.
- Be concise. Quote numbers, names and terms exactly as the sources state them.`;

/**
 * @param {string} question
 * @param {import('../search/service.js').SearchResult[]} sources
 * @returns {import('../llm/index.js').ChatMessage[]}
 */
export function buildMessages(question, sources) {
  const blocks = sources.map((s, i) => `[Source ${i + 1}] (${sourceLabel(s)})\n${s.text}`).join('\n\n---\n\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Sources:\n\n${blocks}\n\n---\n\nQuestion: ${question}` },
  ];
}

/**
 * Retrieval-augmented answers with verified [Source N] citations.
 * @param {object} deps
 * @param {import('../search/service.js').SearchService} deps.search
 * @param {import('../llm/index.js').Llm} deps.llm
 * @param {number} [deps.minSupport]
 */
export function createAnswerService({ search, llm, minSupport }) {
  return {
    /**
     * @param {{ question: string, documentIds?: string[], topK?: number, topN?: number }} q
     */
    async ask({ question, documentIds, topK, topN }) {
      const q = question?.trim() ?? '';
      if (!q) throw new CoreError(ErrorCodes.INVALID_INPUT, 'question must not be empty');

      const { results } = await search.search({ query: q, documentIds, topK, topN });
      const sources = results.map((r, i) => ({
        n: i + 1,
        chunkId: r.chunkId,
        documentId: r.documentId,
        fileName: r.fileName,
        page: r.page,
        heading: r.heading,
        text: r.text,
        score: r.score,
      }));

      // Nothing retrieved: don't spend an LLM call on a guaranteed non-answer.
      if (sources.length === 0) {
        return { answer: NO_ANSWER, citations: [], sources, verification: verifyCitations(NO_ANSWER, []), model: null };
      }

      const { text, usage } = await llm.chat(buildMessages(q, sources));
      const verification = verifyCitations(text, sources, { minSupport });
      const citations = extractCitations(text)
        .filter((n) => n >= 1 && n <= sources.length)
        .map((n) => {
          const { text: _t, score: _s, ...rest } = sources[n - 1];
          return { ...rest, label: sourceLabel(rest), snippet: snippet(sources[n - 1].text) };
        });
      return { answer: text, citations, sources, verification, model: llm.model, usage };
    },
  };
}

/** @param {string} text */
function snippet(text, max = 240) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** @typedef {ReturnType<typeof createAnswerService>} AnswerService */
