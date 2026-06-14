/**
 * @file brain/custom-providers.ts
 * @description Pluggable OpenAI-compatible model providers (gap #27).
 *
 * Opens the otherwise-closed ProviderName switch: register ADDITIONAL providers
 * at boot from the `SUDO_CUSTOM_PROVIDERS` env (a JSON array) so sudo can talk to
 * ANY OpenAI-compatible endpoint (vLLM, LM Studio, OpenRouter, a local server, a
 * new vendor) WITHOUT a core code change. providers.ts consults this registry
 * when a model string's provider isn't one of the built-ins.
 *
 * Slice 1 covers OpenAI-compatible endpoints only (`createOpenAI` + baseURL) —
 * the exact mechanism the built-in mistral/deepseek/together/ollama cases
 * already use. Non-OpenAI-shaped providers (a fresh AI-SDK adapter) are a
 * follow-up. Opt-in: when `SUDO_CUSTOM_PROVIDERS` is unset the registry is empty
 * and resolution is byte-identical to before.
 *
 * Trust note: a baseURL is an endpoint sudo sends prompts + the API key to. It
 * is OPERATOR-configured (not model-controlled), so it is treated as trusted;
 * plaintext http to a non-local host is warned about, not blocked.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:custom-providers');

/** A single custom provider declaration (one element of SUDO_CUSTOM_PROVIDERS). */
export interface CustomProviderConfig {
  /** Provider prefix used in model strings: "<name>/<model-id>". */
  name: string;
  /** OpenAI-compatible base URL, e.g. "https://openrouter.ai/api/v1". */
  baseURL: string;
  /** Inline API key. Prefer apiKeyEnv to keep secrets out of config. */
  apiKey?: string;
  /** Name of an env var holding the API key. */
  apiKeyEnv?: string;
  /** AI SDK OpenAI compatibility mode (default 'compatible'). */
  compatibility?: 'compatible' | 'strict';
}

type OpenAICompatProvider = ReturnType<typeof createOpenAI>;

/**
 * Provider names must be a lowercase model-string-safe token. Lowercase-only
 * (no `/i`) so a mixed-case name can't slip past the lowercase reserved-name
 * set and shadow a built-in (e.g. "OpenAI" resolving before the built-in switch).
 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

const registry = new Map<string, OpenAICompatProvider>();

/** Reset the registry (tests only). */
export function clearCustomProviders(): void {
  registry.clear();
}

export function isCustomProvider(name: string): boolean {
  return registry.has(name);
}

export function getCustomProvider(name: string): OpenAICompatProvider | null {
  return registry.get(name) ?? null;
}

export function listCustomProviders(): string[] {
  return [...registry.keys()];
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

  try {
    const instance = createOpenAI({
      apiKey,
      baseURL,
      name,
      compatibility: config.compatibility ?? 'compatible',
    } as Parameters<typeof createOpenAI>[0]);
    registry.set(name, instance);
    log.info({ name, baseURL }, 'custom provider registered');
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
