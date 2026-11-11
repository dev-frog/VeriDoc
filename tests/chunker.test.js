import { describe, it, expect } from 'vitest';
import { chunkSections, packUnits } from '../src/core/ingest/chunker.js';
import { countTokens } from '../src/core/ingest/tokens.js';

/** Deterministic tokenizer for tests: one token per whitespace-separated word. */
const words = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

/** n sentences "S1 w w w." each with `len` words (including "S<i>"). */
const sentences = (n, len = 5) =>
  Array.from({ length: n }, (_, i) => `S${i + 1} ${Array(len - 1).fill('w').join(' ')}.`).join(' ');

const sec = (text, page = null, heading = null) => ({ text, page, heading });
const opts = (maxTokens, overlap = 0) => ({ maxTokens, overlap, countTokens: words });

describe('chunkSections: basics', () => {
  it('returns [] for no sections or whitespace-only text', () => {
    expect(chunkSections([], opts(10))).toEqual([]);
    expect(chunkSections([sec('   \n\n  ')], opts(10))).toEqual([]);
  });

  it('keeps a short section as one chunk with its page and heading', () => {
    const [c, ...rest] = chunkSections([sec('Hello world. Bye now.', 3, 'Intro')], opts(50));
    expect(rest).toEqual([]);
    expect(c).toEqual({ chunkIndex: 0, text: 'Hello world. Bye now.', page: 3, heading: 'Intro', tokenCount: 4 });
  });

  it('defaults missing page/heading to null', () => {
    const [c] = chunkSections([{ text: 'Hi.' }], opts(10));
    expect(c.page).toBeNull();
    expect(c.heading).toBeNull();
  });

  it('rejects invalid options', () => {
    expect(() => chunkSections([], { maxTokens: 0 })).toThrow(RangeError);
    expect(() => chunkSections([], { maxTokens: 1.5 })).toThrow(RangeError);
    expect(() => chunkSections([], { maxTokens: 10, overlap: 1 })).toThrow(RangeError);
    expect(() => chunkSections([], { maxTokens: 10, overlap: -0.1 })).toThrow(RangeError);
  });
});

describe('chunkSections: size and sentence boundaries', () => {
  const text = sentences(20, 5); // 100 tokens

  it('never exceeds maxTokens', () => {
    for (const max of [5, 7, 12, 25, 33]) {
      for (const c of chunkSections([sec(text)], opts(max, 0.2))) expect(c.tokenCount).toBeLessThanOrEqual(max);
    }
  });

  it('packs whole sentences greedily', () => {
    const chunks = chunkSections([sec(text)], opts(12));
    expect(chunks.map((c) => c.tokenCount)).toEqual(Array(10).fill(10));
    expect(chunks[0].text).toBe('S1 w w w w. S2 w w w w.');
  });

  it('every chunk starts and ends on a sentence boundary', () => {
    for (const c of chunkSections([sec(text)], opts(17, 0.3))) {
      expect(c.text).toMatch(/^S\d+ /);
      expect(c.text).toMatch(/\.$/);
    }
  });

  it('with no overlap, chunks reassemble to the original text', () => {
    const chunks = chunkSections([sec(text)], opts(13));
    expect(chunks.map((c) => c.text).join(' ')).toBe(text);
  });

  it('chunkIndex is sequential', () => {
    const chunks = chunkSections([sec(text)], opts(10));
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });
});

describe('chunkSections: overlap', () => {
  const text = sentences(10, 5);

  it('repeats trailing whole sentences from the previous chunk', () => {
    // max 20 => 4 sentences; overlap 0.25 => 5 tokens => 1 sentence carried
    const chunks = chunkSections([sec(text)], opts(20, 0.25));
    expect(chunks[0].text).toBe('S1 w w w w. S2 w w w w. S3 w w w w. S4 w w w w.');
    expect(chunks[1].text.startsWith('S4 w w w w. S5')).toBe(true);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(20);
  });

  it('carries no sentence that does not fit entirely in the overlap budget', () => {
    // overlap budget 4 tokens < 5-token sentences => no overlap
    const chunks = chunkSections([sec(text)], opts(20, 0.2));
    expect(chunks[1].text.startsWith('S5 ')).toBe(true);
  });

  it('every sentence appears in at least one chunk, in order', () => {
    const chunks = chunkSections([sec(sentences(30, 4))], opts(15, 0.3));
    const seen = chunks.flatMap((c) => [...c.text.matchAll(/S(\d+) /g)].map((m) => Number(m[1])));
    const unique = [...new Set(seen)];
    expect(unique).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('always makes progress (no chunk is only overlap)', () => {
    const chunks = chunkSections([sec(sentences(12, 3))], opts(6, 0.49));
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].text).not.toBe(chunks[i - 1].text);
    expect(chunks.at(-1).text).toMatch(/S12 /);
  });

  it('never carries the whole previous chunk', () => {
    // large overlap budget relative to sentences
    const units = [
      { raw: 'A. ', tokens: 2 },
      { raw: 'B. ', tokens: 9 },
      { raw: 'C. ', tokens: 2 },
    ];
    const groups = packUnits(units, 10, 9);
    expect(groups.map((g) => g.map((u) => u.raw.trim()))).toEqual([['A.'], ['B.'], ['C.']]);
  });

  it('drops overlap if overlap + next sentence would exceed maxTokens', () => {
    const units = [
      { raw: 'A. ', tokens: 3 },
      { raw: 'B. ', tokens: 3 },
      { raw: 'C. ', tokens: 9 },
    ];
    const groups = packUnits(units, 10, 4);
    expect(groups.map((g) => g.map((u) => u.raw.trim()))).toEqual([['A.', 'B.'], ['C.']]);
  });
});

