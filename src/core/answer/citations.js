/**
 * Citation parsing and verification. Pure functions, no I/O.
 *
 * The model is asked to end every factual sentence with one or more
 * markers like [Source 2] or [Source 1, Source 3]. Verification checks:
 *  1. every cited number refers to a source that was actually retrieved;
 *  2. every factual sentence carries at least one citation;
 *  3. each cited sentence shares enough content words with at least one of
 *     the sources it cites (a cheap lexical support check: it catches
 *     citations pointing at the wrong chunk, not subtle misreadings).
 */

export const NO_ANSWER = "I couldn't find this in the provided documents.";

/** Matches [Source 1], [Sources 1, 2], [Source 1, Source 3], [source 2; 4] */
const MARKER = /\[\s*sources?\s*:?\s*(\d+(?:\s*[,;&]\s*(?:and\s+)?(?:sources?\s*)?\d+)*)\s*\]/gi;

const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both
  but by can could did do does doing down during each few for from further had has have having he her here hers him his
  how i if in into is it its itself just me more most my no nor not now of off on once only or other our ours out over own
  same she should so some such than that the their theirs them then there these they this those through to too under
  until up very was we were what when where which while who whom why will with would you your yours source sources
  according document documents provided based`.split(/\s+/),
);

/**
 * All cited source numbers in a piece of text, in order of first appearance.
 * @param {string} text
 * @returns {number[]}
 */
export function extractCitations(text) {
  const out = [];
  for (const m of text.matchAll(MARKER)) {
    for (const d of m[1].match(/\d+/g) ?? []) {
      const n = Number(d);
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** @param {string} text */
export function stripCitations(text) {
  return text.replace(MARKER, '').replace(/\s+([.,;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Lowercased content words, with a light plural/suffix normalisation so
 * "policies" ~ "policy" and "returns" ~ "return".
 * @param {string} text
 * @returns {Set<string>}
 */
export function contentWords(text) {
  const words = text.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set();
  for (let w of words) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    if (/^\d+$/.test(w)) {
      out.add(w);
      continue;
    }
    w = w.replace(/(ies)$/, 'y').replace(/(es|s)$/, (m, _g, i) => (i > 3 ? '' : m));
    out.add(w);
  }
  return out;
}

/**
 * Share of the sentence's content words that appear in the source (0..1).
 * @param {string} sentence
 * @param {string} source
 */
export function supportScore(sentence, source) {
  const s = contentWords(sentence);
  if (s.size === 0) return 1;
  const src = contentWords(source);
  let hit = 0;
  for (const w of s) if (src.has(w)) hit++;
  return hit / s.size;
}

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

/**
 * Split an answer into sentences, keeping citation markers with the
 * sentence they follow ("Foo. [Source 1] Bar." -> "Foo. [Source 1]", "Bar.").
 * Lines (list items, headings) are split separately.
 * @param {string} answer
 * @returns {string[]}
 */
export function splitSentences(answer) {
  const out = [];
  for (const line of answer.split(/\n+/)) {
    for (const { segment } of segmenter.segment(line)) {
      const t = segment.trim();
      if (!t) continue;
      // A segment that is only citation markers belongs to the previous sentence.
      if (out.length && stripCitations(t) === '' ) out[out.length - 1] += ` ${t}`;
      else if (out.length && /^\[\s*sources?/i.test(t)) {
        const m = t.match(/^((?:\[[^\]]*\]\s*)+)(.*)$/s);
        out[out.length - 1] += ` ${m[1].trim()}`;
        if (m[2].trim()) out.push(m[2].trim());
      } else out.push(t);
    }
  }
  return out;
}

/** A sentence that makes no factual claim and needs no citation. */
function needsCitation(sentence) {
  const plain = stripCitations(sentence).replace(/^[\s>*\-#\d.)]+/, '');
  if (contentWords(plain).size < 3) return false; // "Yes.", "In short:", list labels
  if (/:\s*$/.test(plain)) return false; // lead-in to a list
  return true;
}

/**
 * @typedef {object} SentenceCheck
 * @property {string} text
 * @property {number[]} citations
 * @property {number | null} support   best support score among valid cited sources (null if none)
 * @property {boolean} supported
 */

/**
 * @typedef {object} Verification
 * @property {'verified' | 'partial' | 'unverified' | 'no_answer' | 'no_sources'} status
 *   verified: every claim cites a retrieved source that supports it;
 *   partial: some claims are uncited, unsupported or cite unknown sources;
 *   unverified: the answer cites no valid source at all;
 *   no_answer: the model said the documents don't contain the answer;
 *   no_sources: retrieval found nothing, so the model was not called.
 * @property {number[]} citedSources       valid source numbers used, in order
 * @property {number[]} invalidCitations   numbers that don't match any retrieved source
 * @property {number} uncitedSentences
 * @property {number} unsupportedSentences
 * @property {SentenceCheck[]} sentences
 */

/**
 * @param {string} answer
 * @param {{ text: string }[]} sources  in prompt order (Source 1 = sources[0])
 * @param {{ minSupport?: number }} [opts]
 * @returns {Verification}
 */
export function verifyCitations(answer, sources, { minSupport = 0.35 } = {}) {
  const empty = { citedSources: [], invalidCitations: [], uncitedSentences: 0, unsupportedSentences: 0, sentences: [] };
  if (sources.length === 0) return { status: 'no_sources', ...empty };
  if (isNoAnswer(answer)) return { status: 'no_answer', ...empty, invalidCitations: extractCitations(answer).filter((n) => n < 1 || n > sources.length) };

  const cited = extractCitations(answer);
  const invalid = cited.filter((n) => n < 1 || n > sources.length);
  const valid = cited.filter((n) => !invalid.includes(n));

  /** @type {SentenceCheck[]} */
  const sentences = [];
  let uncited = 0;
  let unsupported = 0;
  for (const s of splitSentences(answer)) {
    const nums = extractCitations(s);
    const ok = nums.filter((n) => n >= 1 && n <= sources.length);
    if (nums.length === 0) {
      if (needsCitation(s)) {
        uncited++;
        sentences.push({ text: s, citations: [], support: null, supported: false });
      }
      continue;
    }
    const claim = stripCitations(s);
    const support = ok.length ? Math.max(...ok.map((n) => supportScore(claim, sources[n - 1].text))) : null;
    const supported = support !== null && support >= minSupport;
    if (!supported) unsupported++;
    sentences.push({ text: s, citations: nums, support: support === null ? null : Math.round(support * 100) / 100, supported });
  }

  let status;
  if (valid.length === 0) status = 'unverified';
  else if (invalid.length || uncited || unsupported) status = 'partial';
  else status = 'verified';
  return { status, citedSources: valid, invalidCitations: invalid, uncitedSentences: uncited, unsupportedSentences: unsupported, sentences };
}

/** @param {string} answer */
export function isNoAnswer(answer) {
  const a = stripCitations(answer).toLowerCase();
  return a.startsWith("i couldn't find") || a.startsWith('i could not find') || a.startsWith('i cannot find');
}
