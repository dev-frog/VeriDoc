import { countTokens as defaultCountTokens } from './tokens.js';

/**
 * @typedef {object} ChunkDraft
 * @property {number} chunkIndex   0-based, sequential across the whole document
 * @property {string} text
 * @property {number | null} page
 * @property {string | null} heading
 * @property {number} tokenCount
 */

/**
 * @typedef {object} ChunkOptions
 * @property {number} [maxTokens=600]   target upper bound per chunk
 * @property {number} [overlap=0.12]    fraction of maxTokens repeated from the previous chunk
 * @property {(text: string) => number} [countTokens]
 */

/** @typedef {{ raw: string, tokens: number }} Unit */

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

/**
 * Heading-aware chunker.
 * - Never crosses a section boundary, so every chunk has exactly one page
 *   and one heading.
 * - Packs whole sentences up to maxTokens. A sentence is only split when
 *   it alone is longer than maxTokens (split at word boundaries).
 * - Overlap repeats whole trailing sentences from the previous chunk, up to
 *   floor(maxTokens * overlap) tokens. A sentence that doesn't fit is not
 *   carried over (no partial sentences).
 * - Whitespace (newlines, paragraph breaks, list layout) inside a chunk is
 *   preserved.
 * @param {import('./parsers/sections.js').Section[]} sections
 * @param {ChunkOptions} [opts]
 * @returns {ChunkDraft[]}
 */
export function chunkSections(sections, { maxTokens = 600, overlap = 0.12, countTokens = defaultCountTokens } = {}) {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new RangeError('maxTokens must be a positive integer');
  if (!(overlap >= 0 && overlap < 1)) throw new RangeError('overlap must be in [0, 1)');
  const overlapTokens = Math.floor(maxTokens * overlap);

  /** @type {ChunkDraft[]} */
  const out = [];
  for (const section of sections) {
    const units = toUnits(section.text ?? '', maxTokens, countTokens);
    for (const group of packUnits(units, maxTokens, overlapTokens)) {
      const text = group.map((u) => u.raw).join('').trim();
      if (!text) continue;
      out.push({
        chunkIndex: out.length,
        text,
        page: section.page ?? null,
        heading: section.heading ?? null,
        tokenCount: countTokens(text),
      });
    }
  }
  return out;
}

/**
 * Split text into sentence units, keeping each sentence's trailing
 * whitespace so that joining units restores the original layout.
 * @param {string} text
 * @param {number} maxTokens
 * @param {(t: string) => number} countTokens
 * @returns {Unit[]}
 */
export function toUnits(text, maxTokens, countTokens) {
  /** @type {Unit[]} */
  const units = [];
  for (const { segment } of segmenter.segment(text)) {
    if (!segment.trim()) {
      // whitespace-only segment: attach to the previous unit
      if (units.length) units[units.length - 1].raw += segment;
      continue;
    }
    const tokens = countTokens(segment.trim());
    if (tokens <= maxTokens) units.push({ raw: segment, tokens });
    else units.push(...splitLongSentence(segment, maxTokens, countTokens));
  }
  return units;
}

/**
 * Last resort for a sentence longer than maxTokens: split at word
 * boundaries; a single word longer than maxTokens is split by characters.
 * @param {string} sentence
 * @param {number} maxTokens
 * @param {(t: string) => number} countTokens
 * @returns {Unit[]}
 */
function splitLongSentence(sentence, maxTokens, countTokens) {
  /** @type {Unit[]} */
  const words = [];
  for (const w of sentence.match(/\S+\s*/g) ?? []) {
    const tokens = countTokens(w.trim());
    if (tokens <= maxTokens) {
      words.push({ raw: w, tokens });
      continue;
    }
    const step = Math.max(1, Math.floor((w.length * maxTokens) / tokens));
    for (let i = 0; i < w.length; i += step) {
      const raw = w.slice(i, i + step);
      words.push({ raw, tokens: countTokens(raw.trim()) });
    }
  }
  /** @type {Unit[]} */
  const out = [];
  let cur = { raw: '', tokens: 0 };
  for (const w of words) {
    if (cur.raw && cur.tokens + w.tokens > maxTokens) {
      out.push(cur);
      cur = { raw: '', tokens: 0 };
    }
    cur.raw += w.raw;
    cur.tokens += w.tokens;
  }
  if (cur.raw) out.push(cur);
  return out;
}

/**
 * Greedy packing with sentence-level overlap.
 * @param {Unit[]} units
 * @param {number} maxTokens
 * @param {number} overlapTokens
 * @returns {Unit[][]}
 */
export function packUnits(units, maxTokens, overlapTokens) {
  /** @type {Unit[][]} */
  const chunks = [];
  /** @type {Unit[]} */
  let cur = [];
  let curTokens = 0;

  for (const u of units) {
    if (cur.length && curTokens + u.tokens > maxTokens) {
      chunks.push(cur);
      // Carry trailing whole sentences, but never the entire previous chunk.
      /** @type {Unit[]} */
      const carry = [];
      let t = 0;
      for (let i = cur.length - 1; i >= 1; i--) {
        if (t + cur[i].tokens > overlapTokens) break;
        carry.unshift(cur[i]);
        t += cur[i].tokens;
      }
      while (carry.length && t + u.tokens > maxTokens) t -= /** @type {Unit} */ (carry.shift()).tokens;
      cur = carry;
      curTokens = t;
    }
    cur.push(u);
    curTokens += u.tokens;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
