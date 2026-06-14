/**
 * Vercel AI SDK provider factory layer.
 *
 * Wraps createXai / createOpenAI / createAnthropic / createGoogleGenerativeAI
 * into a single lookup interface. Only providers with env keys set are active.
 */

import { createXai } from '@ai-sdk/xai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { LLMError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
import {
  registerCustomProvidersFromEnv,
  isCustomProvider,
  getCustomProvider,
  listCustomProviders,
} from './custom-providers.js';

const log = createLogger('brain:providers');

// ---------------------------------------------------------------------------
// Provider name union
// ---------------------------------------------------------------------------

export type ProviderName =
  | 'ollama'
  | 'xai'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'together';

// ---------------------------------------------------------------------------
// Lazy provider instance cache
// ---------------------------------------------------------------------------

type AnyProvider = ReturnType<
  | typeof createXai
  | typeof createOpenAI
  | typeof createAnthropic
  | typeof createGoogleGenerativeAI
>;

const providerCache = new Map<ProviderName, AnyProvider>();

/** Env variable names for each provider. */
const ENV_KEYS: Record<ProviderName, string> = {
  xai: 'XAI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY', // Also checks ANTHROPIC_AUTH_TOKEN for OAuth
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  ollama: 'OLLAMA_URL', // Ollama Cloud URL
  together: 'TOGETHER_API_KEY',
};

/**
 * Build and cache a provider instance. Returns null when the API key is absent
 * or the required SDK is not installed.
 */
async function instantiateProvider(name: ProviderName, explicitKey?: string): Promise<AnyProvider | null> {
  const envKey = ENV_KEYS[name];
  // For Anthropic: check both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN (OAuth)
  const envValue = explicitKey ?? (name === 'anthropic'
    ? (process.env[envKey] || process.env['ANTHROPIC_AUTH_TOKEN'])
    : process.env[envKey]);

  // Ollama is local — no API key required, but OLLAMA_URL env may override base.
  if (name !== 'ollama' && !envValue) {
    log.debug({ provider: name, envKey }, 'API key not set — provider unavailable');
    return null;
  }

  let instance: AnyProvider;

  try {
    switch (name) {
      case 'xai':
        instance = createXai({ apiKey: envValue! });
        break;

      case 'openai':
        instance = createOpenAI({ apiKey: envValue! });
        break;

      case 'anthropic': {
        if (envValue!.startsWith('sk-ant-oat')) {
          instance = createAnthropic({ authToken: envValue! } as Parameters<typeof createAnthropic>[0]);
          log.info('Anthropic: using OAuth authToken');
        } else {
          instance = createAnthropic({ apiKey: envValue! });
        }
        break;
      }

      case 'google':
        instance = createGoogleGenerativeAI({ apiKey: envValue! });
        break;

      case 'groq': {
        // Dynamic import — gracefully skip if @ai-sdk/groq not installed.
        const mod = await import('@ai-sdk/groq').catch((err) => {
          log.warn({ err: String(err) }, 'groq: @ai-sdk/groq not installed — provider unavailable');
          return null;
        });
        if (!mod) return null;
        instance = mod.createGroq({ apiKey: envValue! }) as unknown as AnyProvider;
        break;
      }

      case 'mistral': {
        // Mistral via OpenAI-compatible endpoint.
        instance = createOpenAI({
          apiKey: envValue!,
          baseURL: 'https://api.mistral.ai/v1',
          name: 'mistral',
        } as Parameters<typeof createOpenAI>[0]);
        break;
      }

      case 'deepseek': {
        // DeepSeek uses an OpenAI-compatible API.
        instance = createOpenAI({
          apiKey: envValue!,
          baseURL: 'https://api.deepseek.com/v1',
          name: 'deepseek',
        } as Parameters<typeof createOpenAI>[0]);
        break;
      }

      case 'ollama': {
        // Ollama Cloud (primary) — deepseek-v4-pro:cloud via https://ollama.com/v1
        // OLLAMA_URL env may override; OLLAMA_API_KEY for cloud auth.
        const baseURL = envValue ?? 'https://ollama.com/v1';
        const ollamaApiKey = process.env['OLLAMA_API_KEY'] ?? 'ollama';
        instance = createOpenAI({
          apiKey: ollamaApiKey,
          baseURL,
          name: 'ollama',
          compatibility: 'compatible',  // Force Chat Completions API format
        } as Parameters<typeof createOpenAI>[0]);
        log.info({ url: baseURL }, 'Ollama provider registered (Cloud-first)');
        break;
      }

      case 'together': {
        // Together AI uses an OpenAI-compatible API.
        instance = createOpenAI({
          apiKey: envValue!,
          baseURL: 'https://api.together.xyz/v1',
          name: 'together',
        } as Parameters<typeof createOpenAI>[0]);
        break;
      }

      default: {
        const _exhaustive: never = name;
        throw new LLMError(`Unknown provider: ${String(_exhaustive)}`, 'llm_unknown_provider');
      }
    }
  } catch (err) {
    if (err instanceof LLMError) throw err;
    log.error({ provider: name, err: String(err) }, 'Failed to instantiate provider');
    return null;
  }

  log.debug({ provider: name, keyed: explicitKey !== undefined }, 'Provider instance created');
  return instance;
}

