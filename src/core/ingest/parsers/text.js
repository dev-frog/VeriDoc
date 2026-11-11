/**
 * Plain text has no structure: one section, no page, no heading.
 * @param {string} source
 * @returns {import('./sections.js').Section[]}
 */
export function parseText(source) {
  const text = source.replace(/\r\n?/g, '\n').trim();
  return text ? [{ page: null, heading: null, text }] : [];
}
