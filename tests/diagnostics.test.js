import { describe, it, expect } from 'vitest';
import { diagnoseConfig } from '../src/diagnostics.js';
import { loadConfig } from '../src/config.js';

const good = {
  MONGODB_URI: 'mongodb+srv://u:p@c.example.net/',
  OPENAI_API_KEY: 'sk-abc',
  OPENAI_BASE_URL: 'https://res.openai.azure.com/openai/v1',
  LLM_BASE_URL: 'https://res.openai.azure.com/openai/v1',
  LLM_API_KEY: 'azure-key',
  RERANK_PROVIDER: 'none',
  VERIDOC_API_KEY: 'vd_0123456789abcdef0123456789abcdef',
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x',
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
    const f = diagnose({ OPENAI_BASE_URL: 'https://res.openai.azure.com/' }).find((x) => x.level === 'error');
    expect(f.message).toMatch(/OPENAI_BASE_URL .* without the \/openai\/v1/);
    expect(f.fix).toBe('OPENAI_BASE_URL=https://res.openai.azure.com/openai/v1');
    expect(errors({ LLM_BASE_URL: 'https://res.openai.azure.com' })[0]).toMatch(/LLM_BASE_URL/);
  });

  it('does not flag non-Azure base URLs', () => {
    expect(errors({ OPENAI_BASE_URL: 'https://api.openai.com/v1', LLM_BASE_URL: 'https://api.groq.com/openai/v1' })).toEqual([]);
  });

  it('flags missing provider keys', () => {
    expect(errors({ OPENAI_API_KEY: '' })[0]).toMatch(/OPENAI_API_KEY is empty/);
    expect(errors({ RERANK_PROVIDER: 'cohere' })[0]).toMatch(/COHERE_API_KEY is empty/);
    expect(errors({ RERANK_PROVIDER: 'jina' })[0]).toMatch(/JINA_API_KEY is empty/);
    expect(errors({ LLM_API_KEY: '' })[0]).toMatch(/LLM_API_KEY is empty/);
  });

  it('checks voyage settings', () => {
    const e = errors({ EMBED_PROVIDER: 'voyage' });
    expect(e).toContain('EMBED_PROVIDER=voyage but VOYAGE_API_KEY is empty');
    expect(e).toContain('EMBED_MODEL=text-embedding-3-small is an OpenAI model');
  });

  it('warns locally and errors in production for auth / open source hosts', () => {
    const local = diagnose({ VERIDOC_API_KEY: '', SOURCE_URL_HOSTS: '*' });
    expect(local.filter((f) => f.level === 'warn').map((f) => f.area)).toEqual(['auth', 'ingest']);
    const prod = errors({ VERIDOC_API_KEY: '', SOURCE_URL_HOSTS: '*', NODE_ENV: 'production' });
    expect(prod).toHaveLength(2);
  });

  it('warns about a missing blob token', () => {
    expect(diagnose({ BLOB_READ_WRITE_TOKEN: '' }).find((f) => f.area === 'blob').level).toBe('warn');
  });
});
