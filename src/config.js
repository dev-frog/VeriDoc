import { z } from 'zod';

/** Treat empty strings (e.g. `EMBED_API_KEY=` in .env) as "not set". */
const blankToUndefined = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const str = (def) => z.preprocess(blankToUndefined, z.string().default(def));
const int = (def, min = 1) => z.preprocess(blankToUndefined, z.coerce.number().int().min(min).default(def));

const EnvSchema = z
  .object({
    NODE_ENV: str('development'),
    PORT: int(3000),

    // MongoDB
    MONGODB_URI: z.preprocess(
      blankToUndefined,
      z
        .string({ error: 'is required' })
        .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
    ),
    MONGODB_DB: str('veridoc'),

    // Embeddings
    // openai-compatible: any OpenAI-style /embeddings API (OpenAI, OpenRouter, Azure OpenAI v1, Together, ...).
    // "openai" is accepted as an alias.
    EMBED_PROVIDER: z.preprocess(
      (v) => (v === 'openai' ? 'openai-compatible' : blankToUndefined(v)),
      z.enum(['openai-compatible', 'voyage']).default('openai-compatible'),
    ),
    EMBED_BASE_URL: z.preprocess(blankToUndefined, z.url().default('https://api.openai.com/v1')),
    EMBED_API_KEY: optionalString,
    EMBED_MODEL: str('text-embedding-3-small'),
    EMBED_DIMENSIONS: int(1536),

    // Reranker
    RERANK_PROVIDER: z.preprocess(
      blankToUndefined,
      z.enum(['cohere', 'voyage', 'jina', 'none']).default('cohere'),
    ),
    RERANK_API_KEY: optionalString,
    /** Empty = the provider's default model (see src/core/rerank). */
    RERANK_MODEL: optionalString,
    /** Empty = the provider's own API. Set to use a compatible gateway, e.g. https://openrouter.ai/api/v1 */
    RERANK_BASE_URL: z.preprocess(blankToUndefined, z.url().optional()),

    // LLM: any OpenAI-compatible /chat/completions API
    LLM_BASE_URL: z.preprocess(blankToUndefined, z.url().default('https://api.openai.com/v1')),
    LLM_API_KEY: optionalString,
    LLM_MODEL: str('gpt-4o-mini'),
    /** Empty = the model's default. Some models (e.g. reasoning models) only accept their default. */
    LLM_TEMPERATURE: z.preprocess(blankToUndefined, z.coerce.number().min(0).max(2).optional()),
    LLM_MAX_TOKENS: int(1024),

    // OCR for scanned PDFs (PDFs without a text layer). none = disabled.
    // openai-compatible: sends the PDF to a vision/file-capable chat model.
    OCR_PROVIDER: z.preprocess(blankToUndefined, z.enum(['none', 'openai-compatible']).default('none')),
    OCR_BASE_URL: z.preprocess(blankToUndefined, z.url().default('https://openrouter.ai/api/v1')),
    OCR_API_KEY: optionalString,
    OCR_MODEL: optionalString,
    /** Optional OpenRouter PDF engine: mistral-ocr | cloudflare-ai | native. Empty = provider default. */
    OCR_PDF_ENGINE: optionalString,

    // App
    /** Request logs: pretty (readable), json (one JSON object per line) or off. Default depends on NODE_ENV. */
    LOG_FORMAT: z.preprocess(blankToUndefined, z.enum(['pretty', 'json', 'off']).optional()),
    VERIDOC_API_KEY: optionalString,
    BLOB_READ_WRITE_TOKEN: optionalString,

    // Retrieval tuning
    CHUNK_TOKENS: int(600, 50),
    CHUNK_OVERLAP: z.preprocess(blankToUndefined, z.coerce.number().min(0).max(0.5).default(0.12)),
    TOP_K: int(30),
    TOP_N: int(5),

    // Ingestion
    /** Comma-separated hosts allowed as document sources: "*", "*.example.com" or exact hosts. */
    SOURCE_URL_HOSTS: str('*.public.blob.vercel-storage.com').transform((s) =>
      s.split(',').map((h) => h.trim()).filter(Boolean),
    ),
    MAX_FILE_MB: int(50),
    /** Chunks embedded per POST /documents/:id/process call. */
    INGEST_BATCH_SIZE: int(256),
    /** Texts per embedding API request. */
    EMBED_BATCH_SIZE: int(64),
  })
  .refine((e) => e.TOP_N <= e.TOP_K, { path: ['TOP_N'], message: 'must be <= TOP_K' })
  .transform((e) => ({ ...e, LOG_FORMAT: e.LOG_FORMAT ?? (e.NODE_ENV === 'production' ? 'json' : 'pretty') }));

/**
 * @typedef {z.infer<typeof EnvSchema>} Config
 */

/** Old provider-specific names and what replaced them. Setting one is a config error. */
export const RENAMED_ENV = Object.freeze({
  OPENAI_BASE_URL: 'EMBED_BASE_URL',
  OPENAI_API_KEY: 'EMBED_API_KEY',
  VOYAGE_API_KEY: 'EMBED_API_KEY (EMBED_PROVIDER=voyage) or RERANK_API_KEY (RERANK_PROVIDER=voyage)',
  COHERE_API_KEY: 'RERANK_API_KEY',
  JINA_API_KEY: 'RERANK_API_KEY',
});

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Pure: parse + validate an env object. Throws ConfigError listing every problem.
 * Provider API keys are optional here; each provider checks its own key when
 * it is constructed (later steps), so /health works with only MONGODB_URI set.
 * @param {Record<string, string | undefined>} env
 * @returns {Readonly<Config>}
 */
export function loadConfig(env) {
  const result = EnvSchema.safeParse(env);
  const problems = result.success
    ? []
    : result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  for (const [old, now] of Object.entries(RENAMED_ENV)) {
    if (blankToUndefined(env[old]) !== undefined) problems.push(`${old}: was renamed, use ${now}`);
  }
  if (problems.length) throw new ConfigError(problems);
  return Object.freeze(/** @type {Config} */ (result.data));
}

/** @type {Readonly<Config> | undefined} */
let cached;

/**
 * Validated config from process.env (parsed once per process; config is
 * immutable, so this is not request state).
 * @returns {Readonly<Config>}
 */
export function getConfig() {
  cached ??= loadConfig(process.env);
  return cached;
}
