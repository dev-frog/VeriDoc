import { describe, it, expect } from 'vitest';
import { formatAnswer, formatSearch, formatDocuments } from '../src/cli/format.js';

describe('CLI formatting', () => {
  it('formats an answer with sources and the verification verdict', () => {
    const text = formatAnswer({
      answer: 'Refunds within 30 days [Source 1].',
      citations: [{ n: 1, label: 'policy.pdf · page 2', snippet: 'Customers can request a refund…' }],
      verification: { status: 'verified', invalidCitations: [], uncitedSentences: 0, unsupportedSentences: 0 },
    });
    expect(text).toContain('[1] policy.pdf · page 2');
    expect(text).toContain('✓ verified');
    expect(text).not.toMatch(/\x1b\[/); // no colours unless asked
  });

  it('lists verification problems', () => {
    const text = formatAnswer({
      answer: 'x',
      citations: [],
      verification: { status: 'partial', invalidCitations: [4], uncitedSentences: 2, unsupportedSentences: 1 },
    });
    expect(text).toMatch(/partially verified \(cites unknown source\(s\) 4; 2 uncited claim\(s\); 1 claim\(s\) not supported/);
  });

  it('formats search results and empty states', () => {
    expect(formatSearch({ results: [] })).toBe('No results.');
    const s = formatSearch({ results: [{ rank: 1, fileName: 'a.md', page: null, heading: 'H', text: 'Body\ntext', score: 0.5 }] });
    expect(s).toBe('#1 a.md · H score 0.500\n   Body text');
    expect(formatDocuments([])).toMatch(/No documents yet/);
    expect(formatDocuments([{ id: 'abc', status: 'failed', chunkCount: 0, fileName: 'x.pdf', error: 'boom' }])).toContain('x.pdf  boom');
  });
});
