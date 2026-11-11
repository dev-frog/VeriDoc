import { CoreError, ErrorCodes } from '../../errors.js';
import { MIME } from '../file-types.js';
import { parsePdf } from './pdf.js';
import { parseDocx } from './docx.js';
import { parseMarkdown } from './markdown.js';
import { parseText } from './text.js';

/**
 * @param {Uint8Array} data
 * @param {string} mimeType
 * @returns {Promise<import('./sections.js').Section[]>}
 */
export async function parseDocument(data, mimeType) {
  try {
    switch (mimeType) {
      case MIME.pdf:
        return await parsePdf(data);
      case MIME.docx:
        return await parseDocx(data);
      case MIME.markdown:
        return parseMarkdown(decodeUtf8(data));
      case MIME.text:
        return parseText(decodeUtf8(data));
    }
  } catch (err) {
    throw new CoreError(ErrorCodes.PARSE_FAILED, `Could not parse ${mimeType} file: ${err.message}`, { cause: err });
  }
  throw new CoreError(ErrorCodes.UNSUPPORTED_TYPE, `Unsupported file type: ${mimeType}`);
}

/** @param {Uint8Array} data */
function decodeUtf8(data) {
  return new TextDecoder('utf-8').decode(data); // strips a leading BOM
}

export { parsePdf, parseDocx, parseMarkdown, parseText };
export { htmlToSections } from './docx.js';
