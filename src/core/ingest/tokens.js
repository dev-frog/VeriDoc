import { Tiktoken } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';

/** @type {Tiktoken | undefined} */
let encoder;

/**
 * Token count using cl100k_base (the tokenizer of text-embedding-3-*).
 * Other providers tokenize differently, so treat the count as an estimate.
 * The encoder is built lazily once per process (a read-only cache, not request state).
 * @param {string} text
 * @returns {number}
 */
export function countTokens(text) {
  encoder ??= new Tiktoken(cl100k_base);
  return encoder.encode(text).length;
}