/**
 * Build and cache the env-key provider instance for a provider name.
 * Returns null when the API key is absent or the required SDK is not installed.
 */
async function buildProviderAsync(name: ProviderName): Promise<AnyProvider | null> {
  if (providerCache.has(name)) {
    return providerCache.get(name)!;
  }
  const instance = await instantiateProvider(name);
  if (instance) providerCache.set(name, instance);
  return instance;
}

/** Cache for provider instances built with an explicit (rotated) API key. */
const keyedProviderCache = new Map<string, AnyProvider>();

/**
 * Build (and cache) a provider instance bound to a SPECIFIC API key — used by the
 * auth-profile rotation path so a rotated key actually takes effect. Keyed by
 * provider name + key so repeated calls reuse the same SDK instance.
 */
async function buildProviderWithKey(name: ProviderName, apiKey: string): Promise<AnyProvider | null> {
  const cacheKey = `${name}#${apiKey}`;
  const cached = keyedProviderCache.get(cacheKey);
  if (cached) return cached;
  const instance = await instantiateProvider(name, apiKey);
  if (instance) keyedProviderCache.set(cacheKey, instance);
  return instance;
}

/**
 * Synchronous wrapper that returns from cache or null.
 * For new providers that need async init use getProviderAsync.
 */
function buildProvider(name: ProviderName): AnyProvider | null {
  return providerCache.get(name) ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All known provider names in priority order. */
const ALL_PROVIDERS: ProviderName[] = [
  'ollama', 'xai', 'openai', 'anthropic', 'google',
  'groq', 'mistral', 'deepseek', 'together',
];

/**
 * Initialise all providers whose env keys are set.
 * Call once at startup so getProvider/getModel can work synchronously.
 */
export async function initProviders(): Promise<void> {
  const results = await Promise.allSettled(
    ALL_PROVIDERS.map((name) => buildProviderAsync(name)),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      log.error({ provider: ALL_PROVIDERS[i], err: String(r.reason) }, 'Provider init failed');
    }
  });
  // Pluggable providers (gap #27): opt-in via SUDO_CUSTOM_PROVIDERS. No-op when unset.
  registerCustomProvidersFromEnv(new Set<string>(ALL_PROVIDERS));
  log.info(
    { initialized: [...providerCache.keys()], custom: listCustomProviders() },
    'Providers initialized',
  );
}

/**
 * Return the provider instance for the given name.
 * Requires initProviders() to have been awaited first.
 *
 * @throws LLMError when the provider has no API key configured.
 */
export function getProvider(name: ProviderName): AnyProvider {
  const provider = buildProvider(name);
  if (!provider) {
    throw new LLMError(
      `Provider "${name}" is not configured — set ${ENV_KEYS[name]}`,
      'llm_provider_unconfigured',
      { provider: name },
    );
  }
  return provider;
}

/**
 * Return a Vercel AI SDK LanguageModel handle for the given model string.
 *
 * @param modelString - Format: "provider/model-id" e.g. "xai/grok-3-fast".
 * @throws LLMError on invalid format or missing provider.
 */
