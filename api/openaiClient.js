// api/openaiClient.js
import OpenAI from "openai";

let _client = null;

/**
 * Preferred + fallback models.
 * You can add more (e.g. 'gpt-4.1', 'gpt-4o', etc.)
 */
const PRIMARY_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || "gpt-4o-mini";

/**
 * Standardized retry strategy (429, 500, ETIMEDOUT)
 */
const RETRYABLE = new Set(["rate_limit_exceeded", "server_error", "timeout"]);

/**
 * A small utility to add timeouts to all OpenAI calls.
 */
function withTimeout(promise, ms = 12_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("request_timeout")), ms)
    ),
  ]);
}

/**
 * Internal function that wraps OpenAI calls with:
 * - fallback model
 * - retry on timeouts / 429 / 500
 * - logging
 */
async function runWithResilience(fn) {
  const start = Date.now();
  let lastErr = null;

  // Up to 3 attempts
  for (let attempt = 1; attempt <= 3; attempt++) {
    const usingFallback = attempt === 3;

    try {
      const result = await withTimeout(
        fn(usingFallback ? FALLBACK_MODEL : PRIMARY_MODEL)
      );

      const ms = Date.now() - start;
      console.debug(
        `[openai] success in ${ms}ms${usingFallback ? " (fallback model)" : ""}`
      );
      return result;
    } catch (err) {
      lastErr = err;
      const code = err?.code || err?.error?.code || err?.message;

      console.warn(`[openai] attempt ${attempt} failed:`, code);

      if (!RETRYABLE.has(code) && code !== "request_timeout") {
        // Non-retryable → break early
        break;
      }

      // Retry with small backoff
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  console.error("[openai] all attempts failed:", lastErr);
  throw lastErr;
}

/**
 * Singleton getter for OpenAI client + resiliency wrapper.
 */
export function getOpenAI() {
  if (_client) return _client;

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  // Raw SDK instance
  const base = new OpenAI({ apiKey: key });

  // Wrap completions + chat completions to add resiliency
  _client = {
    ...base,

    // Wrapped chat.completions.create
    chat: {
      completions: {
        create: async (payload) =>
          runWithResilience(async (model) => {
            const p = { ...payload, model };
            return base.chat.completions.create(p);
          }),
      },
    },

    // Optionally wrap embeddings if used
    embeddings: {
      create: async (payload) =>
        runWithResilience(async (model) => {
          const p = { ...payload, model };
          return base.embeddings.create(p);
        }),
    },
  };

  console.log(
    `[openai] client initialized | primary=${PRIMARY_MODEL}, fallback=${FALLBACK_MODEL}`
  );
  return _client;
}
