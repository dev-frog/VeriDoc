import { CoreError, ErrorCodes } from '../errors.js';
import { postJson } from '../http.js';
import { openAIAuthHeaders } from '../embed/openai.js';

/**
 * @typedef {{ role: 'system' | 'user' | 'assistant', content: string | object[] }} ChatMessage
 */

/**
 * @typedef {object} Llm
 * @property {string} model
 * @property {(messages: ChatMessage[], opts?: { maxTokens?: number, temperature?: number, extra?: object }) =>
 *   Promise<{ text: string, usage: object | null }>} chat
 */

/**
 * Chat completions via any OpenAI-compatible API (OpenAI, OpenRouter, Azure v1, Groq, ...).
 * @param {{ baseUrl: string, apiKey?: string, model?: string, temperature?: number, maxTokens?: number,
 *   keyName?: string, http?: import('../http.js').RetryOptions }} opts
 * @returns {Llm}
 */
export function createChatClient({ baseUrl, apiKey, model, temperature, maxTokens, keyName = 'LLM_API_KEY', http }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    model: model ?? '',
    async chat(messages, opts = {}) {
      if (!apiKey) throw new CoreError(ErrorCodes.CONFIG_ERROR, `${keyName} is not set`);
      if (!model) throw new CoreError(ErrorCodes.CONFIG_ERROR, `${keyName.replace('API_KEY', 'MODEL')} is not set`);
      const t = opts.temperature ?? temperature;
      const max = opts.maxTokens ?? maxTokens;
      const body = {
        model,
        messages,
        ...(t !== undefined && { temperature: t }),
        ...(max && { max_tokens: max }),
        ...opts.extra,
      };
      const json = await postJson('LLM', url, body, openAIAuthHeaders(baseUrl, apiKey), { timeoutMs: 120_000, ...http });
      const content = json?.choices?.[0]?.message?.content;
      const text = Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : content;
      if (typeof text !== 'string') {
        throw new CoreError(ErrorCodes.PROVIDER_ERROR, `LLM returned no message content${json?.error?.message ? `: ${json.error.message}` : ''}`, { retryable: true });
      }
      return { text: text.trim(), usage: json.usage ?? null };
    },
  };
}

/**
 * @param {{ LLM_BASE_URL: string, LLM_API_KEY?: string, LLM_MODEL: string, LLM_TEMPERATURE?: number, LLM_MAX_TOKENS: number }} config
 * @param {{ http?: import('../http.js').RetryOptions }} [deps]
 * @returns {Llm}
 */
export function createLlm(config, { http } = {}) {
  return createChatClient({
    baseUrl: config.LLM_BASE_URL,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
    temperature: config.LLM_TEMPERATURE,
    maxTokens: config.LLM_MAX_TOKENS,
    http,
  });
}
