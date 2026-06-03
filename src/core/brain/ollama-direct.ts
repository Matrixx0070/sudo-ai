/**
 * ollama-direct.ts
 *
 * Direct Ollama Cloud provider for SUDO-AI v4 brain.
 * Bypasses SUDOAPI gateway — calls Ollama Cloud directly.
 *
 * Model: deepseek-v4-pro:cloud via https://ollama.com/v1
 *
 * Environment variables:
 *   OLLAMA_URL       — Ollama Cloud base URL (default: https://ollama.com/v1)
 *   OLLAMA_API_KEY   — API key for Ollama Cloud auth
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createLogger } from '../shared/logger.js';
import { LLMError } from '../shared/errors.js';

const log = createLogger('brain:ollama-direct');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Ollama Cloud base URL */
export const OLLAMA_CLOUD_URL = process.env['OLLAMA_URL'] ?? 'https://ollama.com/v1';

/** Ollama Cloud API key */
export const OLLAMA_CLOUD_KEY = process.env['OLLAMA_API_KEY'] ?? 'ollama';

/** Primary model: DeepSeek V4 Pro via Ollama Cloud */
export const PRIMARY_MODEL = 'deepseek-v4-pro:cloud';

/** Fallback model: Qwen3.5 local */
export const FALLBACK_MODEL = 'qwen3.5:latest';

// ---------------------------------------------------------------------------
// Singleton provider instance
// ---------------------------------------------------------------------------

let _instance: ReturnType<typeof createOpenAI> | null = null;

/**
 * Return (and lazily construct) the Ollama OpenAI-compatible provider.
 */
export function getOllamaProvider(): ReturnType<typeof createOpenAI> {
  if (_instance) return _instance;

  try {
    _instance = createOpenAI({
      apiKey: OLLAMA_CLOUD_KEY,
      baseURL: OLLAMA_CLOUD_URL,
      name: 'ollama',
      compatibility: 'compatible',  // Force Chat Completions API
    } as Parameters<typeof createOpenAI>[0]);

    log.info({ url: OLLAMA_CLOUD_URL }, 'Ollama Cloud provider initialised');
    return _instance;
  } catch (err) {
    const msg = `Failed to create Ollama provider: ${String(err)}`;
    log.error({ err: String(err), url: OLLAMA_CLOUD_URL }, msg);
    throw new LLMError(msg, 'llm_provider_unconfigured', { provider: 'ollama' });
  }
}

/**
 * Resolve model string to Vercel AI SDK LanguageModel handle.
 *
 * @param modelId - Model ID e.g. "deepseek-v4-pro:cloud" or "qwen3.5:latest"
 * @returns A Vercel AI SDK LanguageModel.
 */
export function getOllamaModel(modelId: string): ReturnType<ReturnType<typeof createOpenAI>> {
  const provider = getOllamaProvider();
  log.debug({ modelId, url: OLLAMA_CLOUD_URL }, 'Resolved Ollama model handle');
  return provider.chat(modelId);
}

/**
 * Return true when Ollama provider is configured.
 */
export function isOllamaReady(): boolean {
  return Boolean(OLLAMA_CLOUD_URL);
}
