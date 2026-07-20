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
/** xAI Responses-style endpoint — the metered developer API (api-key `xai`
 * family, and the legacy xai-oauth path before GX1). */
export const XAI_RESPONSES_URL = `${PROVIDER_BASE_URLS.xai}/responses`;
/**
 * Grok CLI subscription proxy — Responses-style endpoint served on the user's
 * Grok Business/SuperGrok SEAT (subscription-covered), NOT the metered
 * developer API. GX1: the `xai-oauth` provider routes here (same OAuth token,
 * different host + required grok-cli client headers) so calls draw the seat
 * instead of accruing per-token API spend. Verified live 2026-07-20 (HTTP 200).
 * Host is added to PROVIDER_HOSTNAMES below so the sandbox egress allowlist
 * covers it (it is not an api.<provider> host, so not in PROVIDER_BASE_URLS).
 */
export const XAI_CLI_PROXY_RESPONSES_URL = 'https://cli-chat-proxy.grok.com/v1/responses';
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
/**
 * xAI subscription (grok-cli) proxy model-list endpoint — the account-specific
 * model list the `xai-oauth` provider discovers live. Same host as the GX1
 * chat proxy (`cli-chat-proxy.grok.com`); served to the OAuth seat, never the
 * metered `api.x.ai` host. Requires the grok-cli client headers (see
 * xai-models.ts). Kept here so the choke-point grep + egress allowlist stay
 * in sync with the URLs the code calls.
 */
export const XAI_CLI_PROXY_MODELS_URL = 'https://cli-chat-proxy.grok.com/v1/models';
export const OPENAI_MODELS_URL = `${PROVIDER_BASE_URLS.openai}/models`;
export const ANTHROPIC_MODELS_URL = `${PROVIDER_BASE_URLS.anthropic}/models`;
export const GOOGLE_MODELS_URL = `${PROVIDER_BASE_URLS.google}/models`;

/**
 * Hostnames for sandbox egress allowlists. Kept here so the allowlist can
 * never drift from the URLs the code actually calls.
 */
export const PROVIDER_HOSTNAMES: readonly string[] = [
  ...Object.values(PROVIDER_BASE_URLS).map((u) => new URL(u).hostname),
  // GX1: the Grok CLI subscription proxy the xai-oauth family now calls.
  new URL(XAI_CLI_PROXY_RESPONSES_URL).hostname,
];
