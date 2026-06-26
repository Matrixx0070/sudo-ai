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
import { resolveThinkingBudget } from './thinking-inject.js';
import {
  registerCustomProvidersFromEnv,
  isCustomProvider,
  resolveCustomModel,
  listCustomProviders,
} from './custom-providers.js';

const log = createLogger('brain:providers');

/**
 * Fast-fail timeout (ms) for the *headers* phase of a claude-oauth request.
 * undici's default headersTimeout is long (minutes), so a stalled tier — e.g.
 * a model the OAuth endpoint accepts but never streams headers for — blocks the
 * whole failover chain. We race the fetch (which resolves once headers arrive)
 * against this timer and abort if it elapses, so failover advances in seconds.
 * Cleared the instant headers land, so long streaming response bodies are
 * unaffected. Override with SUDO_OAUTH_HEADERS_TIMEOUT_MS; 0 disables.
 */
const OAUTH_HEADERS_TIMEOUT_MS = (() => {
  const raw = Number(process.env['SUDO_OAUTH_HEADERS_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw >= 0 ? raw : 45_000;
})();

/**
 * Idle window (ms) for the *body* phase of a claude-oauth stream. The headers
 * timeout above only bounds time-to-first-byte and is cleared the instant
 * headers arrive — so a stream that opens then stalls mid-body (the model hangs
 * after the first byte) would otherwise block on undici's long default. We reset
 * a timer on every chunk and abort if the body goes silent for longer than this.
 * Anthropic emits periodic `ping` events throughout long generations, so a
 * healthy slow stream (e.g. Opus with a big thinking budget) keeps the timer fed
 * and stays well under the window. Override with SUDO_OAUTH_BODY_IDLE_TIMEOUT_MS;
 * 0 disables.
 */
const OAUTH_BODY_IDLE_TIMEOUT_MS = (() => {
  const raw = Number(process.env['SUDO_OAUTH_BODY_IDLE_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw >= 0 ? raw : 120_000;
})();

/**
 * Wrap a response body stream so it aborts the underlying request if no chunk
 * arrives within idleMs. Backpressure-preserving: the idle timer is armed only
 * while actively awaiting the next chunk (pull), so a slow downstream consumer
 * never trips it — only a silent upstream does. Forwards chunks unchanged and
 * clears the timer on completion, cancellation, or error.
 */
export function attachBodyIdleTimeout(
  body: ReadableStream<Uint8Array>,
  abortController: AbortController,
  idleMs: number,
  model: string | undefined,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      idleTimer = setTimeout(() => {
        log.warn({ model, idleMs }, 'claude-oauth: body idle timeout — aborting stalled stream');
        abortController.abort(new Error('claude-oauth body idle timeout (sudo fast-fail)'));
      }, idleMs);
      return reader.read().then(
        ({ done, value }) => {
          clear();
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        },
        (err) => { clear(); controller.error(err); },
      );
    },
    cancel(reason) {
      clear();
      return reader.cancel(reason);
    },
  });
}

// ---------------------------------------------------------------------------
// Outgoing-message sanitisation
// ---------------------------------------------------------------------------

/**
 * Strip empty / whitespace-only `{type:'text'}` content blocks from outgoing
 * messages, returning how many were removed.
 *
 * Anthropic rejects such blocks with 400 "messages: text content blocks must
 * be non-empty" — observed live as 12/12 of the claude-oauth 400s. The sliding
 * window / session-fork trim path can leave a message carrying an empty text
 * block. Mutates each message's `content` array in place.
 *
 * SAFETY: this is a no-op for any message without an empty text block, and ANY
 * request that contains one is ALREADY a guaranteed 400 — so the strip cannot
 * regress a currently-succeeding request, only rescue a failing one. Messages
 * whose content becomes empty are NOT dropped here; the caller drops
 * empty-content messages (mirroring the orphan-tool_result cleanup), because an
 * empty content array is also a 400.
 */
export function stripEmptyTextBlocks(messages: Array<Record<string, unknown>>): number {
  let removed = 0;
  for (const m of messages) {
    if (!Array.isArray(m['content'])) continue;
    const content = m['content'] as Array<Record<string, unknown>>;
    const before = content.length;
    m['content'] = content.filter((b) => {
      if (b['type'] !== 'text') return true;
      const t = b['text'];
      return !(typeof t === 'string' && t.trim() === '');
    });
    removed += before - (m['content'] as unknown[]).length;
  }
  return removed;
}

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
        fetch: async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          let token = mgr.getAccessToken();
          if (!token) {
            await mgr.refreshToken();
            token = mgr.getAccessToken();
          }
          const headers = new Headers(init?.headers);
          if (token) headers.set('Authorization', `Bearer ${token}`);
          // Sent to match Claude Code's outbound requests verbatim.
          headers.set('anthropic-beta', 'oauth-2025-04-20');

          // Anthropic gates Opus/Sonnet via OAuth on an EXACT-prefix system
          // prompt attestation ("You are Claude Code, Anthropic's official
          // CLI for Claude.") AND restricts tool names to
          // ^[a-zA-Z0-9_-]{1,128}$ — sudo-ai's tool registry uses dotted
          // names like "meta.run_workflow" which fail that pattern. We
          // rewrite both on the way out and reverse the tool-name mapping
          // in the SSE response so sudo-ai's dispatcher still resolves the
          // original tool when the model calls it.
          let body = init?.body;
          // sanitized -> original tool name. Empty when no rewrites needed.
          const toolNameMap = new Map<string, string>();
          if (typeof body === 'string') {
            try {
              const parsed = JSON.parse(body) as { system?: unknown; tools?: unknown; [k: string]: unknown };

              // ---- 1. System-prompt attestation -----------------------
              const ATTESTATION = "You are Claude Code, Anthropic's official CLI for Claude.";
              const attestEntry = { type: 'text', text: ATTESTATION };
              const cur = parsed.system;
              if (cur === undefined || cur === null) {
                parsed.system = [attestEntry];
              } else if (typeof cur === 'string') {
                parsed.system = cur.length > 0
                  ? [attestEntry, { type: 'text', text: cur }]
                  : [attestEntry];
              } else if (Array.isArray(cur)) {
                const first = cur[0] as { text?: string } | undefined;
                if (typeof first?.text !== 'string' || !first.text.startsWith(ATTESTATION)) {
                  parsed.system = [attestEntry, ...cur];
                }
              }

              // ---- 1b. Strip `temperature` for models that deprecated it.
              // Opus 4.8 (and later opus-4-x) return 400 invalid_request_error
              // "`temperature` is deprecated for this model." All older models
              // (sonnet 4.5/4.6, opus 4.7, haiku 4.5) still accept it. Keep
              // the param for them; surgically drop it only for opus-4-8+.
              if (typeof parsed['model'] === 'string' && /^claude-opus-4-(8|9|[1-9][0-9]+)/.test(parsed['model'])) {
                delete (parsed as Record<string, unknown>)['temperature'];
              }

              // ---- 1c. Enable extended thinking for opus-4-8+.
              // The Anthropic Max Plan unlocks high thinking budgets on opus
              // 4.8+. We enable on every request to those models so each reply
              // gets the deeper reasoning the plan pays for.
              //
              // Budget defaults to 32768 (matches EFFORT_LEVELS.max preset).
              // Override via SUDO_THINKING_BUDGET (1024-65536 valid range).
              // Kill-switch: SUDO_THINKING_DISABLE=1.
              //
              // max_tokens must be > budget_tokens; we bump it when needed so
              // a stale 8192-cap caller doesn't 400 with
              // "max_tokens must be greater than thinking.budget_tokens".
              if (typeof parsed['model'] === 'string' && parsed['thinking'] === undefined) {
                // Clamp budget so budget_tokens + output headroom stays within the
                // model's max_tokens ceiling — else the API/SDK caps the total
                // (truncating the reply) and can 400 on budget >= max_tokens.
                // See resolveThinkingBudget for the invariant + env overrides
                // (SUDO_THINKING_DISABLE / SUDO_THINKING_BUDGET / SUDO_THINKING_MODEL_MAX).
                const tb = resolveThinkingBudget(
                  parsed['model'],
                  typeof parsed['max_tokens'] === 'number' ? (parsed['max_tokens'] as number) : 0,
                  {
                    disable: process.env['SUDO_THINKING_DISABLE'],
                    budget: process.env['SUDO_THINKING_BUDGET'],
                    modelMax: process.env['SUDO_THINKING_MODEL_MAX'],
                  },
                );
                if (tb) {
                  (parsed as Record<string, unknown>)['thinking'] = {
                    type: 'enabled',
                    budget_tokens: tb.budgetTokens,
                  };
                  (parsed as Record<string, unknown>)['max_tokens'] = tb.maxTokens;
                }
              }

              // ---- 2. Tool-name sanitisation --------------------------
              if (Array.isArray(parsed.tools)) {
                for (const tool of parsed.tools as Array<Record<string, unknown>>) {
                  const original = tool['name'];
                  if (typeof original === 'string') {
                    const sanitized = original.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
                    if (sanitized !== original) {
                      toolNameMap.set(sanitized, original);
                      tool['name'] = sanitized;
                    }
                  }
                }
              }

              // ---- 3. Orphan tool_result strip ----------------------------
              // Anthropic rejects with 400 invalid_request_error when a
              // tool_result block references a tool_use_id that has no
              // matching tool_use in the preceding message. The session-fork
              // path (sliding window + proactive trim) sometimes drops the
              // original tool_use message while keeping its tool_result,
              // producing orphans with synthesized "fallback_<ts>" ids.
              // Pre-2026-06-17 the multi-model failover chain hid this by
              // rotating to a less strict validator; now single-claude-oauth
              // surfaces it as "Agent turn failed" with no reply.
              // Strategy: scan once for every tool_use_id present in any
              // assistant message, then drop tool_result blocks whose id is
              // not in that set. Leaves valid pairs untouched.
              if (Array.isArray(parsed['messages'])) {
                const msgs = parsed['messages'] as Array<Record<string, unknown>>;
                const validToolUseIds = new Set<string>();
                for (const m of msgs) {
                  if (Array.isArray(m['content'])) {
                    for (const b of m['content'] as Array<Record<string, unknown>>) {
                      if (b['type'] === 'tool_use' && typeof b['id'] === 'string') {
                        validToolUseIds.add(b['id']);
                      }
                    }
                  }
                }
                let droppedCount = 0;
                for (const m of msgs) {
                  if (!Array.isArray(m['content'])) continue;
                  const filtered = (m['content'] as Array<Record<string, unknown>>).filter((b) => {
                    if (b['type'] !== 'tool_result') return true;
                    const tid = b['tool_use_id'];
                    if (typeof tid !== 'string') return true;
                    if (validToolUseIds.has(tid)) return true;
                    droppedCount++;
                    return false;
                  });
                  m['content'] = filtered;
                }
                if (droppedCount > 0) {
                  log.warn({ droppedCount }, 'claude-oauth: dropped orphan tool_result blocks');
                  // Drop any message whose content array is now empty — empty
                  // content arrays are also a 400.
                  parsed['messages'] = msgs.filter((m) => {
                    if (!Array.isArray(m['content'])) return true;
                    return (m['content'] as unknown[]).length > 0;
                  });
                }
              }

              // ---- 4. Empty text-block strip -----------------------------
              // Anthropic 400s "messages: text content blocks must be non-empty"
              // when a message carries an empty/whitespace-only {type:'text'}
              // block — the exact malformation behind 12/12 of the live
              // claude-oauth 400s. The window/fork trim path can leave one.
              // No-op unless such a block is present (and any request with one
              // is already a guaranteed 400), so this never regresses a
              // succeeding request. SUDO_STRIP_EMPTY_TEXT=0 disables it.
              if (process.env['SUDO_STRIP_EMPTY_TEXT'] !== '0' && Array.isArray(parsed['messages'])) {
                const msgs2 = parsed['messages'] as Array<Record<string, unknown>>;
                const strippedEmpty = stripEmptyTextBlocks(msgs2);
                if (strippedEmpty > 0) {
                  log.warn({ strippedEmpty }, 'claude-oauth: stripped empty text content blocks');
                  // Drop any message left with an empty content array (also a 400).
                  parsed['messages'] = msgs2.filter((m) => {
                    if (!Array.isArray(m['content'])) return true;
                    return (m['content'] as unknown[]).length > 0;
                  });
                }
              }

              body = JSON.stringify(parsed);
            } catch {
              // Body wasn't JSON — leave as-is. The SDK only sends JSON to
              // /v1/messages today; non-JSON paths (file uploads etc) are
              // unaffected.
            }
          }

          // Diagnostic helper: pull the model id out of the outgoing body so
          // the error log says WHICH model failed (the SDK's RetryError
          // collapses cause to "Error" with no message — this is the only
          // place the model name is still visible).
          const outgoingModel: string | undefined = typeof body === 'string'
            ? (() => { try { return (JSON.parse(body) as { model?: string }).model; } catch { return undefined; } })()
            : undefined;

          // Prompt-cache diagnostic (gated). Counts cache_control breakpoints in the
          // FINAL outgoing body and reports the system-field shape, so we can confirm
          // whether cache_control actually reaches the wire on every claude-oauth call.
          if (process.env['SUDO_PROMPT_CACHE_DEBUG'] === '1' && typeof body === 'string') {
            try {
              const cacheControlCount = (body.match(/cache_control/g) ?? []).length;
              let systemShape = 'absent';
              try {
                const pj = JSON.parse(body) as { system?: unknown };
                systemShape = Array.isArray(pj.system)
                  ? `array[${(pj.system as unknown[]).length}]`
                  : pj.system != null ? typeof pj.system : 'absent';
              } catch { /* body already known JSON; shape best-effort */ }
              log.info({ model: outgoingModel, cacheControlCount, systemShape, bodyBytes: body.length },
                'prompt-cache-debug: outgoing claude-oauth body');
            } catch { /* never let diagnostics break the request */ }
          }

          // Fast-fail headers timeout: race the fetch (resolves once response
          // headers arrive) against a timer. If headers stall, abort so the
          // failover chain advances in seconds instead of blocking on undici's
          // long default. Cleared the moment headers land → long streaming
          // bodies are unaffected. Merged with any caller-supplied signal so we
          // don't clobber upstream cancellation.
          const headersController = new AbortController();
          const headersTimer = OAUTH_HEADERS_TIMEOUT_MS > 0
            ? setTimeout(
                () => headersController.abort(new Error('claude-oauth headers timeout (sudo fast-fail)')),
                OAUTH_HEADERS_TIMEOUT_MS,
              )
            : null;
          const callerSignal = init?.signal ?? undefined;
          const signal = callerSignal
            ? AbortSignal.any([callerSignal, headersController.signal])
            : headersController.signal;

          let res: Response;
          try {
            res = await globalThis.fetch(input as Parameters<typeof globalThis.fetch>[0], { ...init, body, headers, signal });
          } catch (err) {
            // Network-layer failure: DNS, TLS, abort, timeout, EAI_AGAIN, etc.
            // Never produced a Response, so the non-2xx branch below never
            // runs and the SDK only sees a thrown Error with whatever the
            // platform put in .message (often empty on undici). Log enough
            // here to actually diagnose.
            const e = err instanceof Error ? err : new Error(String(err));
            const cause = (e as { cause?: unknown }).cause;
            log.warn({
              model: outgoingModel,
              errName: e.name,
              errMessage: e.message || '(empty)',
              errCode: (e as { code?: string }).code,
              cause: cause ? (cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)) : undefined,
              // True when OUR fast-fail headers timeout fired (vs an upstream
              // network error). Distinguishes a stalled tier from a real failure.
              headersTimeout: headersController.signal.aborted,
            }, 'claude-oauth: fetch threw before response');
            throw err;
          } finally {
            // Headers have arrived (or the call failed) — stop the headers timer
            // so it can't abort a long, healthy streaming body.
            if (headersTimer) clearTimeout(headersTimer);
          }
          if (!res.ok) {
            try {
              const clone = res.clone();
              const errBody = (await clone.text()).slice(0, 600);
              log.warn({ status: res.status, model: outgoingModel, errBody }, 'claude-oauth: non-2xx from Anthropic');
            } catch { /* ignore */ }
            return res;
          }

          // If we sanitised any tool names on the way out, the model will
          // emit tool_use blocks naming the sanitised form. Sudo-ai's
          // dispatcher only knows the original names, so we rewrap the SSE
          // body and substitute the original name in any
          //   "name":"<sanitized>"
          // occurrence we see. Robust to streaming because the substitution
          // is per-chunk (Anthropic emits the name inside one event line —
          // there's no splitting of the name across chunks).
          // Body-idle guard: bound a stream that opens then stalls mid-body
          // (the headers timer is already cleared by here). Both the raw and the
          // tool-name-rewrite paths below read through this wrapped stream, so a
          // silent upstream aborts in seconds instead of blocking on undici's
          // long default. headersController is reused as the abort handle — its
          // signal is what fetch is still streaming the body on.
          const guardedBody = res.body && OAUTH_BODY_IDLE_TIMEOUT_MS > 0
            ? attachBodyIdleTimeout(res.body, headersController, OAUTH_BODY_IDLE_TIMEOUT_MS, outgoingModel)
            : res.body;

          if (toolNameMap.size === 0 || !guardedBody) {
            // No tool-name rewrite needed. Return the body, idle-guarded when enabled.
            return guardedBody && guardedBody !== res.body
              ? new Response(guardedBody, { status: res.status, statusText: res.statusText, headers: res.headers })
              : res;
          }
          const reader = guardedBody.getReader();
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          const replacements: Array<[string, string]> = [];
          for (const [s, o] of toolNameMap) {
            // Order matters: we replace JSON-encoded `"name":"<s>"`. JSON
            // escaping of the original is needed in case it contains
            // characters like \ or " (unlikely for tool names but safe).
            replacements.push([`"name":"${s}"`, `"name":${JSON.stringify(o)}`]);
          }
          const rewritten = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              let chunk = decoder.decode(value, { stream: true });
              for (const [from, to] of replacements) {
                if (chunk.includes(from)) chunk = chunk.split(from).join(to);
              }
              controller.enqueue(encoder.encode(chunk));
            },
            cancel(reason) {
              reader.cancel(reason).catch(() => { /* ignore */ });
            },
          });
          return new Response(rewritten, { status: res.status, statusText: res.statusText, headers: res.headers });
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
