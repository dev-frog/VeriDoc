import { extractText, getDocumentProxy } from 'unpdf';

/**
 * One section per page, including empty pages (so the highest page number
 * equals the page count). PDFs carry no reliable heading structure, so
 * heading is null.
 * @param {Uint8Array} data
 * @returns {Promise<import('./sections.js').Section[]>}
 */
export async function parsePdf(data) {
  // pdf.js may take ownership of the buffer, so pass a copy.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((pageText, i) => ({ page: i + 1, heading: null, text: cleanPdfText(pageText) }));
  } finally {
    await pdf.destroy?.();
  }
}

/** @param {string} s */
export function cleanPdfText(s) {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/(\w)-\n(\w)/g, '$1$2') // re-join words hyphenated across lines
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
