import mammoth from 'mammoth';
import { blocksToSections } from './sections.js';

/**
 * DOCX -> HTML (mammoth maps Word heading styles to <h1>..<h6>) -> sections.
 * Word files have no fixed pages, so page is null.
 * @param {Uint8Array} data
 * @returns {Promise<import('./sections.js').Section[]>}
 */
export async function parseDocx(data) {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const { value: html } = await mammoth.convertToHtml({ buffer });
  return htmlToSections(html);
}

/**
 * Convert mammoth's simple HTML into sections. Not a general HTML parser:
 * it relies on mammoth emitting flat, well-formed block tags.
 * @param {string} html
 * @returns {import('./sections.js').Section[]}
 */
export function htmlToSections(html) {
  /** @type {import('./sections.js').Block[]} */
  const blocks = [];
  const parts = html.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/i);
  for (const part of parts) {
    const h = /^<h([1-6])[^>]*>([\s\S]*?)<\/h\1>$/i.exec(part);
    if (h) {
      const title = inlineText(h[2]);
      if (title) blocks.push({ type: 'heading', level: Number(h[1]), title });
      continue;
    }
    for (const line of blockText(part).split('\n')) blocks.push({ type: 'line', text: line });
  }
  return blocksToSections(blocks);
}

/** @param {string} html */
function blockText(html) {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(p|tr|table|ul|ol|blockquote|pre)>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n');
  return decodeEntities(text.replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n\n');
}

/** @param {string} html */
function inlineText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** @param {string} s */
export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
