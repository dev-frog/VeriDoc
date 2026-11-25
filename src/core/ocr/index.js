import { createChatClient } from '../llm/index.js';
import { parseMarkdown } from '../ingest/parsers/markdown.js';

/**
 * @typedef {object} Ocr
 * @property {string} name
 * @property {(data: Uint8Array, fileName: string) => Promise<import('../ingest/parsers/sections.js').Section[]>} ocrPdf
 */

export const OCR_PROMPT = `Transcribe every page of this PDF into plain Markdown.
- Start each page with a line "=== Page N ===" (N = page number, starting at 1), even if the page is blank.
- Keep the reading order. Use # / ## / ### for headings that look like headings.
- Render tables as Markdown tables. Skip page headers/footers that repeat on every page.
- Output only the transcription: no comments, no summaries, no code fences.`;

/**
 * Average non-whitespace characters per page below which a PDF is treated
 * as scanned (no usable text layer). Page numbers or a stray header on an
 * image-only page stay well under this.
 */
export const MIN_CHARS_PER_PAGE = 40;

/**
 * Does this parsed PDF need OCR?
 * @param {import('../ingest/parsers/sections.js').Section[]} sections  from parsePdf (one per page)
 */
export function needsOcr(sections) {
  const pages = Math.max(1, sections.length);
  const chars = sections.reduce((n, s) => n + s.text.replace(/\s+/g, '').length, 0);
  return chars / pages < MIN_CHARS_PER_PAGE;
}

/**
 * Split OCR output on "=== Page N ===" markers into page sections, keeping
 * Markdown headings as heading paths within each page.
 * @param {string} text
 * @returns {import('../ingest/parsers/sections.js').Section[]}
 */
export function ocrTextToSections(text) {
  const cleaned = text.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, '$1');
  const marker = /^[ \t]*=+[ \t]*page[ \t]+(\d+)[ \t]*=+[ \t]*$/gim;
  const parts = [];
  let last = null;
  for (const m of cleaned.matchAll(marker)) {
    if (last) parts.push({ page: last.page, body: cleaned.slice(last.end, m.index) });
    last = { page: Number(m[1]), end: m.index + m[0].length };
  }
  if (last) parts.push({ page: last.page, body: cleaned.slice(last.end) });
  else parts.push({ page: null, body: cleaned });

  return parts.flatMap(({ page, body }) => parseMarkdown(body).map((s) => ({ ...s, page })));
}

/**
 * OCR by sending the PDF to a chat model that accepts files, through any
 * OpenAI-compatible API. On OpenRouter this works with any model: PDFs are
 * parsed natively or by the engine in OCR_PDF_ENGINE (e.g. mistral-ocr).
 * @param {{ baseUrl: string, apiKey?: string, model?: string, pdfEngine?: string,
 *   http?: import('../http.js').RetryOptions }} opts
 * @returns {Ocr}
 */
export function createChatOcr({ baseUrl, apiKey, model, pdfEngine, http }) {
  const client = createChatClient({ baseUrl, apiKey, model, keyName: 'OCR_API_KEY', http: { timeoutMs: 240_000, retries: 2, ...http } });
  return {
    name: `${model}${pdfEngine ? ` (${pdfEngine})` : ''}`,
    async ocrPdf(data, fileName) {
      const fileData = `data:application/pdf;base64,${Buffer.from(data).toString('base64')}`;
      const { text } = await client.chat(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: OCR_PROMPT },
              { type: 'file', file: { filename: fileName || 'document.pdf', file_data: fileData } },
            ],
          },
        ],
        { extra: pdfEngine ? { plugins: [{ id: 'file-parser', pdf: { engine: pdfEngine } }] } : {} },
      );
      return ocrTextToSections(text);
    },
  };
}

/**
 * @param {{ OCR_PROVIDER: 'none' | 'openai-compatible', OCR_BASE_URL: string, OCR_API_KEY?: string,
 *   OCR_MODEL?: string, OCR_PDF_ENGINE?: string }} config
 * @returns {Ocr | null}  null when OCR is disabled
 */
export function createOcr(config, { http } = {}) {
  if (config.OCR_PROVIDER !== 'openai-compatible') return null;
  return createChatOcr({
    baseUrl: config.OCR_BASE_URL,
    apiKey: config.OCR_API_KEY,
    model: config.OCR_MODEL,
    pdfEngine: config.OCR_PDF_ENGINE,
    http,
  });
}
