import { describe, it, expect } from 'vitest';
import { extractCitations, stripCitations, splitSentences, supportScore, verifyCitations, NO_ANSWER } from '../src/core/answer/citations.js';

const sources = [
  { text: 'Customers can request a refund within 30 days of purchase.' },
  { text: 'The office is closed on every public holiday.' },
];

describe('extractCitations', () => {
  it('handles the common marker styles', () => {
    expect(extractCitations('A [Source 1]. B [Source 2, Source 3]. C [Sources 4, 5]. D [source 6; 7] [Source 1]')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(extractCitations('No markers [1] or (Source 2) here')).toEqual([]);
  });
  it('strips markers without leaving gaps before punctuation', () => {
    expect(stripCitations('Refunds take 30 days [Source 1].')).toBe('Refunds take 30 days.');
  });
});

describe('splitSentences', () => {
  it('keeps trailing markers with their sentence and splits lines', () => {
    expect(splitSentences('First fact. [Source 1] Second fact [Source 2].\n- Item one [Source 1]')).toEqual([
      'First fact. [Source 1]',
      'Second fact [Source 2].',
      '- Item one [Source 1]',
    ]);
  });
});

describe('supportScore', () => {
  it('is high for paraphrases and low for unrelated claims', () => {
    expect(supportScore('A refund can be requested within 30 days', sources[0].text)).toBeGreaterThan(0.6);
    expect(supportScore('Laptops are replaced every two years', sources[0].text)).toBe(0);
  });
});

describe('verifyCitations', () => {
  it('verified: every claim cited and supported', () => {
    const v = verifyCitations('Refunds can be requested within 30 days of purchase [Source 1]. The office closes on public holidays [Source 2].', sources);
    expect(v.status).toBe('verified');
    expect(v.citedSources).toEqual([1, 2]);
  });

  it('partial: a claim pinned to the wrong source', () => {
    const v = verifyCitations('Refunds can be requested within 30 days [Source 2].', sources);
    expect(v).toMatchObject({ status: 'partial', unsupportedSentences: 1 });
    expect(v.sentences[0]).toMatchObject({ supported: false, support: 0 });
  });

  it('partial: an uncited factual sentence', () => {
    const v = verifyCitations('Refunds take 30 days [Source 1]. Shipping is always free for members.', sources);
    expect(v).toMatchObject({ status: 'partial', uncitedSentences: 1 });
  });

  it('does not require citations on short connective sentences or list lead-ins', () => {
    const v = verifyCitations('Yes.\nHere is what the policy says:\n- Refunds within 30 days of purchase [Source 1]', sources);
    expect(v.status).toBe('verified');
  });

  it('unverified: no valid citations at all', () => {
    expect(verifyCitations('Refunds take 30 days.', sources).status).toBe('unverified');
    expect(verifyCitations('Refunds take 30 days [Source 8].', sources)).toMatchObject({ status: 'unverified', invalidCitations: [8] });
  });

  it('no_answer and no_sources', () => {
    expect(verifyCitations(NO_ANSWER, sources).status).toBe('no_answer');
    expect(verifyCitations('anything', []).status).toBe('no_sources');
  });
});
