// api/openaiClient.js
import OpenAI from 'openai';

let _client = null;

/**
 * Returns a singleton OpenAI client.
 * Requires OPENAI_API_KEY in environment.
 */
export function getOpenAI() {
  if (_client) return _client;

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  _client = new OpenAI({ apiKey: key });
  return _client;
}
