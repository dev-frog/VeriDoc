import { blocksToSections } from './sections.js';

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Split Markdown into sections by ATX headings (# ... ######).
 * Headings inside fenced code blocks are ignored; YAML front matter is dropped.
 * Setext headings (underlined with === / ---) are kept as plain text.
 * @param {string} source
 * @returns {import('./sections.js').Section[]}
 */
export function parseMarkdown(source) {
  let lines = source.replace(/\r\n?/g, '\n').split('\n');

  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) lines = lines.slice(end + 1);
  }

  return blocksToSections(markdownBlocks(lines));
}

/** @param {string[]} lines */
function* markdownBlocks(lines) {
  /** @type {string | null} */
  let fence = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      yield { type: 'line', text: line };
      continue;
    }
    const h = fence === null ? HEADING.exec(line) : null;
    if (h && h[2].trim()) {
      yield { type: 'heading', level: h[1].length, title: h[2].trim() };
    } else {
      yield { type: 'line', text: line };
    }
  }
}
