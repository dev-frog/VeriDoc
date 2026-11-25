import { describe, it, expect } from 'vitest';
import { parseCase, isRelevant, retrievalMetrics, answerMetrics, summarize } from '../src/core/eval/metrics.js';

const c = { question: 'q', files: ['policy.pdf'], answerContains: ['30 days'] };

describe('eval metrics', () => {
  it('parses dataset lines and skips comments', () => {
    expect(parseCase('// note', 1)).toBeNull();
    expect(parseCase('{"question":"Hi?","files":["a.md"]}', 3)).toEqual({ id: 'q3', question: 'Hi?', files: ['a.md'] });
    expect(() => parseCase('{"files":[]}', 2)).toThrow(/line 2: "question" is required/);
    expect(() => parseCase('{"question":"x","pages":["1"]}', 4)).toThrow(/pages/);
  });

  it('matches files case-insensitively and as path suffixes, optionally by page', () => {
    expect(isRelevant({ fileName: 'handbooks/Policy.PDF', page: 2 }, c)).toBe(true);
    expect(isRelevant({ fileName: 'other-policy.pdf', page: 2 }, c)).toBe(false);
    expect(isRelevant({ fileName: 'policy.pdf', page: 3 }, { ...c, pages: [2] })).toBe(false);
  });

  it('computes hit@1, hit@k, reciprocal rank and file recall', () => {
    const results = [{ fileName: 'x.md', page: null }, { fileName: 'policy.pdf', page: 1 }];
    expect(retrievalMetrics(results, c)).toEqual({ answerable: true, firstRelevantRank: 2, hit1: false, hitK: true, rr: 0.5, fileRecall: 1 });
    expect(retrievalMetrics([], c)).toMatchObject({ hitK: false, rr: 0, fileRecall: 0 });
    expect(retrievalMetrics(results, { ...c, files: ['policy.pdf', 'faq.md'] }).fileRecall).toBe(0.5);
    expect(retrievalMetrics(results, { question: 'q', files: [] })).toMatchObject({ answerable: false, hit1: null });
  });

  it('scores answers and refusals', () => {
    const ask = { answer: 'Within 30 Days [Source 1].', verification: { status: 'verified' }, citations: [{ fileName: 'policy.pdf', page: 1 }] };
    expect(answerMetrics(ask, c)).toEqual({ status: 'verified', correctRefusal: null, answered: true, contains: true, citedRelevant: true });
    const refusal = { answer: "I couldn't find this", verification: { status: 'no_answer' }, citations: [] };
    expect(answerMetrics(refusal, { question: 'q', files: [] }).correctRefusal).toBe(true);
    expect(answerMetrics(refusal, c)).toMatchObject({ answered: false, contains: false });
  });

  it('summarizes, ignoring metrics that do not apply', () => {
    const rows = [
      { retrieval: retrievalMetrics([{ fileName: 'policy.pdf', page: 1 }], c), answer: { status: 'verified', answered: true, contains: true, citedRelevant: true, correctRefusal: null } },
      { retrieval: retrievalMetrics([], c), answer: { status: 'partial', answered: true, contains: false, citedRelevant: false, correctRefusal: null } },
      { retrieval: retrievalMetrics([], { question: 'q', files: [] }), answer: { status: 'no_answer', answered: null, contains: null, citedRelevant: null, correctRefusal: true } },
    ];
    expect(summarize(rows)).toMatchObject({
      questions: 3, answerable: 2, hitAt1: 0.5, hitAtK: 0.5, mrr: 0.5, fileRecall: 0.5,
      verified: 1 / 3, partial: 1 / 3, answered: 1, containsExpected: 0.5, citesRelevantSource: 0.5, correctRefusals: 1,
    });
  });
});
