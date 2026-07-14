/**
 * @file endpoints.ts
 * @description Single home for every LLM-provider base URL in the codebase.
 *
 * gw-refactor Phase 1 invariant: outside `src/llm/`, no file may contain a
 * provider hostname (api.openai.com, api.x.ai, api.anthropic.com,
 * api.groq.com, generativelanguage.googleapis.com, api.deepseek.com, ...).
 * Call sites that still speak to providers directly (legacy fallback, voice,
 * media, liveness probes) import their URL from here, so the CI grep that
 * enforces the choke point stays green and a provider swap is a one-file diff.
 */

/** Provider API base URLs (no trailing slash). */
export const PROVIDER_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
  anthropic: 'https://api.anthropic.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com/v1',
} as const;

export type ProviderHost = keyof typeof PROVIDER_BASE_URLS;

// ---- chat / completions --------------------------------------------------
export const XAI_CHAT_COMPLETIONS_URL = `${PROVIDER_BASE_URLS.xai}/chat/completions`;
export const OPENAI_CHAT_COMPLETIONS_URL = `${PROVIDER_BASE_URLS.openai}/chat/completions`;

// ---- embeddings ----------------------------------------------------------
export const OPENAI_EMBEDDINGS_URL = `${PROVIDER_BASE_URLS.openai}/embeddings`;

// ---- image generation ----------------------------------------------------
export const OPENAI_IMAGES_URL = `${PROVIDER_BASE_URLS.openai}/images/generations`;

// ---- audio: TTS ----------------------------------------------------------
export const XAI_TTS_URL = `${PROVIDER_BASE_URLS.xai}/audio/speech`;
export const OPENAI_TTS_URL = `${PROVIDER_BASE_URLS.openai}/audio/speech`;

// ---- audio: STT ----------------------------------------------------------
export const GROQ_STT_URL = `${PROVIDER_BASE_URLS.groq}/audio/transcriptions`;
export const OPENAI_STT_URL = `${PROVIDER_BASE_URLS.openai}/audio/transcriptions`;

// ---- model listing / liveness probes --------------------------------------
export const XAI_MODELS_URL = `${PROVIDER_BASE_URLS.xai}/models`;
export const OPENAI_MODELS_URL = `${PROVIDER_BASE_URLS.openai}/models`;
export const ANTHROPIC_MODELS_URL = `${PROVIDER_BASE_URLS.anthropic}/models`;
export const GOOGLE_MODELS_URL = `${PROVIDER_BASE_URLS.google}/models`;

/**
 * Hostnames for sandbox egress allowlists. Kept here so the allowlist can
 * never drift from the URLs the code actually calls.
 */
export const PROVIDER_HOSTNAMES: readonly string[] = Object.values(PROVIDER_BASE_URLS).map(
  (u) => new URL(u).hostname,
);
