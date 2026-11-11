export const MIME = Object.freeze({
  pdf: 'application/pdf',
  markdown: 'text/markdown',
  text: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

const BY_EXTENSION = Object.freeze({
  '.pdf': MIME.pdf,
  '.md': MIME.markdown,
  '.markdown': MIME.markdown,
  '.txt': MIME.text,
  '.docx': MIME.docx,
});

export const SUPPORTED_EXTENSIONS = Object.freeze(Object.keys(BY_EXTENSION));

/**
 * @param {string} fileName
 * @returns {string | null} MIME type, or null if the extension isn't supported
 */
export function mimeTypeForFileName(fileName) {
  const m = /\.[^./\\]+$/.exec(fileName.toLowerCase());
  return (m && BY_EXTENSION[m[0]]) || null;
}
