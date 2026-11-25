import { describe, it, expect } from 'vitest';
import { diagnoseConfig } from '../src/diagnostics.js';
import { loadConfig } from '../src/config.js';

const good = {
  MONGODB_URI: 'mongodb+srv://u:p@c.example.net/',
  EMBED_API_KEY: 'sk-abc',
  EMBED_BASE_URL: 'https://res.openai.azure.com/openai/v1',
  LLM_BASE_URL: 'https://res.openai.azure.com/openai/v1',
  LLM_API_KEY: 'azure-key',
  RERANK_PROVIDER: 'none',
  VERIDOC_API_KEY: 'vd_0123456789abcdef0123456789abcdef',
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x',
  OCR_PROVIDER: 'openai-compatible',
  OCR_API_KEY: 'ocr-key',
  OCR_MODEL: 'google/gemini-flash',
};
const diagnose = (env) => diagnoseConfig(loadConfig({ ...good, ...env }));
const errors = (env) => diagnose(env).filter((f) => f.level === 'error').map((f) => f.message);

describe('diagnoseConfig', () => {
  it('reports ok for a good config', () => {
    expect(diagnose({})).toEqual([{ level: 'ok', area: 'config', message: 'No configuration errors found' }]);
  });

  it('flags a URL pasted into a key', () => {
    expect(errors({ LLM_API_KEY: 'https://res.openai.azure.com' })).toEqual([
      'LLM_API_KEY contains a URL, not a key',
    ]);
  });

  it('flags Azure base URLs without /openai/v1 and suggests the fix', () => {
    const f = diagnose({ EMBED_BASE_URL: 'https://res.openai.azure.com/' }).find((x) => x.level === 'error');
    expect(f.message).toMatch(/EMBED_BASE_URL .* without the \/openai\/v1/);
    expect(f.fix).toBe('EMBED_BASE_URL=https://res.openai.azure.com/openai/v1');
    expect(errors({ LLM_BASE_URL: 'https://res.openai.azure.com' })[0]).toMatch(/LLM_BASE_URL/);
  });

  it('does not flag non-Azure base URLs', () => {
    expect(errors({ EMBED_BASE_URL: 'https://openrouter.ai/api/v1', LLM_BASE_URL: 'https://api.groq.com/openai/v1' })).toEqual([]);
  });

  it('flags missing provider keys', () => {
    expect(errors({ EMBED_API_KEY: '' })[0]).toMatch(/EMBED_API_KEY is empty/);
    expect(errors({ RERANK_PROVIDER: 'cohere' })[0]).toMatch(/RERANK_PROVIDER=cohere but RERANK_API_KEY is empty/);
    expect(errors({ RERANK_PROVIDER: 'jina', RERANK_API_KEY: 'jina_x' })).toEqual([]);
    expect(errors({ LLM_API_KEY: '' })[0]).toMatch(/LLM_API_KEY is empty/);
  });

  it('checks voyage settings', () => {
    const e = errors({ EMBED_PROVIDER: 'voyage', EMBED_API_KEY: '' });
    expect(e).toContain('EMBED_API_KEY is empty');
    expect(e).toContain('EMBED_MODEL=text-embedding-3-small is an OpenAI model');
  });

  it('warns locally and errors in production for auth / open source hosts', () => {
    const local = diagnose({ VERIDOC_API_KEY: '', SOURCE_URL_HOSTS: '*' });
    expect(local.filter((f) => f.level === 'warn').map((f) => f.area)).toEqual(['auth', 'ingest']);
    const prod = errors({ VERIDOC_API_KEY: '', SOURCE_URL_HOSTS: '*', NODE_ENV: 'production' });
    expect(prod).toHaveLength(2);
  });

  it('checks OCR and OpenRouter model ids', () => {
    expect(diagnose({ OCR_PROVIDER: 'none' }).find((f) => f.area === 'ocr').level).toBe('warn');
    expect(errors({ OCR_MODEL: '' })).toEqual(['OCR_PROVIDER is set but OCR_MODEL is empty']);
    expect(errors({ LLM_BASE_URL: 'https://openrouter.ai/api/v1', LLM_MODEL: 'gpt-4o-mini' })[0]).toMatch(/isn't an OpenRouter model id/);
    expect(errors({ LLM_BASE_URL: 'https://openrouter.ai/api/v1', LLM_MODEL: 'openrouter/free' })).toEqual([]);
  });

  it('warns about a missing blob token', () => {
    expect(diagnose({ BLOB_READ_WRITE_TOKEN: '' }).find((f) => f.area === 'blob').level).toBe('warn');
  });
});
