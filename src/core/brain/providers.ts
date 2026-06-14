/**
 * Vercel AI SDK provider factory layer.
 *
 * Wraps createXai / createOpenAI / createAnthropic / createGoogleGenerativeAI
 * into a single lookup interface. Only providers with env keys set are active.
 *
 * Built-in providers are declared in ONE data-driven registry (BUILTIN_PROVIDERS)
 * instead of a hardcoded switch: adding an OpenAI-compatible built-in is a
 * one-line spec entry, and ALL_PROVIDERS, the env-key lookup, and the
 * native-vs-`.chat()` handle resolution all derive from it. Custom providers
 * (SUDO_CUSTOM_PROVIDERS, gap #27) remain a parallel registry consulted on miss.
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
  resolveCustomModel,
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
  | 'claude-oauth'
  | 'google'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'together';

type AnyProvider = ReturnType<
  | typeof createXai
  | typeof createOpenAI
  | typeof createAnthropic
  | typeof createGoogleGenerativeAI
>;

// ---------------------------------------------------------------------------
// Built-in provider registry (replaces the former switch)
// ---------------------------------------------------------------------------

/**
 * Declarative spec for one built-in provider. `create` builds the SDK instance
 * from a resolved key/value; `modelKind` decides how a model handle is obtained
 * (native providers are callable directly; OpenAI-compatible ones need
 * `.chat(id)`). This is the single source of truth that ALL_PROVIDERS, the
 * env-key lookup, and getModel/getModelWithKey handle resolution derive from.
 */
interface BuiltinProviderSpec {
  /** Env var holding the API key (or the base URL, for ollama). */
  envKey: string;
  /** Secondary env var checked when envKey is unset (anthropic OAuth token). */
  fallbackEnvKey?: string;
  /** True when the provider needs no API key (ollama is local/cloud-keyless). */
  keyOptional?: boolean;
  /** How to turn the provider instance into a LanguageModel handle. */
  modelKind: 'native' | 'chat';
  /**
   * Build the SDK provider from the resolved env value (api key, or base URL for
   * ollama). Returns null when an optional SDK isn't installed (groq). May be async.
   */
  create(value: string | undefined): AnyProvider | null | Promise<AnyProvider | null>;
}

/**
 * The built-in providers, in priority order. Each entry's `create` is byte-for-
 * byte the body of the former switch case.
 */
