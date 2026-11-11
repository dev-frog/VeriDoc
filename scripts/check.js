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
import { openAIAuthHeaders } from '../src/core/embed/openai.js';

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

/** POST JSON without retries; returns parsed body or throws with status + provider message. */
async function post(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.message ?? j?.detail ?? detail;
    } catch {}
    const err = new Error(`HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

const httpHint = (what) => (err) =>
  ({
    401: `Invalid key for ${what}. Copy a current key from the provider dashboard (Azure: resource → Keys and Endpoint)`,
    403: `Key has no access to ${what}`,
    404: `Wrong URL or model/deployment name for ${what}. On Azure the model must be your *deployment* name and the base URL must end in /openai/v1`,
    429: 'Rate limited or out of quota',
  })[err.status];

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
        const query = 'What is VeriDoc?';
        const documents = ['VeriDoc is a RAG engine.', 'Bananas are yellow.'];
        // Model names are the providers' current defaults; check their docs if these 404.
        const req = {
          cohere: ['https://api.cohere.com/v2/rerank', config.COHERE_API_KEY, 'rerank-v3.5'],
          voyage: ['https://api.voyageai.com/v1/rerank', config.VOYAGE_API_KEY, 'rerank-2.5'],
          jina: ['https://api.jina.ai/v1/rerank', config.JINA_API_KEY, 'jina-reranker-v2-base-multilingual'],
        }[config.RERANK_PROVIDER];
        const [url, key, model] = req;
        const json = await post(url, { authorization: `Bearer ${key}` }, { model, query, documents, top_n: 2 });
        const results = json.results ?? json.data ?? [];
        const top = results[0]?.index;
        if (top !== 0) throw new Error(`unexpected ranking: ${JSON.stringify(results).slice(0, 120)}`);
        return `${config.RERANK_PROVIDER} / ${model}: ranked the relevant document first`;
      },
      httpHint('the reranker'),
    );

  console.log(paint(1, '\nLLM'));
  if (errorAreas.has('llm')) report('skip', 'llm', 'skipped: fix the configuration errors above first');
  else
    await live(
      'llm',
      async () => {
        const url = `${config.LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
        const json = await post(url, openAIAuthHeaders(config.LLM_BASE_URL, config.LLM_API_KEY), {
          model: config.LLM_MODEL,
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        });
        const reply = json.choices?.[0]?.message?.content?.trim() ?? '';
        return `${config.LLM_MODEL} replied: "${reply.slice(0, 40)}"`;
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
