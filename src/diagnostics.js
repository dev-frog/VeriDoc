/**
 * Offline checks of a validated config: catches values that parse fine but
 * can't work (URL pasted into a key field, Azure URL without /openai/v1,
 * provider selected without its key, ...). Pure, so it is unit-tested.
 */

/**
 * @typedef {object} Finding
 * @property {'error' | 'warn' | 'ok'} level  error = a feature will not work
 * @property {string} area
 * @property {string} message
 * @property {string} [fix]
 */

const isAzureHost = (url) => {
  try {
    const h = new URL(url).hostname;
    return h.endsWith('.openai.azure.com') || h.endsWith('.cognitiveservices.azure.com');
  } catch {
    return false;
  }
};

/** @param {string | undefined} key */
const looksLikeUrl = (key) => Boolean(key && /^https?:\/\//i.test(key));

/**
 * @param {import('./config.js').Config} c
 * @returns {Finding[]}
 */
export function diagnoseConfig(c) {
  /** @type {Finding[]} */
  const out = [];
  const add = (level, area, message, fix) => out.push({ level, area, message, ...(fix && { fix }) });

  // --- secrets that are obviously not secrets
  for (const name of ['EMBED_API_KEY', 'RERANK_API_KEY', 'LLM_API_KEY', 'VERIDOC_API_KEY']) {
    if (looksLikeUrl(c[name])) add('error', name, `${name} contains a URL, not a key`, `Put the API key in ${name}; URLs belong in *_BASE_URL`);
  }

  // --- base URLs
  for (const [name, area] of [['EMBED_BASE_URL', 'embeddings'], ['LLM_BASE_URL', 'llm']]) {
    const url = c[name];
    if (area === 'embeddings' && c.EMBED_PROVIDER !== 'openai-compatible') continue;
    if (isAzureHost(url) && !/\/openai\/v1\/?$/.test(new URL(url).pathname)) {
      add('error', area, `${name} is an Azure host without the /openai/v1 path (requests will 404)`, `${name}=${url.replace(/\/+$/, '')}/openai/v1`);
    }
  }

  // --- embeddings
  if (!c.EMBED_API_KEY) {
    add('error', 'embeddings', 'EMBED_API_KEY is empty', `Set EMBED_API_KEY to the key for ${c.EMBED_PROVIDER === 'voyage' ? 'Voyage' : c.EMBED_BASE_URL}`);
  }
  if (c.EMBED_PROVIDER === 'voyage') {
    if (![256, 512, 1024, 2048].includes(c.EMBED_DIMENSIONS)) {
      add('warn', 'embeddings', `Voyage models usually support 256/512/1024/2048 dimensions, not ${c.EMBED_DIMENSIONS}`, 'EMBED_DIMENSIONS=1024');
    }
    if (/^text-embedding/.test(c.EMBED_MODEL)) add('error', 'embeddings', `EMBED_MODEL=${c.EMBED_MODEL} is an OpenAI model`, 'EMBED_MODEL=voyage-3.5');
  }

  // --- reranker
  if (c.RERANK_PROVIDER !== 'none' && !c.RERANK_API_KEY) {
    add('error', 'rerank', `RERANK_PROVIDER=${c.RERANK_PROVIDER} but RERANK_API_KEY is empty`, 'Set RERANK_API_KEY, or RERANK_PROVIDER=none to skip reranking');
  }

  // --- LLM
  if (!c.LLM_API_KEY) add('error', 'llm', 'LLM_API_KEY is empty', 'Set LLM_API_KEY');

  // --- app
  if (!c.VERIDOC_API_KEY) {
    add(c.NODE_ENV === 'production' ? 'error' : 'warn', 'auth', 'VERIDOC_API_KEY is empty: /documents is unprotected locally and returns 500 in production', 'Generate one: echo "vd_$(openssl rand -base64 32 | tr \'+/\' \'-_\' | tr -d \'=\')"');
  } else if (c.VERIDOC_API_KEY === 'change-me' || c.VERIDOC_API_KEY.length < 24) {
    add('warn', 'auth', 'VERIDOC_API_KEY is a placeholder or short', 'Use a random key of 32+ bytes');
  }
  if (c.SOURCE_URL_HOSTS.includes('*')) {
    add(c.NODE_ENV === 'production' ? 'error' : 'warn', 'ingest', 'SOURCE_URL_HOSTS=* lets the server download from any https host', 'Use *.public.blob.vercel-storage.com outside local testing');
  }
  if (!c.BLOB_READ_WRITE_TOKEN) {
    add('warn', 'blob', 'BLOB_READ_WRITE_TOKEN is empty (not used yet; needed for uploads to Vercel Blob)', 'Vercel → Storage → Create → Blob, connect it, then `vercel env pull`');
  }

  if (!out.some((f) => f.level === 'error')) add('ok', 'config', 'No configuration errors found');
  return out;
}
