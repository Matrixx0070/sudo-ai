/**
 * @file brain/custom-providers.ts
 * @description Pluggable model providers (gap #27).
 *
 * Opens the otherwise-closed ProviderName switch: register ADDITIONAL providers
 * at boot from the `SUDO_CUSTOM_PROVIDERS` env (a JSON array) so sudo can talk to
 * ANY supported endpoint WITHOUT a core code change. providers.ts consults this
 * registry when a model string's provider isn't one of the built-ins.
 *
 * Each entry picks an `adapter` — the AI-SDK provider shape to build it with:
 *   - 'openai' (default): createOpenAI + baseURL — OpenAI-compatible endpoints
 *     (vLLM, LM Studio, OpenRouter, a local server). Model handle via `.chat(id)`.
 *   - 'anthropic': createAnthropic + baseURL — an Anthropic-API-shaped endpoint
 *     (e.g. a gateway/proxy). Native handle via `provider(id)`.
 *   - 'google': createGoogleGenerativeAI + baseURL — a Gemini-API-shaped endpoint.
 *     Native handle.
 * Opt-in: when `SUDO_CUSTOM_PROVIDERS` is unset the registry is empty and
 * resolution is byte-identical to before.
 *
 * Trust note: a baseURL is an endpoint sudo sends prompts + the API key to. It
 * is OPERATOR-configured (not model-controlled), so it is treated as trusted;
 * plaintext http to a non-local host is warned about, not blocked.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:custom-providers');

/** Which AI-SDK provider shape a custom endpoint speaks. */
export type CustomAdapter = 'openai' | 'anthropic' | 'google';

/** A single custom provider declaration (one element of SUDO_CUSTOM_PROVIDERS). */
export interface CustomProviderConfig {
  /** Provider prefix used in model strings: "<name>/<model-id>". */
  name: string;
  /** Base URL of the endpoint, e.g. "https://openrouter.ai/api/v1". */
  baseURL: string;
  /** Inline API key. Prefer apiKeyEnv to keep secrets out of config. */
  apiKey?: string;
  /** Name of an env var holding the API key. */
  apiKeyEnv?: string;
  /** Which AI-SDK adapter to build with (default 'openai'). */
  adapter?: CustomAdapter;
  /** AI SDK OpenAI compatibility mode (default 'compatible'). openai adapter only. */
  compatibility?: 'compatible' | 'strict';
}

type AnyCustomProvider =
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createGoogleGenerativeAI>;

/** How a model handle is obtained: OpenAI-compatible via `.chat(id)`; native call directly. */
type ModelKind = 'native' | 'chat';

interface CustomProviderEntry {
  provider: AnyCustomProvider;
  modelKind: ModelKind;
}

/**
 * One adapter: the model-handle shape it produces + a factory that builds the SDK
 * provider from the resolved key + baseURL. Mirrors the built-in BUILTIN_PROVIDERS
 * registry in providers.ts — adding a new adapter is a one-line entry.
 */
interface AdapterSpec {
  modelKind: ModelKind;
  build(apiKey: string, baseURL: string, config: CustomProviderConfig): AnyCustomProvider;
}

const ADAPTERS: Record<CustomAdapter, AdapterSpec> = {
  openai: {
    modelKind: 'chat',
    build: (apiKey, baseURL, config) =>
      createOpenAI({
        apiKey,
        baseURL,
        name: config.name,
        compatibility: config.compatibility ?? 'compatible',
      } as Parameters<typeof createOpenAI>[0]),
  },
  anthropic: {
    modelKind: 'native',
    build: (apiKey, baseURL) =>
      createAnthropic({ apiKey, baseURL } as Parameters<typeof createAnthropic>[0]),
  },
  google: {
    modelKind: 'native',
    build: (apiKey, baseURL) =>
      createGoogleGenerativeAI({ apiKey, baseURL } as Parameters<typeof createGoogleGenerativeAI>[0]),
  },
};

/**
 * Provider names must be a lowercase model-string-safe token. Lowercase-only
 * (no `/i`) so a mixed-case name can't slip past the lowercase reserved-name
 * set and shadow a built-in (e.g. "OpenAI" resolving before the built-in switch).
 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

const registry = new Map<string, CustomProviderEntry>();

/** Reset the registry (tests only). */
export function clearCustomProviders(): void {
  registry.clear();
}

export function isCustomProvider(name: string): boolean {
  return registry.has(name);
}

/** The built SDK provider instance for a custom name (null if unregistered). */
export function getCustomProvider(name: string): AnyCustomProvider | null {
  return registry.get(name)?.provider ?? null;
}

