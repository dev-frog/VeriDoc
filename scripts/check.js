/**
 * Check configuration and connectivity to every external service.
 *
 *   pnpm check            # config + MongoDB + embeddings + reranker + LLM
 *   pnpm check --offline  # config only, no network calls
 *
 * Each live check makes one tiny request (a few tokens). Secrets are never printed.
 */
import { loadConfig, ConfigError } from '../src/config.js';
import { diagnoseConfig } from '../src/diagnostics.js';
import { getDb, closeClient } from '../src/db/client.js';
import { COLLECTIONS } from '../src/db/collections.js';
import { VECTOR_INDEX_NAME, TEXT_INDEX_NAME } from '../src/db/indexes.js';
import { createEmbedder } from '../src/core/embed/index.js';
import { createReranker } from '../src/core/rerank/index.js';
import { createLlm } from '../src/core/llm/index.js';

const offline = process.argv.includes('--offline');
const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const ICON = { ok: paint(32, '✓'), warn: paint(33, '!'), error: paint(31, '✗'), skip: paint(2, '-') };

let failures = 0;
/** @param {'ok'|'warn'|'error'|'skip'} level @param {string} area @param {string} msg @param {string} [fix] */
function report(level, area, msg, fix) {
  if (level === 'error') failures++;
  console.log(`${ICON[level]} ${area.padEnd(11)} ${msg}`);
  if (fix && level !== 'ok') console.log(`  ${''.padEnd(11)} ${paint(2, '→ ' + fix)}`);
}

/** Run one live check with a timeout; turn exceptions into an error line. */
async function live(area, fn, hint) {
  try {
    const msg = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 30s')), 30_000)),
    ]);
    report('ok', area, msg);
  } catch (err) {
    report('error', area, err.message.slice(0, 300), typeof hint === 'function' ? hint(err) : hint);
  }
}

const httpHint = (what) => (err) =>
  ({
    401: `Invalid key for ${what}. Copy a current key from the provider dashboard`,
    403: `Key has no access to ${what}`,
    404: `Wrong base URL or model name for ${what} (Azure: use the deployment name and a base URL ending in /openai/v1)`,
    429: 'Rate limited or out of quota',
  })[err.status ?? err.details?.status];

async function main() {
  console.log(paint(1, '\nConfiguration'));
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    for (const p of err.problems) report('error', 'config', p);
    return;
  }
  for (const f of diagnoseConfig(config)) report(f.level, f.area, f.message, f.fix);

  if (offline) return;
  const errorAreas = new Set(diagnoseConfig(config).filter((f) => f.level === 'error').map((f) => f.area));

  console.log(paint(1, '\nMongoDB'));
  await live(
    'mongodb',
    async () => {
      const db = await getDb();
      const { version } = await db.admin().command({ buildInfo: 1 });
      return `connected to "${config.MONGODB_DB}", server ${version}`;
    },
    'Check MONGODB_URI, the database user password, and Atlas → Network Access (allow your IP)',
  );
  await live(
    'indexes',
    async () => {
      const db = await getDb();
      const idx = await db.collection(COLLECTIONS.chunks).listSearchIndexes().toArray();
      const status = (n) => {
        const i = idx.find((x) => x.name === n);
        return i ? `${n}=${i.queryable ? 'READY' : i.status}` : `${n}=MISSING`;
      };
      const line = `${status(VECTOR_INDEX_NAME)}  ${status(TEXT_INDEX_NAME)}`;
      if (line.includes('MISSING')) throw new Error(line);
      const v = idx.find((x) => x.name === VECTOR_INDEX_NAME);
      const dims = v?.latestDefinition?.fields?.find((f) => f.type === 'vector')?.numDimensions;
      if (dims && dims !== config.EMBED_DIMENSIONS) throw new Error(`${VECTOR_INDEX_NAME} has ${dims} dimensions, EMBED_DIMENSIONS is ${config.EMBED_DIMENSIONS}`);
      return line;
    },
    'Run `pnpm db:setup` (or `pnpm db:setup --update` after changing EMBED_DIMENSIONS)',
  );

  console.log(paint(1, '\nEmbeddings'));
  if (errorAreas.has('embeddings')) report('skip', 'embeddings', 'skipped: fix the configuration errors above first');
  else
    await live(
      'embeddings',
      async () => {
        const embedder = createEmbedder(config, { http: { retries: 0 } });
        const [v] = await embedder.embed(['VeriDoc connectivity check'], { inputType: 'query' });
        return `${config.EMBED_PROVIDER} / ${config.EMBED_MODEL}: got a ${v.length}-dim vector`;
      },
      httpHint('embeddings'),
    );

  console.log(paint(1, '\nReranker'));
  if (config.RERANK_PROVIDER === 'none') report('ok', 'rerank', 'RERANK_PROVIDER=none (reranking disabled)');
  else if (errorAreas.has('rerank')) report('skip', 'rerank', 'skipped: fix the configuration errors above first');
  else
    await live(
      'rerank',
      async () => {
        const reranker = createReranker(config, { http: { retries: 0 } });
        const ranked = await reranker.rerank('What is VeriDoc?', ['Bananas are yellow.', 'VeriDoc is a RAG engine.'], 2);
        if (ranked[0]?.index !== 1) throw new Error(`unexpected ranking: ${JSON.stringify(ranked)}`);
        return `${reranker.name}: ranked the relevant document first`;
      },
      httpHint('the reranker'),
    );

  console.log(paint(1, '\nLLM'));
  if (errorAreas.has('llm')) report('skip', 'llm', 'skipped: fix the configuration errors above first');
  else
    await live(
      'llm',
      async () => {
        const llm = createLlm(config, { http: { retries: 0 } });
        const { text } = await llm.chat([{ role: 'user', content: 'Reply with the single word OK.' }], { maxTokens: 64 });
        return `${config.LLM_MODEL} replied: "${text.slice(0, 40)}"`;
      },
      httpHint('the LLM'),
    );
}

try {
  await main();
} catch (err) {
  report('error', 'check', err.message);
} finally {
  await closeClient().catch(() => {});
  console.log(failures ? paint(31, `\n${failures} problem(s) found.\n`) : paint(32, '\nAll checks passed.\n'));
  process.exitCode = failures ? 1 : 0;
}
