import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/core/ingest/parsers/markdown.js';
import { parseText } from '../src/core/ingest/parsers/text.js';
import { htmlToSections, decodeEntities } from '../src/core/ingest/parsers/docx.js';
import { cleanPdfText } from '../src/core/ingest/parsers/pdf.js';
import { parseDocument } from '../src/core/ingest/parsers/index.js';
import { mimeTypeForFileName, MIME } from '../src/core/ingest/file-types.js';
import { CoreError } from '../src/core/errors.js';
import { makePdf } from './helpers/make-pdf.js';

const enc = (s) => new TextEncoder().encode(s);

describe('file types', () => {
  it('maps supported extensions case-insensitively', () => {
    expect(mimeTypeForFileName('a.PDF')).toBe(MIME.pdf);
    expect(mimeTypeForFileName('notes.md')).toBe(MIME.markdown);
    expect(mimeTypeForFileName('notes.markdown')).toBe(MIME.markdown);
    expect(mimeTypeForFileName('x.txt')).toBe(MIME.text);
    expect(mimeTypeForFileName('r.docx')).toBe(MIME.docx);
  });
  it('returns null for unsupported or missing extensions', () => {
    expect(mimeTypeForFileName('a.doc')).toBeNull();
    expect(mimeTypeForFileName('README')).toBeNull();
    expect(mimeTypeForFileName('dir.pdf/file')).toBeNull();
  });
});

describe('parseMarkdown', () => {
  it('splits by headings and records the heading path', () => {
    const md = '# Guide\nIntro text.\n## Install\nRun it.\n### Linux\nUse apt.\n## Usage\nCall it.';
    expect(parseMarkdown(md)).toEqual([
      { page: null, heading: 'Guide', text: 'Intro text.' },
      { page: null, heading: 'Guide > Install', text: 'Run it.' },
      { page: null, heading: 'Guide > Install > Linux', text: 'Use apt.' },
      { page: null, heading: 'Guide > Usage', text: 'Call it.' },
    ]);
  });

  it('keeps text before the first heading with heading null', () => {
    expect(parseMarkdown('Preamble.\n# A\nBody.')[0]).toEqual({ page: null, heading: null, text: 'Preamble.' });
  });

  it('ignores # lines inside fenced code blocks', () => {
    const md = '# Code\n```bash\n# not a heading\necho hi\n```\nAfter.';
    const sections = parseMarkdown(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].text).toContain('# not a heading');
    expect(sections[0].text).toContain('After.');
  });

  it('strips closing #s, drops YAML front matter, handles CRLF', () => {
    const md = '---\ntitle: x\n---\r\n## Title ##\r\nBody.\r\n';
    expect(parseMarkdown(md)).toEqual([{ page: null, heading: 'Title', text: 'Body.' }]);
  });

  it('does not treat #hashtag (no space) as a heading', () => {
    expect(parseMarkdown('#tag line')[0]).toEqual({ page: null, heading: null, text: '#tag line' });
  });

  it('skips headings with no text under them', () => {
    expect(parseMarkdown('# A\n## B\nText.')).toEqual([{ page: null, heading: 'A > B', text: 'Text.' }]);
  });
});

describe('parseText', () => {
  it('returns one section, or none for blank input', () => {
    expect(parseText('  hello\r\nworld  ')).toEqual([{ page: null, heading: null, text: 'hello\nworld' }]);
    expect(parseText(' \n ')).toEqual([]);
  });
});

describe('htmlToSections (docx)', () => {
  it('turns mammoth HTML into heading-aware sections', () => {
    const html =
      '<h1>Policy</h1><p>Applies to all.</p><h2>Leave &amp; Holidays</h2>' +
      '<p>25 days.</p><ul><li>Plan ahead</li><li>Ask <strong>early</strong></li></ul>' +
      '<table><tr><td>A</td><td>B</td></tr></table>';
    const s = htmlToSections(html);
    expect(s[0]).toEqual({ page: null, heading: 'Policy', text: 'Applies to all.' });
    expect(s[1].heading).toBe('Policy > Leave & Holidays');
    expect(s[1].text).toContain('25 days.');
    expect(s[1].text).toContain('- Plan ahead\n- Ask early');
    expect(s[1].text).toContain('A | B |');
  });

  it('decodes entities', () => {
    expect(decodeEntities('&lt;a&gt; &quot;x&quot; &#39;y&#39; &#x2014; &#169; &amp;amp;')).toBe(`<a> "x" 'y' — © &amp;`);
  });
});

describe('cleanPdfText', () => {
  it('joins hyphenated line breaks and normalizes spaces', () => {
    expect(cleanPdfText('infor-\nmation   is\n\n\n\nhere  ')).toBe('information is\n\nhere');
  });
});

describe('parseDocument', () => {
  it('parses a PDF into one section per page, keeping blank pages', async () => {
    const sections = await parseDocument(makePdf(['Hello page one.', '', 'Third (page) here.']), MIME.pdf);
    expect(sections.map((s) => s.page)).toEqual([1, 2, 3]);
    expect(sections[0].text).toBe('Hello page one.');
    expect(sections[1].text).toBe('');
    expect(sections[2].text).toBe('Third (page) here.');
    expect(sections.every((s) => s.heading === null)).toBe(true);
  });

  it('decodes UTF-8 text and markdown (stripping a BOM)', async () => {
    expect(await parseDocument(enc('﻿héllo'), MIME.text)).toEqual([{ page: null, heading: null, text: 'héllo' }]);
    expect((await parseDocument(enc('# H\nx'), MIME.markdown))[0].heading).toBe('H');
  });

  it('wraps parser failures in CoreError parse_failed', async () => {
    await expect(parseDocument(enc('not a pdf'), MIME.pdf)).rejects.toMatchObject({ code: 'parse_failed' });
    await expect(parseDocument(enc('not a zip'), MIME.docx)).rejects.toBeInstanceOf(CoreError);
  });

  it('rejects unsupported types', async () => {
    await expect(parseDocument(enc('x'), 'image/png')).rejects.toMatchObject({ code: 'unsupported_type' });
  });
});
