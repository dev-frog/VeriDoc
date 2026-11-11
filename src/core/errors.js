/**
 * Error codes raised by the core engine. The API layer maps them to HTTP
 * statuses; core itself knows nothing about HTTP.
 */
export const ErrorCodes = Object.freeze({
  NOT_FOUND: 'not_found',
  INVALID_INPUT: 'invalid_input',
  UNSUPPORTED_TYPE: 'unsupported_type',
  PARSE_FAILED: 'parse_failed',
  FETCH_FAILED: 'fetch_failed',
  PROVIDER_ERROR: 'provider_error',
  CONFIG_ERROR: 'config_error',
});

export class CoreError extends Error {
  /**
   * @param {string} code  one of ErrorCodes
   * @param {string} message  safe to show to API clients (never include secrets)
   * @param {{ retryable?: boolean, cause?: unknown, details?: Record<string, unknown> }} [opts]
   */
  constructor(code, message, { retryable = false, cause, details } = {}) {
    super(message, { cause });
    this.name = 'CoreError';
    this.code = code;
    /** True if the same call may succeed later (network blip, 5xx, rate limit). */
    this.retryable = retryable;
    this.details = details;
  }
}