describe('chunkSections: sections and headings', () => {
  it('never merges text across sections, even when small', () => {
    const chunks = chunkSections(
      [sec('One. Two.', 1, 'A'), sec('Three.', 1, 'B'), sec('Four.', 2, 'B')],
      opts(100),
    );
    expect(chunks.map((c) => [c.text, c.page, c.heading])).toEqual([
      ['One. Two.', 1, 'A'],
      ['Three.', 1, 'B'],
      ['Four.', 2, 'B'],
    ]);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
  });

  it('every chunk of a long section keeps the section page and heading', () => {
    const chunks = chunkSections([sec(sentences(20), 7, 'Install > Linux')], opts(12, 0.1));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.page).toBe(7);
      expect(c.heading).toBe('Install > Linux');
    }
  });

  it('does not overlap across sections', () => {
    const chunks = chunkSections([sec(sentences(4), 1), sec('Other page.', 2)], opts(10, 0.4));
    expect(chunks.at(-1)).toMatchObject({ text: 'Other page.', page: 2 });
  });
});

describe('chunkSections: oversized sentences', () => {
  it('splits a sentence longer than maxTokens at word boundaries', () => {
    const long = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ') + '.';
    const chunks = chunkSections([sec(`Short one. ${long} Short two.`)], opts(10));
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(10);
    const rejoined = chunks.map((c) => c.text).join(' ');
    expect(rejoined).toBe(`Short one. ${long} Short two.`);
    // no word was cut in half
    for (const c of chunks) for (const w of c.text.split(/\s+/)) expect(w).toMatch(/^(w\d+\.?|Short|one\.|two\.)$/);
  });

  it('splits a single huge "word" (e.g. base64) by characters', () => {
    const blob = 'x'.repeat(5000);
    const chunks = chunkSections([sec(blob)], { maxTokens: 100, overlap: 0, countTokens });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(110);
    expect(chunks.map((c) => c.text).join('')).toBe(blob);
  });
});

describe('chunkSections: layout', () => {
  it('preserves newlines and paragraph breaks inside a chunk', () => {
    const text = 'Steps:\n- Install it.\n- Run it.\n\nThat is all.';
    const [c] = chunkSections([sec(text)], opts(100));
    expect(c.text).toBe(text);
  });

  it('splits on paragraph and list lines when needed', () => {
    const text = 'Para one has words here.\n\nPara two has words here.';
    const chunks = chunkSections([sec(text)], opts(6));
    expect(chunks.map((c) => c.text)).toEqual(['Para one has words here.', 'Para two has words here.']);
  });
});

describe('chunkSections: real tokenizer (cl100k_base)', () => {
  const prose = Array.from(
    { length: 300 },
    (_, i) => `Sentence number ${i} explains how VeriDoc traces every answer back to its source document.`,
  ).join(' ');

  it('produces ~600-token chunks with exact tokenCount', () => {
    const chunks = chunkSections([sec(prose, 1, 'H')], { maxTokens: 600, overlap: 0.12 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.tokenCount).toBe(countTokens(c.text));
      expect(c.tokenCount).toBeLessThanOrEqual(600 * 1.02); // sentence sums vs exact count can differ slightly
      expect(c.text).toMatch(/document\.$/);
    }
    // all but the last are reasonably full
    for (const c of chunks.slice(0, -1)) expect(c.tokenCount).toBeGreaterThan(500);
  });

  it('overlap is roughly CHUNK_OVERLAP of the chunk size', () => {
    const chunks = chunkSections([sec(prose)], { maxTokens: 600, overlap: 0.12 });
    const lastSentence = chunks[0].text.match(/Sentence number \d+[^.]*\.$/)[0];
    expect(chunks[1].text).toContain(lastSentence);
  });
});
