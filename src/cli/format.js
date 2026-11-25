/**
 * Terminal formatting for the veridoc CLI. Pure functions (tested).
 */

/** @param {boolean} on */
export function palette(on) {
  const c = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: c(1), dim: c(2), green: c(32), yellow: c(33), red: c(31), cyan: c(36) };
}

const STATUS_TEXT = {
  verified: ['green', '✓ verified — every claim cites a retrieved source that supports it'],
  partial: ['yellow', '! partially verified'],
  unverified: ['red', '✗ unverified — no valid citations'],
  no_answer: ['yellow', '– the documents do not contain the answer'],
  no_sources: ['yellow', '– no matching documents found'],
};

/**
 * @param {any} res  POST /ask response
 * @param {{ color?: boolean }} [opts]
 */
export function formatAnswer(res, { color = false } = {}) {
  const p = palette(color);
  const v = res.verification ?? {};
  const [tone, label] = STATUS_TEXT[v.status] ?? ['dim', v.status ?? ''];
  const lines = [res.answer.replace(/\[Sources?[^\]]*\]/gi, (m) => p.cyan(m)), ''];
  if (res.citations?.length) {
    lines.push(p.bold('Sources'));
    for (const c of res.citations) lines.push(`  ${p.cyan(`[${c.n}]`)} ${c.label}`, `      ${p.dim(c.snippet)}`);
    lines.push('');
  }
  const issues = [];
  if (v.invalidCitations?.length) issues.push(`cites unknown source(s) ${v.invalidCitations.join(', ')}`);
  if (v.uncitedSentences) issues.push(`${v.uncitedSentences} uncited claim(s)`);
  if (v.unsupportedSentences) issues.push(`${v.unsupportedSentences} claim(s) not supported by the cited source`);
  lines.push(p[tone](label) + (issues.length ? p.dim(` (${issues.join('; ')})`) : ''));
  return lines.join('\n');
}

/**
 * @param {any} res  POST /search response
 * @param {{ color?: boolean }} [opts]
 */
export function formatSearch(res, { color = false } = {}) {
  const p = palette(color);
  if (!res.results.length) return p.yellow('No results.');
  return res.results
    .map((r) => {
      const where = [r.fileName, r.page ? `page ${r.page}` : null, r.heading].filter(Boolean).join(' · ');
      const text = r.text.replace(/\s+/g, ' ');
      const score = typeof r.score === 'number' ? r.score.toFixed(3) : '-';
      return `${p.cyan(`#${r.rank}`)} ${p.bold(where)} ${p.dim(`score ${score}`)}\n   ${text.length > 300 ? `${text.slice(0, 299)}…` : text}`;
    })
    .join('\n\n');
}

/**
 * @param {any[]} docs
 * @param {{ color?: boolean }} [opts]
 */
export function formatDocuments(docs, { color = false } = {}) {
  const p = palette(color);
  if (!docs.length) return p.dim('No documents yet. Add one with: veridoc upload <file>');
  const tone = { ready: 'green', failed: 'red', processing: 'yellow', pending: 'dim' };
  return docs
    .map((d) => `${d.id}  ${p[tone[d.status] ?? 'dim'](d.status.padEnd(10))} ${String(d.chunkCount).padStart(5)} chunks  ${d.fileName}${d.error ? p.red(`  ${d.error}`) : ''}`)
    .join('\n');
}
