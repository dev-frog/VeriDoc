/**
 * Retrieval and answer metrics for `pnpm eval`. Pure functions (tested).
 *
 * Dataset line (JSONL):
 *   { "question": "...", "files": ["API.md"], "pages": [2], "answerContains": ["415"] }
 * - files:  documents that contain the answer (matched case-insensitively against
 *           fileName, also as a path suffix). [] = unanswerable: the right answer is
 *           "not in the documents".
 * - pages:  optional; a result only counts if it is also on one of these pages.
 * - answerContains: optional strings the answer must contain (case-insensitive).
 */

/**
 * @typedef {object} EvalCase
 * @property {string} question
 * @property {string[]} [files]
 * @property {number[]} [pages]
 * @property {string[]} [answerContains]
 * @property {string} [id]
 */

/**
 * @param {string} line
 * @param {number} lineNo
 * @returns {EvalCase | null}
 */
export function parseCase(line, lineNo) {
  const t = line.trim();
  if (!t || t.startsWith('//') || t.startsWith('#')) return null;
  let c;
  try {
    c = JSON.parse(t);
  } catch (err) {
    throw new Error(`line ${lineNo}: invalid JSON (${err.message})`);
  }
  if (typeof c.question !== 'string' || !c.question.trim()) throw new Error(`line ${lineNo}: "question" is required`);
  for (const k of ['files', 'answerContains']) {
    if (c[k] !== undefined && !(Array.isArray(c[k]) && c[k].every((x) => typeof x === 'string'))) {
      throw new Error(`line ${lineNo}: "${k}" must be an array of strings`);
    }
  }
  if (c.pages !== undefined && !(Array.isArray(c.pages) && c.pages.every(Number.isInteger))) {
    throw new Error(`line ${lineNo}: "pages" must be an array of integers`);
  }
  return { id: c.id ?? `q${lineNo}`, ...c };
}

/** @param {string} fileName @param {string} expected */
const sameFile = (fileName, expected) => {
  const a = fileName.toLowerCase().replace(/\\/g, '/');
  const b = expected.toLowerCase().replace(/\\/g, '/');
  return a === b || a.endsWith(`/${b}`);
};

/**
 * @param {{ fileName: string, page: number | null }} result
 * @param {EvalCase} c
 */
export function isRelevant(result, c) {
  if (!c.files?.length) return false;
  if (!c.files.some((f) => sameFile(result.fileName, f))) return false;
  return !c.pages?.length || (result.page !== null && c.pages.includes(result.page));
}

/**
 * @param {{ fileName: string, page: number | null }[]} results  ranked
 * @param {EvalCase} c
 */
export function retrievalMetrics(results, c) {
  if (!c.files?.length) return { answerable: false, firstRelevantRank: null, hit1: null, hitK: null, rr: null, fileRecall: null };
  const idx = results.findIndex((r) => isRelevant(r, c));
  const found = c.files.filter((f) => results.some((r) => isRelevant({ ...r, fileName: r.fileName }, { ...c, files: [f] })));
  return {
    answerable: true,
    firstRelevantRank: idx === -1 ? null : idx + 1,
    hit1: idx === 0,
    hitK: idx !== -1,
    rr: idx === -1 ? 0 : 1 / (idx + 1),
    fileRecall: found.length / c.files.length,
  };
}

/**
 * @param {any} ask  POST /ask response
 * @param {EvalCase} c
 */
export function answerMetrics(ask, c) {
  const status = ask.verification?.status;
  const refused = status === 'no_answer' || status === 'no_sources';
  const contains = c.answerContains?.length
    ? c.answerContains.every((s) => ask.answer.toLowerCase().includes(s.toLowerCase()))
    : null;
  const answerable = Boolean(c.files?.length);
  return {
    status,
    correctRefusal: answerable ? null : refused,
    answered: answerable ? !refused : null,
    contains: answerable ? contains : null,
    citedRelevant: answerable ? (ask.citations ?? []).some((cit) => isRelevant(cit, c)) : null,
  };
}

/** Mean of the non-null values, or null if there are none. */
const mean = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined).map(Number);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/**
 * @param {{ retrieval: ReturnType<typeof retrievalMetrics>, answer?: ReturnType<typeof answerMetrics> }[]} rows
 */
export function summarize(rows) {
  const r = rows.map((x) => x.retrieval);
  const a = rows.map((x) => x.answer).filter(Boolean);
  const summary = {
    questions: rows.length,
    answerable: r.filter((x) => x.answerable).length,
    hitAt1: mean(r.map((x) => x.hit1)),
    hitAtK: mean(r.map((x) => x.hitK)),
    mrr: mean(r.map((x) => x.rr)),
    fileRecall: mean(r.map((x) => x.fileRecall)),
  };
  if (a.length) {
    Object.assign(summary, {
      verified: mean(a.map((x) => x.status === 'verified')),
      partial: mean(a.map((x) => x.status === 'partial')),
      unverified: mean(a.map((x) => x.status === 'unverified')),
      answered: mean(a.map((x) => x.answered)),
      containsExpected: mean(a.map((x) => x.contains)),
      citesRelevantSource: mean(a.map((x) => x.citedRelevant)),
      correctRefusals: mean(a.map((x) => x.correctRefusal)),
    });
  }
  return summary;
}
