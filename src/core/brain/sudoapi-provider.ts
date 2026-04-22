/**
 * sudoapi-provider.ts
 *
 * Routes brain.call() through the SUDOAPI gateway at https://sudoapi.shop.
 * The gateway exposes an OpenAI-compatible /v1/chat/completions endpoint,
 * so we reuse createOpenAI from @ai-sdk/openai with a custom baseURL.
 *
 * Supported model aliases (passed as model ID after "sudoapi/"):
 *   gpt-5.4           — GPT-5.4 via ChatGPT mobile capture
 *   claude-sonnet     — Claude Sonnet via Claude CLI proxy
 *   grok              — Grok-3 fast via xAI API
 *   gemini            — Gemini via Google API
 *
 * Environment variables:
 *   SUDOAPI_URL          — Upstream SUDOAPI base URL (default: https://sudoapi.shop)
 *   SUDOAPI_GATEWAY_URL  — Local gateway URL (default: http://127.0.0.1:18800)
 *   SUDOAPI_KEY          — Bearer token for gateway auth (default: sk-sudo-master)
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createLogger } from '../shared/logger.js';
import { LLMError } from '../shared/errors.js';

const log = createLogger('brain:sudoapi-provider');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Upstream SUDOAPI service URL — used by the local gateway to reach the real API. */
export const SUDOAPI_UPSTREAM = process.env['SUDOAPI_URL'] ?? 'https://sudoapi.shop';

/**
 * URL the brain calls.  When the local gateway is running (default), this
 * points to 127.0.0.1:18800 so all requests flow through the gateway's
 * concurrency limiter, retry logic, and SSE forwarding layer.
 *
 * Set SUDOAPI_GATEWAY_URL=https://sudoapi.shop to bypass the gateway and
 * call SUDOAPI directly (useful for debugging).
 */
export const SUDOAPI_URL = process.env['SUDOAPI_GATEWAY_URL'] ?? 'http://127.0.0.1:18800';

export const SUDOAPI_KEY = process.env['SUDOAPI_KEY'] ?? 'sk-sudo-master';

/** Model IDs exposed through SUDOAPI (maps sudoapi/X → gateway model ID). */
export const SUDOAPI_MODEL_MAP: Record<string, string> = {
  'sudo': 'sudo',
  'sudo-ultra': 'sudo-ultra',
  'sudo-agent': 'sudo-agent',
  'gpt-5.4': 'chatgpt',
  'gpt-5': 'gpt-5',
  'gpt-5.4-mini': 'gpt-5.4-mini',
  'o4': 'o4',
  'claude-sonnet': 'claude-sonnet',
  'claude-opus-4-7': 'claude-opus-4-7',
  'grok': 'grok',
  'gemini': 'gemini',
  'gemini-pro': 'gemini-pro',
  'gemini-flash': 'gemini-flash',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'deepseek-v3': 'deepseek-v3',
} as const;

// ---------------------------------------------------------------------------
// Singleton provider instance
// ---------------------------------------------------------------------------

let _instance: ReturnType<typeof createOpenAI> | null = null;

/**
 * Return (and lazily construct) the SUDOAPI OpenAI-compatible provider.
 * Throws LLMError when SUDOAPI_KEY is not configured.
 */
export function getSudoAPIProvider(): ReturnType<typeof createOpenAI> {
  if (_instance) return _instance;

  if (!process.env['SUDOAPI_KEY'] && SUDOAPI_KEY === 'sk-sudo-master') {
    log.warn(
      { url: SUDOAPI_URL },
      'SUDOAPI_KEY not set — using default placeholder key; set SUDOAPI_KEY in env',
    );
  }

  try {
    _instance = createOpenAI({
      apiKey: SUDOAPI_KEY,
      baseURL: `${SUDOAPI_URL}/v1`,
      name: 'sudoapi',
      compatibility: 'compatible',  // Force Chat Completions API (not Responses API)
    } as Parameters<typeof createOpenAI>[0]);

    log.info({ url: SUDOAPI_URL }, 'SUDOAPI provider initialised');
    return _instance;
  } catch (err) {
    const msg = `Failed to create SUDOAPI provider: ${String(err)}`;
    log.error({ err: String(err), url: SUDOAPI_URL }, msg);
    throw new LLMError(msg, 'llm_provider_unconfigured', { provider: 'sudoapi' });
  }
}

/**
 * Resolve a "sudoapi/model-alias" string to a Vercel AI SDK LanguageModel handle.
 *
 * @param modelAlias - The part after "sudoapi/" e.g. "gpt-5.4", "claude-sonnet".
 * @returns A Vercel AI SDK LanguageModel.
 * @throws LLMError if the alias is unknown.
 */
export function getSudoAPIModel(modelAlias: string): ReturnType<ReturnType<typeof createOpenAI>> {
  const gatewayModelId = SUDOAPI_MODEL_MAP[modelAlias];

  if (!gatewayModelId) {
    const known = Object.keys(SUDOAPI_MODEL_MAP).join(', ');
    throw new LLMError(
      `Unknown SUDOAPI model alias "${modelAlias}". Known aliases: ${known}`,
      'llm_invalid_model_string',
      { modelAlias },
    );
  }

  const provider = getSudoAPIProvider();
  log.debug({ modelAlias, gatewayModelId }, 'Resolved SUDOAPI model handle');
  // Use .chat() to force Chat Completions API (not Responses API)
  // SUDOAPI only supports /v1/chat/completions, not /v1/responses
  return provider.chat(gatewayModelId);
}

/**
 * Return true when SUDOAPI_KEY is set to a non-placeholder value,
 * indicating the gateway is ready for production use.
 */
export function isSudoAPIReady(): boolean {
  return Boolean(process.env['SUDOAPI_KEY']) && process.env['SUDOAPI_KEY'] !== 'sk-sudo-master';
}
