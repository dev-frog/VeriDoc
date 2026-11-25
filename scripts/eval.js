/**
 * Evaluate retrieval (and optionally answers) against a labelled dataset.
 *
 *   pnpm eval                                    # eval/dataset.example.jsonl, retrieval only
 *   pnpm eval my-dataset.jsonl --answers         # also call the LLM and check citations
 *   pnpm eval --api                              # evaluate a running server (VERIDOC_URL)
 *   pnpm eval --json report.json --delay 3000    # save a report; pause between questions
 *
 * Retrieval metrics: hit@1, hit@k, MRR, file recall (k = TOP_N or --top).
 * Answer metrics (--answers): verified / partial / unverified citations, answered,
 * contains-expected-text, cites-a-relevant-source, correct refusals for unanswerable questions.
 *
 * Each question costs 1 embedding call (+1 rerank, +1 LLM call with --answers).
 * On free tiers, use --limit and --delay to stay under rate limits.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseCase, retrievalMetrics, answerMetrics, summarize } from '../src/core/eval/metrics.js';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    answers: { type: 'boolean', default: false },
    api: { type: 'boolean', default: false },
    top: { type: 'string' },
    limit: { type: 'string' },
    delay: { type: 'string', default: '0' },
    json: { type: 'string' },
  },
});
const datasetPath = positionals[0] ?? 'eval/dataset.example.jsonl';
const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const pct = (x) => (x === null || x === undefined ? '   -' : `${(x * 100).toFixed(0).padStart(3)}%`);

/** @returns {Promise<{ search: (q: any) => Promise<any>, ask: (q: any) => Promise<any>, close: () => Promise<void> }>} */
async function backend() {
  if (opts.api) {
    const base = (process.env.VERIDOC_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const call = async (path, body) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(process.env.VERIDOC_API_KEY && { authorization: `Bearer ${process.env.VERIDOC_API_KEY}` }) },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`${path} → ${res.status} ${json.error?.code}: ${json.error?.message}`);
      return json;
    };
    return { search: (q) => call('/search', q), ask: (q) => call('/ask', q), close: async () => {} };
  }
  const { getConfig } = await import('../src/config.js');
  const { createServices } = await import('../src/services.js');
  const { closeClient } = await import('../src/db/client.js');
  const { search, answer } = createServices(getConfig());
  return { search: (q) => search.search(q), ask: (q) => answer.ask(q), close: closeClient };
}

async function main() {
  const lines = (await readFile(datasetPath, 'utf8')).split('\n');
  let cases = lines.map((l, i) => parseCase(l, i + 1)).filter(Boolean);
  if (opts.limit) cases = cases.slice(0, Number(opts.limit));
  if (!cases.length) throw new Error(`${datasetPath} has no questions`);

  const be = await backend();
  const topN = opts.top ? Number(opts.top) : undefined;
  const delay = Number(opts.delay);
  console.log(paint(1, `\nVeriDoc eval: ${cases.length} question(s) from ${datasetPath}${opts.answers ? ' (with answers)' : ''}\n`));

  const rows = [];
  try {
    for (const [i, c] of cases.entries()) {
      if (i && delay) await new Promise((r) => setTimeout(r, delay));
      const row = { id: c.id, question: c.question };
      try {
        const s = await be.search({ query: c.question, ...(topN && { topN }) });
        row.results = s.results.map((r) => ({ rank: r.rank, fileName: r.fileName, page: r.page, score: r.score }));
        row.retrieval = retrievalMetrics(s.results, c);
        if (opts.answers) {
          const a = await be.ask({ question: c.question, ...(topN && { topN }) });
          row.answer = answerMetrics(a, c);
          row.answerText = a.answer;
        }
      } catch (err) {
        row.error = err.message;
        row.retrieval = retrievalMetrics([], c);
      }
      rows.push(row);
      printRow(row, c);
    }
  } finally {
    await be.close().catch(() => {});
  }

  const summary = summarize(rows);
  printSummary(summary, topN);
  if (opts.json) {
    await writeFile(opts.json, JSON.stringify({ dataset: datasetPath, at: new Date().toISOString(), summary, rows }, null, 2));
    console.log(paint(2, `\nReport written to ${opts.json}`));
  }
  if (rows.some((r) => r.error)) process.exitCode = 1;
}

function printRow(row, c) {
  const q = c.question.length > 60 ? `${c.question.slice(0, 59)}…` : c.question;
  if (row.error) return console.log(`${paint(31, '✗')} ${q}\n   ${paint(31, row.error)}`);
  const r = row.retrieval;
  let mark;
  let detail;
  if (!r.answerable) {
    mark = row.answer ? (row.answer.correctRefusal ? paint(32, '✓') : paint(31, '✗')) : paint(2, '·');
    detail = row.answer ? `unanswerable → ${row.answer.status}` : 'unanswerable (run with --answers to check refusal)';
  } else {
    mark = r.hit1 ? paint(32, '✓') : r.hitK ? paint(33, '~') : paint(31, '✗');
    detail = r.firstRelevantRank ? `relevant at #${r.firstRelevantRank}` : 'expected source not retrieved';
    if (row.answer) detail += ` · answer ${row.answer.status}${row.answer.contains === false ? ', missing expected text' : ''}`;
  }
  console.log(`${mark} ${q}\n   ${paint(2, detail)}`);
}

function printSummary(s, topN) {
  console.log(paint(1, '\nRetrieval') + paint(2, ` (${s.answerable} answerable question(s), k = ${topN ?? 'TOP_N'})`));
  console.log(`  hit@1        ${pct(s.hitAt1)}`);
  console.log(`  hit@k        ${pct(s.hitAtK)}`);
  console.log(`  MRR          ${s.mrr === null ? '   -' : s.mrr.toFixed(3)}`);
  console.log(`  file recall  ${pct(s.fileRecall)}`);
  if (s.verified !== undefined) {
    console.log(paint(1, '\nAnswers'));
    console.log(`  verified citations     ${pct(s.verified)}`);
    console.log(`  partially verified     ${pct(s.partial)}`);
    console.log(`  unverified             ${pct(s.unverified)}`);
    console.log(`  answered (answerable)  ${pct(s.answered)}`);
    console.log(`  contains expected text ${pct(s.containsExpected)}`);
    console.log(`  cites relevant source  ${pct(s.citesRelevantSource)}`);
    console.log(`  correct refusals       ${pct(s.correctRefusals)}`);
  }
}

try {
  await main();
} catch (err) {
  console.error(paint(31, `eval failed: ${err.message}`));
  process.exitCode = 1;
}