const BUILTIN_PROVIDERS: Record<ProviderName, BuiltinProviderSpec> = {
  ollama: {
    envKey: 'OLLAMA_URL', // Ollama Cloud URL
    keyOptional: true, // Ollama is local — no API key required
    modelKind: 'chat',
    create(value) {
      // Ollama Cloud (primary) — deepseek-v4-pro:cloud via https://ollama.com/v1.
      // OLLAMA_URL env may override; OLLAMA_API_KEY for cloud auth.
      const baseURL = value ?? 'https://ollama.com/v1';
      const ollamaApiKey = process.env['OLLAMA_API_KEY'] ?? 'ollama';
      const instance = createOpenAI({
        apiKey: ollamaApiKey,
        baseURL,
        name: 'ollama',
        compatibility: 'compatible', // Force Chat Completions API format
      } as Parameters<typeof createOpenAI>[0]);
      log.info({ url: baseURL }, 'Ollama provider registered (Cloud-first)');
      return instance;
    },
  },
  xai: {
    envKey: 'XAI_API_KEY',
    modelKind: 'native',
    create(value) {
      return createXai({ apiKey: value! });
    },
  },
  openai: {
    envKey: 'OPENAI_API_KEY',
    modelKind: 'native',
    create(value) {
      return createOpenAI({ apiKey: value! });
    },
  },
  anthropic: {
    envKey: 'ANTHROPIC_API_KEY', // Also checks ANTHROPIC_AUTH_TOKEN for OAuth
    fallbackEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    modelKind: 'native',
    create(value) {
      if (value!.startsWith('sk-ant-oat')) {
        log.info('Anthropic: using OAuth authToken');
        return createAnthropic({ authToken: value! } as Parameters<typeof createAnthropic>[0]);
      }
      return createAnthropic({ apiKey: value! });
    },
  },
  // Anthropic via Claude.ai subscription OAuth (PKCE). The manager owns the
  // token and refreshes it in the background; passing the SDK an authToken
  // getter (instead of a frozen string) means each request reads the live
  // token, so a rotation takes effect on the very next call without rebuilding
  // the provider. `create()` only fails when the manager is not connected at
  // boot — login can happen later and the provider will start working as soon
  // as initProviders() is re-run or the cache is invalidated.
  'claude-oauth': {
    envKey: 'SUDO_CLAUDE_OAUTH_CONNECTED', // synthetic — set by the manager
    keyOptional: true, // gating happens via the manager, not env
    modelKind: 'native',
    async create() {
      const { getClaudeOAuthManager } = await import('./claude-oauth-manager.js');
      const mgr = getClaudeOAuthManager();
      if (!mgr.isAvailable()) {
        log.warn('claude-oauth: no credentials — run `sudo-ai claude-oauth login`');
        return null;
      }
      log.info('claude-oauth: provider registered (fetch interceptor Bearer)');
      return createAnthropic({
        // @ai-sdk/anthropic@3.x stringifies `authToken` via template literal
        // and spreads `headers` synchronously (so a function-form headers
        // option collapses to `{}`). Neither path supports live token rotation
        // at provider-create time. Instead we hand the SDK a sentinel auth
        // value (so it doesn't throw "no auth") and intercept every outgoing
        // request via `fetch`, rewriting Authorization with the live token
        // the manager holds at that moment. Refreshes propagate instantly.
        authToken: 'OAUTH_PLACEHOLDER_REPLACED_BY_FETCH_INTERCEPTOR',
        fetch: async (input, init) => {
          let token = mgr.getAccessToken();
          if (!token) {
            await mgr.refreshToken();
            token = mgr.getAccessToken();
          }
          const headers = new Headers(init?.headers);
          if (token) headers.set('Authorization', `Bearer ${token}`);
          // Sent to match Claude Code's outbound requests verbatim.
          headers.set('anthropic-beta', 'oauth-2025-04-20');
          return globalThis.fetch(input as Parameters<typeof globalThis.fetch>[0], { ...init, headers });
        },
      } as unknown as Parameters<typeof createAnthropic>[0]);
    },
  },
  google: {
    envKey: 'GEMINI_API_KEY',
    modelKind: 'native',
    create(value) {
      return createGoogleGenerativeAI({ apiKey: value! });
    },
  },
  groq: {
    envKey: 'GROQ_API_KEY',
    modelKind: 'chat',
    async create(value) {
      // Dynamic import — gracefully skip if @ai-sdk/groq not installed.
      const mod = await import('@ai-sdk/groq').catch((err) => {
        log.warn({ err: String(err) }, 'groq: @ai-sdk/groq not installed — provider unavailable');
        return null;
      });
      if (!mod) return null;
      return mod.createGroq({ apiKey: value! }) as unknown as AnyProvider;
    },
  },
  mistral: {
    envKey: 'MISTRAL_API_KEY',
    modelKind: 'chat',
    create(value) {
      // Mistral via OpenAI-compatible endpoint.
      return createOpenAI({
        apiKey: value!,
        baseURL: 'https://api.mistral.ai/v1',
        name: 'mistral',
      } as Parameters<typeof createOpenAI>[0]);
    },
  },
  deepseek: {
    envKey: 'DEEPSEEK_API_KEY',
    modelKind: 'chat',
    create(value) {
      // DeepSeek uses an OpenAI-compatible API.
      return createOpenAI({
        apiKey: value!,
        baseURL: 'https://api.deepseek.com/v1',
        name: 'deepseek',
      } as Parameters<typeof createOpenAI>[0]);
    },
  },
  together: {
    envKey: 'TOGETHER_API_KEY',
    modelKind: 'chat',
    create(value) {
      // Together AI uses an OpenAI-compatible API.
      return createOpenAI({
        apiKey: value!,
        baseURL: 'https://api.together.xyz/v1',
        name: 'together',
      } as Parameters<typeof createOpenAI>[0]);
    },
  },
};

/**
 * All known provider names in priority order, derived from the registry. The
 * BUILTIN_PROVIDERS declaration order IS the priority order — Object.keys
 * preserves string-key insertion order (ES2015+), so this matches the former
 * explicit array exactly.
 */
const ALL_PROVIDERS: ProviderName[] = Object.keys(BUILTIN_PROVIDERS) as ProviderName[];

/**
 * Resolve the env value (api key, or base URL for ollama) for a built-in.
 *
 * The primary value is returned RAW (not collapsed) so an empty-string env
 * behaves exactly as the old `process.env[envKey]` did — e.g. ollama's create()
 * decides what undefined-vs-'' means via its own `??`. The `||` fallback applies
 * ONLY where a fallbackEnvKey exists (anthropic: ANTHROPIC_API_KEY ||
 * ANTHROPIC_AUTH_TOKEN), matching the original's `||` there.
 */
function resolveEnvValue(spec: BuiltinProviderSpec): string | undefined {
  const primary = process.env[spec.envKey];
  if (spec.fallbackEnvKey) {
    return primary || process.env[spec.fallbackEnvKey];
  }
  return primary;
}