export function listCustomProviders(): string[] {
  return [...registry.keys()];
}

/**
 * Resolve a LanguageModel handle for a registered custom provider, honoring its
 * adapter's model kind: OpenAI-compatible → `.chat(id)`; anthropic/google native
 * → `provider(id)`. Returns null when the name isn't registered.
 */
export function resolveCustomModel(name: string, modelId: string): unknown {
  const entry = registry.get(name);
  if (!entry) return null;
  if (entry.modelKind === 'chat') {
    return (entry.provider as { chat: (id: string) => unknown }).chat(modelId);
  }
  return (entry.provider as unknown as (id: string) => unknown)(modelId);
}

/**
 * Validate + register one custom provider. Returns true on success, false (with
 * a warning) on any validation failure — never throws, so one bad entry can't
 * break boot.
 *
 * @param config   - The provider declaration.
 * @param reserved - Names that must not be shadowed (the built-in ProviderNames).
 */
export function registerCustomProvider(
  config: CustomProviderConfig,
  reserved: ReadonlySet<string>,
): boolean {
  const name = (config?.name ?? '').trim();
  if (!name || !NAME_RE.test(name)) {
    log.warn({ name }, 'custom provider: invalid name — skipped');
    return false;
  }
  if (reserved.has(name)) {
    log.warn({ name }, 'custom provider: name collides with a built-in provider — skipped');
    return false;
  }
  if (registry.has(name)) {
    log.warn({ name }, 'custom provider: duplicate name — skipped');
    return false;
  }

  const baseURL = (config.baseURL ?? '').trim();
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    log.warn({ name, baseURL }, 'custom provider: invalid baseURL — skipped');
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    log.warn({ name, baseURL }, 'custom provider: baseURL must be http(s) — skipped');
    return false;
  }
  const isLocal =
    url.hostname === 'localhost' ||
    url.hostname.startsWith('127.') ||
    url.hostname === '0.0.0.0' ||
    url.hostname === '::1' ||
    url.hostname === '::';
  if (url.protocol === 'http:' && !isLocal) {
    log.warn(
      { name, baseURL },
      'custom provider: plaintext http to a non-local host — prompts and the API key are sent in the clear',
    );
  }

  const apiKey = config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);
  if (!apiKey) {
    log.warn({ name, apiKeyEnv: config.apiKeyEnv }, 'custom provider: no API key (set apiKey or apiKeyEnv) — skipped');
    return false;
  }

  // adapter comes from untrusted JSON — treat as a string and validate against
  // the known set; an unknown value is skipped (fail-safe), default is 'openai'.
  const rawAdapter = (config as { adapter?: string }).adapter ?? 'openai';
  const adapter = (ADAPTERS as Record<string, AdapterSpec | undefined>)[rawAdapter];
  if (!adapter) {
    log.warn({ name, adapter: rawAdapter }, 'custom provider: unknown adapter (use openai|anthropic|google) — skipped');
    return false;
  }
  if (config.compatibility && rawAdapter !== 'openai') {
    log.warn({ name, adapter: rawAdapter }, 'custom provider: `compatibility` is ignored for non-openai adapters');
  }

  try {
    const instance = adapter.build(apiKey, baseURL, config);
    registry.set(name, { provider: instance, modelKind: adapter.modelKind });
    log.info({ name, baseURL, adapter: rawAdapter }, 'custom provider registered');
    return true;
  } catch (err) {
    log.error({ name, err: String(err) }, 'custom provider: failed to instantiate — skipped');
    return false;
  }
}

/**
 * Register every provider declared in `SUDO_CUSTOM_PROVIDERS` (a JSON array of
 * {@link CustomProviderConfig}). No-op when the env var is unset/empty.
 *
 * @returns the number of providers successfully registered.
 */
export function registerCustomProvidersFromEnv(reserved: ReadonlySet<string>): number {
  const raw = process.env['SUDO_CUSTOM_PROVIDERS'];
  if (!raw || raw.trim() === '') return 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn({ err: String(err) }, 'SUDO_CUSTOM_PROVIDERS is not valid JSON — ignored');
    return 0;
  }
  if (!Array.isArray(parsed)) {
    log.warn('SUDO_CUSTOM_PROVIDERS must be a JSON array — ignored');
    return 0;
  }

  let count = 0;
  for (const entry of parsed) {
    if (entry && typeof entry === 'object' && registerCustomProvider(entry as CustomProviderConfig, reserved)) {
      count++;
    }
  }
  if (count > 0) log.info({ count }, 'custom providers registered from SUDO_CUSTOM_PROVIDERS');
  return count;
}
