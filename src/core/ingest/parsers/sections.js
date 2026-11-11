/**
 * @typedef {object} Section
 * @property {number | null} page     1-based page number, null if the format has no pages
 * @property {string | null} heading  heading path, e.g. "Install > Linux", null if none
 * @property {string} text
 */

/**
 * @typedef {{ type: 'heading', level: number, title: string } | { type: 'line', text: string }} Block
 */

/**
 * Turn a flat stream of headings and text lines into sections. Each section
 * carries the full heading path ("H1 > H2 > H3") of the text under it.
 * Headings with no text directly under them produce no section.
 * @param {Iterable<Block>} blocks
 * @returns {Section[]}
 */
export function blocksToSections(blocks) {
  /** @type {Section[]} */
  const sections = [];
  /** @type {{ level: number, title: string }[]} */
  const stack = [];
  /** @type {string[]} */
  let buf = [];

  const flush = () => {
    const text = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text) {
      sections.push({ page: null, heading: stack.length ? stack.map((h) => h.title).join(' > ') : null, text });
    }
    buf = [];
  };

  for (const b of blocks) {
    if (b.type === 'heading') {
      flush();
      while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop();
      stack.push({ level: b.level, title: b.title });
    } else {
      buf.push(b.text);
    }
  }
  flush();
  return sections;
}
