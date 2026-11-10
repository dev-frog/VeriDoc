import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

const base = { MONGODB_URI: 'mongodb+srv://u:p@cluster.example.net/' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.MONGODB_DB).toBe('veridoc');
    expect(c.EMBED_PROVIDER).toBe('openai');
    expect(c.RERANK_PROVIDER).toBe('cohere');
    expect(c.CHUNK_TOKENS).toBe(600);
    expect(c.CHUNK_OVERLAP).toBe(0.12);
    expect(c.TOP_K).toBe(30);
    expect(c.TOP_N).toBe(5);
  });

  it('coerces numeric strings and treats blanks as unset', () => {
    const c = loadConfig({ ...base, TOP_K: '50', OPENAI_API_KEY: '', CHUNK_TOKENS: '' });
    expect(c.TOP_K).toBe(50);
    expect(c.OPENAI_API_KEY).toBeUndefined();
    expect(c.CHUNK_TOKENS).toBe(600);
  });

  it('fails when MONGODB_URI is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/MONGODB_URI/);
  });

  it('reports every problem at once', () => {
    try {
      loadConfig({ MONGODB_URI: 'http://x', EMBED_PROVIDER: 'nope', CHUNK_OVERLAP: '0.9' });
      expect.unreachable();
    } catch (e) {
      expect(e.problems.map((p) => p.split(':')[0]).sort()).toEqual(
        ['CHUNK_OVERLAP', 'EMBED_PROVIDER', 'MONGODB_URI'],
      );
    }
  });

  it('rejects TOP_N > TOP_K', () => {
    expect(() => loadConfig({ ...base, TOP_K: '3', TOP_N: '5' })).toThrow(/TOP_N/);
  });
});