export function getModel(modelString: string): ReturnType<AnyProvider> {
  if (!modelString || !modelString.includes('/')) {
    throw new LLMError(
      `Invalid model string "${modelString}" — expected "provider/model-id"`,
      'llm_invalid_model_string',
      { modelString },
    );
  }

  const slashIndex = modelString.indexOf('/');
  const providerName = modelString.slice(0, slashIndex) as ProviderName;
  const modelId = modelString.slice(slashIndex + 1);

  if (!modelId) {
    throw new LLMError(
      `Empty model ID in "${modelString}"`,
      'llm_invalid_model_string',
      { modelString },
    );
  }

  if (!ALL_PROVIDERS.includes(providerName)) {
    // Pluggable custom providers (gap #27) — OpenAI-compatible, registered from
    // SUDO_CUSTOM_PROVIDERS. Resolved here only after the built-in switch misses.
    if (isCustomProvider(providerName)) {
      const custom = getCustomProvider(providerName)!;
      log.debug({ modelString, providerName, modelId, custom: true }, 'Resolved custom model handle');
      return custom.chat(modelId) as ReturnType<AnyProvider>;
    }
    throw new LLMError(
      `Unknown provider "${providerName}" in model string "${modelString}"`,
      'llm_unknown_provider',
      { providerName, modelString },
    );
  }

  const provider = getProvider(providerName);

  log.debug({ modelString, providerName, modelId }, 'Resolved model handle');

  // Vercel AI SDK providers:
  // - OpenAI-compatible providers (ollama, mistral, deepseek, together, groq) use provider.chat(modelId)
  // - Native providers (xai, openai, anthropic, google) use provider(modelId) directly
  const openAiCompatibleProviders: ProviderName[] = ['ollama', 'mistral', 'deepseek', 'together', 'groq'];

  if (openAiCompatibleProviders.includes(providerName)) {
    // OpenAI-compatible providers need .chat() to get the LanguageModel
    return (provider as { chat: (id: string) => ReturnType<AnyProvider> }).chat(modelId);
  }

  // Native providers can be called directly
  return (provider as (id: string) => ReturnType<AnyProvider>)(modelId);
}

/**
 * Resolve a Vercel AI SDK model handle for `modelString` using a SPECIFIC API key
 * (auth-profile rotation). Mirrors getModel()'s provider-kind handling, but builds
 * the provider with the supplied key instead of the env key.
 *
 * @param modelString - "provider/model-id".
 * @param apiKey      - The rotated API key to bind this provider instance to.
 * @throws LLMError on invalid format or when the provider cannot be built.
 */
export async function getModelWithKey(modelString: string, apiKey: string): Promise<ReturnType<AnyProvider>> {
  const slashIndex = modelString.indexOf('/');
  if (slashIndex < 0) {
    throw new LLMError(
      `Invalid model string "${modelString}" — expected "provider/model-id"`,
      'llm_invalid_model_string',
      { modelString },
    );
  }
  const providerName = modelString.slice(0, slashIndex) as ProviderName;
  const modelId = modelString.slice(slashIndex + 1);

  // Custom providers (gap #27) carry their own configured key — key rotation
  // does not apply, so resolve them directly from the registry.
  if (isCustomProvider(providerName)) {
    return getCustomProvider(providerName)!.chat(modelId) as ReturnType<AnyProvider>;
  }

  const provider = await buildProviderWithKey(providerName, apiKey);
  if (!provider) {
    throw new LLMError(
      `Provider "${providerName}" could not be built with the supplied key`,
      'llm_provider_unconfigured',
      { provider: providerName },
    );
  }

  // OpenAI-compatible providers need .chat() to get the LanguageModel;
  // native providers are callable directly. Mirrors getModel().
  const openAiCompatibleProviders: ProviderName[] = ['ollama', 'mistral', 'deepseek', 'together', 'groq'];
  if (openAiCompatibleProviders.includes(providerName)) {
    return (provider as { chat: (id: string) => ReturnType<AnyProvider> }).chat(modelId);
  }
  return (provider as (id: string) => ReturnType<AnyProvider>)(modelId);
}

/**
 * Return the list of provider names that have been successfully initialized.
 */
export function listAvailableProviders(): ProviderName[] {
  const available = [...providerCache.keys()] as ProviderName[];
  log.debug({ available }, 'Available providers');
  return available;
}

/**
 * Return the env variable name expected for a given provider.
 * Useful for diagnostic messages.
 */
export function getEnvKeyForProvider(name: ProviderName): string {
  return ENV_KEYS[name];
}