/**
 * Turn a built-in provider instance into a LanguageModel handle: OpenAI-compatible
 * providers (ollama, mistral, deepseek, together, groq) use `.chat(id)`; native
 * providers (xai, openai, anthropic, google) are callable directly.
 */
function resolveHandle(spec: BuiltinProviderSpec, provider: AnyProvider, modelId: string): ReturnType<AnyProvider> {
  if (spec.modelKind === 'chat') {
    return (provider as { chat: (id: string) => ReturnType<AnyProvider> }).chat(modelId);
  }
  return (provider as (id: string) => ReturnType<AnyProvider>)(modelId);
}

// ---------------------------------------------------------------------------
// Lazy provider instance cache
// ---------------------------------------------------------------------------

const providerCache = new Map<ProviderName, AnyProvider>();

/**
 * Build and cache a provider instance. Returns null when the API key is absent
 * or the required SDK is not installed.
 */
async function instantiateProvider(name: ProviderName, explicitKey?: string): Promise<AnyProvider | null> {
  const spec = BUILTIN_PROVIDERS[name];
  const envValue = explicitKey ?? (spec ? resolveEnvValue(spec) : undefined);

  // The key-presence gate runs BEFORE the unknown-provider throw — intentionally,
  // to stay byte-identical to the original switch, whose
  // `if (name !== 'ollama' && !envValue) return null` short-circuited before the
  // `default` throw. Net result, preserved exactly: an unknown provider with NO
  // key returns null (caller surfaces "could not be built"), an unknown provider
  // WITH a key throws below. (ollama is keyless, so its gate is skipped.)
  if (!spec?.keyOptional && !envValue) {
    log.debug({ provider: name, envKey: spec?.envKey }, 'API key not set — provider unavailable');
    return null;
  }

  if (!spec) {
    // Unknown provider name (reachable only via getModelWithKey with a key).
    throw new LLMError(`Unknown provider: ${String(name)}`, 'llm_unknown_provider');
  }

  let instance: AnyProvider | null;
  try {
    instance = await spec.create(envValue);
  } catch (err) {
    if (err instanceof LLMError) throw err;
    log.error({ provider: name, err: String(err) }, 'Failed to instantiate provider');
    return null;
  }
  if (!instance) return null; // optional SDK (e.g. groq) not installed

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
      `Provider "${name}" is not configured — set ${BUILTIN_PROVIDERS[name]?.envKey ?? name}`,
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
    // Pluggable custom providers (gap #27) — registered from SUDO_CUSTOM_PROVIDERS.
    // Resolved here only after the built-in registry misses; the adapter (openai/
    // anthropic/google) decides native-vs-.chat() handle resolution.
    if (isCustomProvider(providerName)) {
      const handle = resolveCustomModel(providerName, modelId);
      if (handle) {
        log.debug({ modelString, providerName, modelId, custom: true }, 'Resolved custom model handle');
        return handle as ReturnType<AnyProvider>;
      }
      // null only if the registry changed between the check and resolve — fall
      // through to the unknown-provider throw rather than return a null handle.
    }
    throw new LLMError(
      `Unknown provider "${providerName}" in model string "${modelString}"`,
      'llm_unknown_provider',
      { providerName, modelString },
    );
  }

  const provider = getProvider(providerName);

  log.debug({ modelString, providerName, modelId }, 'Resolved model handle');

  return resolveHandle(BUILTIN_PROVIDERS[providerName], provider, modelId);
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
  // does not apply, so resolve them directly from the registry (adapter-aware).
  if (isCustomProvider(providerName)) {
    const handle = resolveCustomModel(providerName, modelId);
    if (handle) return handle as ReturnType<AnyProvider>;
    // null only if the registry changed mid-flight — fall through to the build
    // path, which throws a clean "Unknown provider" LLMError for a missing name.
  }

  const provider = await buildProviderWithKey(providerName, apiKey);
  if (!provider) {
    throw new LLMError(
      `Provider "${providerName}" could not be built with the supplied key`,
      'llm_provider_unconfigured',
      { provider: providerName },
    );
  }

  // Native vs OpenAI-compatible handle resolution mirrors getModel().
  return resolveHandle(BUILTIN_PROVIDERS[providerName], provider, modelId);
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
  return BUILTIN_PROVIDERS[name].envKey;
}

/**
 * Drop the cached instance for a built-in provider and rebuild it now. Used
 * after a runtime state change (e.g. claude-oauth login completed) so the next
 * getProvider() call sees the new auth without waiting for a restart.
 *
 * Returns true when the provider was rebuilt successfully, false when no
 * credentials are available.
 */
export async function reinitProvider(name: ProviderName): Promise<boolean> {
  providerCache.delete(name);
  const instance = await buildProviderAsync(name);
  return instance !== null;
}
