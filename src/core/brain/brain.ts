/**
 * Brain — the central intelligence core of SUDO-AI v3.
 *
 * Wraps the Vercel AI SDK with multi-model failover, persona/mood management,
 * system prompt assembly, token cost tracking, and streaming support.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { recordPromptCacheUsageFromProviderMetadata, extractPromptCacheTokens } from '../shared/prompt-cache-telemetry.js';
import { LLMError, extractOverflowTokenCount } from '../shared/errors.js';
import { DEFAULT_MODEL, FALLBACK_MODEL, MAX_AGENT_ITERATIONS } from '../shared/constants.js';
import { ModelFailover } from './failover.js';
import { SustainedFailoverMonitor } from './failover-notice.js';
import { BrainIdleBreaker } from './idle-breaker.js';
import {
  type BrainStrategy,
  type BrainCallOpts,
  DEFAULT_BRAIN_STRATEGY,
  resolveEffectiveStrategy,
} from './brain-strategy.js';
import { runDebate } from './brain-debate.js';
import { runTreeSearch } from './brain-tree-search.js';
import { clampMaxTokensToModel } from './thinking-inject.js';
import { isCustomProvider, registerCustomProvidersOnce } from '../../llm/custom-providers.js';
import { assembleSystemPrompt, assembleSlimHeartbeatPrompt } from './system-prompt.js';
import { isPromptReportEnabled, recordPromptReport } from './prompt-report-store.js';
import { isCacheBreakpointsEnabled, isAnthropicModelId, buildCachedSystemMessages } from './prompt-cache-discipline.js';
import { relocateVolatileToTail } from './prompt-cache-tail.js';
import { getPersonaTemperature } from './personas.js';
import { getMoodTemperatureDelta } from './moods.js';
import { buildTokenUsage } from './costs.js';
import { isGrokRefusal } from './grok-refusal-detect.js';
import { getCostTracker } from '../billing/cost-tracker.js';
import { getGatewayCallLog, noteTraceForSession, type LLMCallRecord } from '../../llm/logging.js';
// F97: every wire hop goes through the IR transport via the brain-bridge seam.
import { callTransportForBrain, streamTransportForBrain, type BrainTransportCall } from '../../llm/brain-bridge.js';
import { queryAllModelsConsensus, type ConsensusOptions } from './model-consensus.js';
import { DispatchRouter } from './dispatch-router.js';
import { estimateTaskComplexity, pickOptimalModel } from './cost-optimizer.js';
import { routeModel } from './model-router.js';
import { AuthProfileRotation } from './auth-profile-rotation.js';
import type { AuthErrorCategory } from './auth-profile-rotation.js';
import { describeRouting } from './routing-trace.js';
import {
  sessionCacheAffinityEnabled,
  explicitAffinityProvider,
  getSessionAffinity,
  setSessionAffinity,
} from './cache-affinity.js';
import type { RoutingTrace, RoutingPath } from './routing-trace.js';
import { selectLenses } from './reasoning-lens.js';
import type {
  BrainMessage,
  BrainRequest,
  BrainResponse,
  ToolCallFromLLM,
  PersonaType,
  MoodType,
  SystemPromptOptions,
  ReasoningLevel,
  ModelProfile,
  ErrorCategory,
  TokenUsage,
} from './types.js';
import type { SudoConfig } from '../config/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { tryParseJson, isJsonRepairEnabled } from '../tools/json-repair.js';
import type { NegativeRouter, RoutingResult } from './negative-router.js';
import type { HistoryMessage } from '../agent/cheap-model-router.js';
import {
  GATEWAY_ERROR_CLASS,
  failoverBackoffMs,
  MAX_FAILOVER_ATTEMPTS,
  sleep,
  resolveModelSwitch,
} from './brain-failover-policy.js';
import { splitConcatenatedJsonObjects, findBalancedJsonObjects } from './brain-json-scan.js';
import { readFoldSystemEnabled, extractSystemMessageContent, buildEffectiveSystemPrompt } from './brain-messages.js';
import type { BrainCompletion } from './brain-completion.js';

const log = createLogger('brain');

// ---------------------------------------------------------------------------
// F103 mechanical slimming: the free-standing helpers that used to live here
// moved verbatim to sibling modules. Re-export every previously-exported
// symbol so ALL existing importers (agent loop-helpers, verify-gate-critic,
// subagent-resume, tests) compile unchanged.
// ---------------------------------------------------------------------------
export {
  FAILOVER_BACKOFF_CAP_MS,
  failoverBackoffMs,
  MAX_FAILOVER_ATTEMPTS,
  resolveModelSwitch,
} from './brain-failover-policy.js';
export { splitConcatenatedJsonObjects } from './brain-json-scan.js';
export {
  readFoldSystemEnabled,
  extractSystemMessageContent,
  buildEffectiveSystemPrompt,
  buildFoldedSystemMessages,
  toSDKMessages,
} from './brain-messages.js';

// ---------------------------------------------------------------------------
// Brain class
// ---------------------------------------------------------------------------

/** Minimal interface required from a RAG engine — avoids importing RAGEngine directly. */
interface RAGEngineInterface {
  retrieveContext(query: string, maxChunks?: number): Promise<string>;
}

/** Core LLM interface with failover, persona, and mood management. */
export class Brain {
  private readonly failover: ModelFailover;
  /**
   * Cross-call breaker against runaway paid fan-out to a wedged provider.
   * Instance-scoped so consecutive idle-timeouts across separate brain calls
   * (the agent loop calls the brain once per iteration) are counted together.
   */
  private readonly idleBreaker = new BrainIdleBreaker();
  private currentPersona: PersonaType = 'assistant';
  private currentMood: MoodType = 'focused';
  /**
   * Execution strategy for brain.call(). `single` keeps the existing
   * sequential-failover behaviour. `debate` (wired in #239) runs Blue
   * (kimi) + Red (glm) + Revise. `tree-search` (wired in #240) runs N
   * debates with shared Reflexion memory + algorithmic verifier.
   * Stage 1 plumbing only — `single` is the only honoured strategy here.
   */
  private brainStrategy: BrainStrategy = DEFAULT_BRAIN_STRATEGY;
  private readonly config: SudoConfig | null;
  /** RAG engine — injected post-construction via setRAGEngine(). Null = no retrieval. */
  private ragEngine: RAGEngineInterface | null = null;
  /** Negative router — injected post-construction via setNegativeRouter(). Undefined = no routing. */
  private negativeRouter: NegativeRouter | undefined;
  /** Highest-priority model id — the primary for smart-routing. Mutable via setModel(). */
  private primaryModel: string;
  /** Full configured failover chain, captured at construction (setModel allowlist). */
  private readonly configuredModels: string[];
  /** Cheap-path dispatch router (novelty scoring + LRU cache + anti-self-promotion guard). */
  private readonly dispatchRouter = new DispatchRouter();
  /** Multi-key rotation manager — rotates API keys per provider on rate-limit/auth errors. */
  private readonly authRotation = AuthProfileRotation.getInstance();
  /** Providers whose env keys have been loaded into the rotation manager (load-once). */
  private readonly rotationLoaded = new Set<string>();

  /**
   * @param config - Full SudoConfig (or null for env-only mode).
   */
  private providersReady: Promise<void>;

  constructor(config: unknown) {
    this.config = config as SudoConfig | null;
    const modelIds = this.buildModelList();
    this.failover = new ModelFailover(modelIds);
    // GW-2: fire ONE operator notice on sustained failover (>30s or >3 hops
    // off-primary), re-armed every 30 min. Observation only — never blocks.
    this.failover.setSustainedFailoverMonitor(
      new SustainedFailoverMonitor({
        notify: (n) =>
          log.warn(
            { failover: n },
            `sustained LLM failover — serving ${n.currentProfile} for ${Math.round(n.elapsedMs / 1000)}s / ${n.consecutiveHops} hops off primary`,
          ),
      }),
    );
    this.configuredModels = modelIds.length > 0 ? modelIds : [DEFAULT_MODEL];
    this.primaryModel = modelIds[0] ?? DEFAULT_MODEL;
    // F97: custom-provider env registration is the only boot step left
    // (the transport resolves routes/auth per call — no instance warmup).
    registerCustomProvidersOnce();
    this.providersReady = Promise.resolve();
    log.info({ modelCount: modelIds.length, models: modelIds }, 'Brain initialised');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildModelList(): string[] {
    const models: string[] = [];
    // Append a model ref to the failover chain, skipping blanks, duplicates, and
    // malformed refs (a missing "/" would otherwise throw in the failover ctor).
    const add = (ref: string | undefined): void => {
      if (!ref) return;
      if (!ref.includes('/')) {
        log.warn({ ref }, 'buildModelList: skipping malformed model ref (expected "provider/model-id")');
        return;
      }
      if (!models.includes(ref)) models.push(ref);
    };

    // 1. Ordered primary models.
    for (const entry of this.config?.models?.primary ?? []) add(entry.id);
    // 2. Explicit user-configured fallback chain (primary + fallbacks[]).
    for (const ref of this.config?.models?.fallbacks ?? []) add(ref);
    // 3. Legacy single fallback (back-compat).
    add(this.config?.models?.fallback?.id);
    // 4. Hard default when nothing usable is configured.
    if (models.length === 0) {
      add(DEFAULT_MODEL);
      add(FALLBACK_MODEL);
    }

    return models;
  }

  // ---------------------------------------------------------------------------
  // Runtime model switching (/model directive)
  // ---------------------------------------------------------------------------

  /** The current primary model id ("provider/model-id"). */
  getModel(): string {
    return this.primaryModel;
  }

  /**
   * Switch the primary model at runtime. The target must be in the configured
   * failover chain — matched by full "provider/model-id" or by the bare model
   * id (case-insensitive). The matched model is promoted to the top of the
   * failover order so both smart routing and the sequential failover path
   * start from the new primary; the other models keep their relative order.
   *
   * @throws {LLMError} when the target is not a configured model.
   */
  setModel(target: string): void {
    const match = resolveModelSwitch(this.configuredModels, target);
    if (!match) {
      throw new LLMError(
        `Model "${target}" is not configured. Available: ${this.configuredModels.join(', ')}`,
        'llm_invalid_model',
        { target, configured: this.configuredModels },
      );
    }
    this.primaryModel = match;
    this.failover.setPrimary(match);
    log.info({ model: match }, 'Primary model switched at runtime');
  }

  // ---------------------------------------------------------------------------
  // Reasoning-level temperature/token presets (Upgrade 3)
  // ---------------------------------------------------------------------------

  private static readonly REASONING_TEMP: Record<ReasoningLevel, number> = {
    low: 0.3,
    medium: 0.5,
    high: 0.7,
    xhigh: 0.8,
  };

  private static readonly REASONING_TOKENS: Record<ReasoningLevel, number> = {
    low: 1024,
    medium: 4096,
    high: 8192,
    xhigh: 16384,
  };

  private resolveTemperature(request: BrainRequest): number {
    // Explicit temperature always wins.
    if (request.temperature !== undefined) {
      if (Array.isArray(request.tools) && request.tools.length > 0) {
        return Math.min(request.temperature, 0.3);
      }
      return request.temperature;
    }

    // Reasoning level preset overrides persona/mood defaults.
    if (request.reasoningLevel) {
      const preset = Brain.REASONING_TEMP[request.reasoningLevel];
      if (Array.isArray(request.tools) && request.tools.length > 0) {
        return Math.min(preset, 0.3);
      }
      return preset;
    }

    const base = getPersonaTemperature(this.currentPersona);
    const delta = getMoodTemperatureDelta(this.currentMood);
    const resolved = Math.max(0, Math.min(2, base + delta));
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      return Math.min(resolved, 0.3);
    }
    return resolved;
  }

  private resolveMaxTokens(request: BrainRequest): number {
    // Explicit maxTokens always wins.
    if (request.maxTokens !== undefined) return request.maxTokens;

    // Reasoning level preset is next priority.
    if (request.reasoningLevel) {
      return Brain.REASONING_TOKENS[request.reasoningLevel];
    }

    return this.config?.models?.primary?.[0]?.maxOutputTokens ?? 8192;
  }

  private extractToolCalls(rawCalls: unknown[]): ToolCallFromLLM[] {
    const calls: ToolCallFromLLM[] = [];
    for (const tc of rawCalls) {
      const raw = tc as Record<string, unknown>;
      const id = (raw['toolCallId'] as string | undefined) ?? '';
      const name = (raw['toolName'] as string | undefined) ?? '';

      // Skip tool calls that are missing critical fields -- these happen when
      // the LLM hallucinates a partial tool call or the provider returns a
      // malformed entry.
      if (!id || !name) {
        log.warn({ raw: tc }, 'Skipping tool call with missing toolCallId or toolName');
        continue;
      }

      // Vercel AI SDK v6 uses 'input' for tool call arguments.
      // Fall back to 'args' for compatibility with older SDK versions.
      // Either field may arrive as a raw JSON string from OpenAI-compatible
      // providers (e.g. grok-3 via xai) — parse it if so.
      let rawArgField: unknown = raw['input'] ?? raw['args'] ?? {};

      // If the field is a string, try to parse it.  Some OpenAI-compatible
      // providers (including grok-3 via xai) return the raw JSON string
      // from function.arguments without pre-parsing it.
      // The LLM may also concatenate multiple JSON objects into one string when
      // it intends to make several tool calls.  In that case we extract the
      // first complete object and warn about the remainder.
      if (typeof rawArgField === 'string') {
        const objects = splitConcatenatedJsonObjects(rawArgField);
        const originalArgsLen = rawArgField.length;
        const parsedObjectCount = objects.length;

        if (parsedObjectCount === 0) {
          log.warn({ toolName: name, rawArgField }, 'Tool call arguments string could not be parsed — defaulting to {}');
          rawArgField = {};
        } else {
          if (parsedObjectCount > 1) {
            log.warn(
              { originalArgsLen, parsedObjectCount, chosenIndex: 0, toolName: name },
              'Multi-arg tool call detected — split: using first object, dropping remainder',
            );
            log.info(
              { originalArgsLen, parsedObjectCount, chosenIndex: 0 },
              'Multi-arg tool call detected — split',
            );
          }
          rawArgField = objects[0];
        }
      }

      let args = rawArgField as Record<string, unknown>;

      // Guard against LLM returning non-object arguments (e.g. null, array).
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        log.warn({ toolName: name, args }, 'Tool call has non-object arguments — defaulting to {}');
        args = {};
      }

      calls.push({ id, name, arguments: args });
    }
    return calls;
  }

  /**
   * Safety-net: parse tool calls from LLM text output when structured toolCalls
   * is empty. Fires ONLY when the provider returns free-text XML instead of
   * structured output.
   *
   * SECURITY CONTRACT:
   *   - Parsed tool name MUST be in the live registry (ToolRegistry.getGlobal()) or the
   *     call is DROPPED with a WARN log. Prevents injection via attacker-controlled text.
   *   - Logs WARN on every synthetic call produced (visibility into LLM regression).
   *   - Never fires when finishReason === 'tool_calls'.
   */
  private _parseTextToolCalls(text: string, reverseMap?: Map<string, string>): ToolCallFromLLM[] {
    let knownToolNames: Set<string>;
    try {
      // ToolRegistry is imported statically at top of brain.ts.
      const global = ToolRegistry.getGlobal();
      knownToolNames = global
        ? new Set(global.listEnabled().map((t) => t.name))
        : new Set<string>();
    } catch {
      knownToolNames = new Set<string>();
    }

    if (knownToolNames.size === 0) {
      log.warn('Text tool-call fallback: global registry empty or unavailable — dropping all parsed calls');
      return [];
    }

    const pattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    const results: ToolCallFromLLM[] = [];
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1]?.trim() ?? '';
      // Weaker models emit almost-valid JSON here (trailing commas, single
      // quotes, fences, truncated tail). Repair before dropping the call — a
      // silently-skipped block strands the model into a retry loop.
      const parsedRes = tryParseJson<Record<string, unknown>>(raw, isJsonRepairEnabled());
      if (!parsedRes) {
        log.warn({ raw }, 'Text tool-call fallback: JSON parse failed (repair exhausted) — skipping block');
        continue;
      }
      if (parsedRes.repaired) {
        log.warn({ raw }, 'Text tool-call fallback: malformed JSON repaired before parse');
      }
      const parsed = parsedRes.value;

      const rawName = typeof parsed['name'] === 'string' ? parsed['name'] : '';
      if (!rawName) {
        log.warn({ parsed }, 'Text tool-call fallback: missing "name" field — skipping');
        continue;
      }
      // Reverse a provider-sanitized name (mcp_connect -> mcp.connect) BEFORE the
      // registry guard, which only knows the original dotted names.
      const name = reverseMap?.get(rawName) ?? rawName;

      // SECURITY: tool name must be in live registry — rejects injection from external content.
      if (!knownToolNames.has(name)) {
        log.warn({ name }, 'Text tool-call fallback: tool name not in registry — DROPPED (injection guard)');
        continue;
      }

      const args = (parsed['args'] ?? parsed['arguments'] ?? parsed['input'] ?? {}) as Record<string, unknown>;
      const id = `text-tc-${randomUUID()}`;
      log.warn({ name, id }, 'Text tool-call fallback FIRED — LLM emitted XML text instead of structured tool call');
      results.push({ id, name, arguments: args });
    }

    return results;
  }

  /**
   * Parse JSON-format tool calls emitted by OpenAI-compatible providers as plain text.
   * Handles: {"tool_calls":[{"name":"...","arguments":{...}},...]}
   *
   * SECURITY CONTRACT — same as _parseTextToolCalls:
   *   - Tool name MUST be in the live registry or call is DROPPED.
   *   - Logs WARN on every synthetic call produced.
   *   - Only runs when finishReason !== 'tool-calls' (no structured calls present).
   */
  private _parseJsonToolCalls(text: string, reverseMap?: Map<string, string>): ToolCallFromLLM[] {
    let knownToolNames: Set<string>;
    try {
      const global = ToolRegistry.getGlobal();
      knownToolNames = global
        ? new Set(global.listEnabled().map((t) => t.name))
        : new Set<string>();
    } catch {
      knownToolNames = new Set<string>();
    }

    if (knownToolNames.size === 0) {
      log.warn('JSON tool-call fallback: global registry empty or unavailable — dropping all parsed calls');
      return [];
    }

    // Find JSON objects containing "tool_calls" anywhere in the text. A greedy
    // lazy regex (/\{[\s\S]*?"tool_calls"[\s\S]*?\}/) stops at the FIRST '}'
    // after "tool_calls" — truncating `{"tool_calls":[{"name":"x","arguments":{...}}]}`
    // to unbalanced JSON and silently dropping/mangling args. Use a balanced-brace
    // scanner (O(n), string/escape aware, no backtracking) so nested args survive.
    const results: ToolCallFromLLM[] = [];

    for (const objStr of findBalancedJsonObjects(text)) {
      if (!objStr.includes('"tool_calls"')) continue;

      let parsed: Record<string, unknown>;
      const whole = tryParseJson<Record<string, unknown>>(objStr, isJsonRepairEnabled());
      if (whole) {
        if (whole.repaired) {
          log.warn({ raw: objStr.slice(0, 200) }, 'JSON tool-call fallback: malformed JSON repaired before parse');
        }
        parsed = whole.value;
      } else {
        // The outer JSON may be incomplete — try to extract just the tool_calls array.
        const arrMatch = /"tool_calls"\s*:\s*(\[[\s\S]*?\])/.exec(objStr);
        if (!arrMatch) continue;
        const arr = tryParseJson<unknown[]>(arrMatch[1], isJsonRepairEnabled());
        if (!arr) {
          log.warn({ raw: objStr.slice(0, 200) }, 'JSON tool-call fallback: parse failed (repair exhausted) — skipping');
          continue;
        }
        parsed = { tool_calls: arr.value };
      }

      const calls = Array.isArray(parsed['tool_calls']) ? (parsed['tool_calls'] as unknown[]) : [];
      for (const call of calls) {
        if (!call || typeof call !== 'object') continue;
        const c = call as Record<string, unknown>;
        const rawName = typeof c['name'] === 'string' ? c['name'] : '';
        if (!rawName) {
          log.warn({ call }, 'JSON tool-call fallback: missing "name" field — skipping');
          continue;
        }
        // Reverse a provider-sanitized name before the registry guard.
        const name = reverseMap?.get(rawName) ?? rawName;

        // SECURITY: name must be in live registry.
        if (!knownToolNames.has(name)) {
          log.warn({ name }, 'JSON tool-call fallback: tool name not in registry — DROPPED (injection guard)');
          continue;
        }

        const args = (c['arguments'] ?? c['args'] ?? c['input'] ?? {}) as Record<string, unknown>;
        const id = `json-tc-${randomUUID()}`;
        log.warn({ name, id }, 'JSON tool-call fallback FIRED — LLM emitted JSON text instead of structured tool call');
        results.push({ id, name, arguments: args });
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Set the active persona. Affects system prompt and default temperature.
   *
   * @param persona - One of the 6 persona types.
   */
  setPersona(persona: PersonaType): void {
    this.currentPersona = persona;
    log.info({ persona }, 'Persona updated');
  }

  /**
   * Set the active mood. Affects system prompt tone and temperature delta.
   *
   * @param mood - One of the 5 mood types.
   */
  setMood(mood: MoodType): void {
    this.currentMood = mood;
    log.info({ mood }, 'Mood updated');
  }

  /**
   * Attach a RAG engine to this Brain instance.
   * Called once after construction in cli.ts / Electron bootstrap.
   * The engine is queried on every call() to inject relevant memory context.
   *
   * @param engine - Any object with a retrieveContext(query) method.
   */
  setRAGEngine(engine: RAGEngineInterface): void {
    this.ragEngine = engine;
    log.info('RAG engine attached to brain');
  }

  /**
   * Attach a NegativeRouter to this Brain instance.
   * Called once after construction. The router is consulted on every call()
   * to optionally override model selection based on DFA/keyword/LLM routing.
   * If not configured, the Brain falls back to the existing model-router behavior.
   *
   * @param router - A NegativeRouter instance.
   */
  setNegativeRouter(router: NegativeRouter): void {
    this.negativeRouter = router;
    log.info('NegativeRouter attached to brain');
  }

  /**
   * Assemble and return the current system prompt without making an LLM call.
   *
   * @param options - Optional overrides for prompt assembly.
   */
  /** BO6/S3: pre-rendered <available_skills> catalog block for the stable prefix. */
  private _skillCatalog = '';

  /**
   * Wire the boot-built (or live-reloaded) skill catalog (skills/skill-catalog.ts)
   * into every assembled system prompt. Byte-stable within a session; a live reload
   * after a SKILL.md edit re-hashes and updates the block (version-marker invalidation).
   */
  setSkillCatalog(block: string): void {
    this._skillCatalog = typeof block === 'string' ? block : '';
  }

  async getSystemPrompt(options: Partial<SystemPromptOptions> = {}): Promise<string> {
    return assembleSystemPrompt({
      persona: this.currentPersona,
      mood: this.currentMood,
      ...(this._skillCatalog ? { skillCatalog: this._skillCatalog } : {}),
      ...options,
    });
  }

  /**
   * Main LLM call with automatic multi-model failover.
   *
   * @param request - The brain request parameters.
   * @throws LLMError when all failover attempts are exhausted.
   */
  /**
   * Convenience shim for legacy code that calls brain.chat(messages).
   * Wraps call() and returns just the text content string.
   */
  async chat(messages: BrainMessage[], model?: string): Promise<string> {
    const response = await this.call({ messages, model });
    return response.content ?? '';
  }

  /**
   * Set the active brain execution strategy. Affects subsequent call()
   * invocations that don't override via opts. Stage 1 plumbing — only
   * `single` is honoured today; `debate` and `tree-search` arrive in
   * #239 and #240.
   */
  setStrategy(strategy: BrainStrategy): void {
    this.brainStrategy = strategy;
    log.info({ strategy }, 'Brain strategy set');
  }

  /** Returns the currently-configured brain execution strategy. */
  getStrategy(): BrainStrategy {
    return this.brainStrategy;
  }

  async call(request: BrainRequest, opts?: BrainCallOpts): Promise<BrainResponse> {
    const resp = await this._callRouted(request, opts);
    // Capture the first-turn winner as the session pin (first writer wins:
    // setSessionAffinity never overwrites an existing pin, so a later hard-fail
    // failover does NOT repin — spec §3). Only conversational calls (sessionId)
    // pin; RAG/judge/consciousness (no sessionId) never do. Gated OFF by default,
    // so this is a no-op unless SUDO_SESSION_CACHE_AFFINITY=1.
    if (sessionCacheAffinityEnabled() && request.sessionId && resp.model) {
      setSessionAffinity(request.sessionId, resp.model);
    }
    return resp;
  }

  private async _callRouted(request: BrainRequest, opts?: BrainCallOpts): Promise<BrainResponse> {
    await this.providersReady;

    if (!request.messages || request.messages.length === 0) {
      throw new LLMError('BrainRequest.messages must be non-empty', 'llm_invalid_request');
    }

    // Cross-call idle breaker (same guard as stream()): don't fan out another
    // paid call while a provider is wedged. Half-opens after the cooldown.
    if (this.idleBreaker.shouldBlock()) {
      log.warn(this.idleBreaker.snapshot(), 'call: brain idle circuit open — short-circuiting');
      throw new LLMError(this.idleBreaker.reason(), 'llm_idle_circuit_open', this.idleBreaker.snapshot());
    }

    // Strategy router: resolve the effective strategy from configured +
    // opts (fast tier always short-circuits to single), then route to the
    // matching orchestrator. `single` flows down into the existing
    // smart-route / consensus / sequential-failover path below. `debate`
    // (Blue/Red/Revise, #239) and `tree-search` (Verifier-guided + Reflexion,
    // #240) re-enter brain.call() per-round with `strategy: 'single'` so the
    // existing failover, RAG, lenses, telemetry, and negative-routing all
    // still run inside each round. Recursion is prevented by the inner
    // forcing of `strategy: 'single'`.
    const effectiveStrategy = resolveEffectiveStrategy(this.brainStrategy, opts);
    if (effectiveStrategy === 'debate') {
      // Forward the verifier so debate scores its winner (log-only by
      // default; SUDO_BRAIN_DEBATE_VERIFIER=fallback enables Blue fallback).
      const debateOpts: Parameters<typeof runDebate>[2] = {};
      if (opts?.verifier !== undefined) debateOpts.verifier = opts.verifier;
      return runDebate(this, request, debateOpts);
    }
    if (effectiveStrategy === 'tree-search') {
      // Forward only the tree-search-relevant opts. The verifier opt is
      // ignored on `single` by design — it has nothing to reroll against.
      const treeOpts: Parameters<typeof runTreeSearch>[2] = {};
      if (opts?.verifier !== undefined) treeOpts.verifier = opts.verifier;
      // Guard breadth: tree-search clamps with Math.max(1, n) which
      // leaves NaN as NaN — `for (let i = 0; i < NaN; i++)` never
      // executes and surfaces as "every candidate failed". Drop the
      // opt on non-finite input so tree-search picks its own default.
      if (opts?.breadth !== undefined && Number.isFinite(opts.breadth)) {
        treeOpts.breadth = opts.breadth;
      }
      return runTreeSearch(this, request, treeOpts);
    }

    // Extract tool names/descriptions to include in the system prompt so the LLM
    // knows what tools are available and when to use them.
    const toolSummaries = (request.tools ?? []).map((t) => ({
      name: t.function?.name ?? '',
      description: t.function?.description ?? '',
    })).filter((s) => s.name);

    // Slim heartbeat mode (SUDO_SLIM_HEARTBEAT, set by the agent loop for the
    // system.heartbeat tick only): minimal system prompt, no RAG, no lens.
    const slimHeartbeat = request.promptMode === 'slim-heartbeat';

    // RAG: retrieve relevant memory context from the last user message.
    // Failures are fully swallowed — never let RAG break the main call path.
    let ragMemoryContext: string | undefined;
    if (this.ragEngine && !slimHeartbeat) {
      try {
        const lastUserMsg = [...request.messages]
          .reverse()
          .find((m) => m.role === 'user');
        if (lastUserMsg?.content && lastUserMsg.content.length >= 5) {
          const ctx = await this.ragEngine.retrieveContext(lastUserMsg.content);
          if (ctx) {
            ragMemoryContext = ctx;
            log.debug({ contextLen: ctx.length }, 'RAG context injected into system prompt');
          }
        }
      } catch (ragErr) {
        log.debug({ err: String(ragErr) }, 'RAG retrieval failed — continuing without memory context');
      }
    }

    // Reasoning lens: inject an analytical framework when the task matches
    // (root-cause / hypothesis / decision / adversarial / strategic). Scoped by
    // keyword, capped, and kill-switchable (SUDO_REASONING_LENS_DISABLE=1) — inert
    // for plain turns. See reasoning-lens.ts.
    const lensUserText = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const lens = slimHeartbeat ? null : selectLenses(lensUserText);
    if (lens) {
      log.debug({ lensIds: lens.ids }, 'Reasoning lenses injected into system prompt');
    }

    // Slim heartbeat path: minimal prompt (identity + health-check protocol).
    // Fail-open — any throw or empty result falls through to the full prompt.
    let slimPromptApplied = false;
    let systemPrompt = '';
    if (slimHeartbeat) {
      try {
        const slim = assembleSlimHeartbeatPrompt();
        if (slim.trim().length > 0) {
          systemPrompt = slim;
          slimPromptApplied = true;
          log.info({ chars: slim.length }, 'Slim heartbeat system prompt in use');
        }
      } catch (slimErr) {
        log.warn({ err: String(slimErr) }, 'Slim heartbeat prompt failed — falling back to full system prompt');
      }
    }
    // BO2b/S1: prompt-cache tail relocation. When on (default under
    // SUDO_PROMPT_CACHE; SUDO_PROMPT_CACHE_TAIL_MEMORY=0 reverts), the volatile
    // Recent Memory + Date blocks are captured OUT of the system prompt and
    // re-emitted as a tail message below (after the append-only history) so the
    // whole system prompt stays byte-stable and the history becomes cacheable.
    const tailCacheMemory =
      process.env['SUDO_PROMPT_CACHE'] !== '0' &&
      process.env['SUDO_PROMPT_CACHE_TAIL_MEMORY'] !== '0';
    let volatileTailBlock = '';
    if (!slimPromptApplied) {
      systemPrompt = await this.getSystemPrompt({
        heartbeat: false,
        ...(request.promptProfile ? { profile: request.promptProfile } : {}),
        tools: toolSummaries.length > 0 ? toolSummaries : undefined,
        ...(ragMemoryContext ? { memoryContext: ragMemoryContext } : {}),
        ...(lens ? { reasoningLens: lens.text } : {}),
        ...(tailCacheMemory
          ? { captureVolatileTail: (b: string) => { volatileTailBlock = b; } }
          : {}),
      });
    }

    // v5: Tool-use instruction — softened for Ollama models which tend to
    // return tool_calls for conversational queries when the instruction is
    // too aggressive. We still encourage tool use for actions but allow
    // direct text responses for conversation. (The slim heartbeat prompt
    // carries its own terse tool rules — skip the generic block there.)
    if (toolSummaries.length > 0 && !slimPromptApplied) {
      systemPrompt += `\n\n## TOOL-USE INSTRUCTION
You have ${toolSummaries.length} tools available. When the user asks you to DO something concrete (check, search, navigate, read, write, screenshot, execute, etc.), call the appropriate tool. For casual conversation, greetings, opinions, or general questions, respond with normal text — do NOT call tools.`;
    }

    // BO2b/S1: the volatile system-prompt tail (captured in volatileTailBlock)
    // and every per-turn (non-durable) inline system message are relocated to a
    // tail user message at the WIRE boundary (see _applyTailRelocation, called in
    // _callSingleModel). Doing it there — on a COPY — keeps request.messages
    // pristine so failure-summary bookkeeping (messageCount) stays truthful.
    if (tailCacheMemory && volatileTailBlock) {
      (request as { _volatileTailBlock?: string })._volatileTailBlock = volatileTailBlock;
    }

    // BO1/S9: per-turn prompt report (observability-only, flag-gated OFF by
    // default, fully fail-open). Records section chars+sha256 and the
    // stable-prefix/dynamic-suffix split to data/prompt-reports.db, and flags
    // stable-prefix churn. Never alters the prompt or blocks the call.
    if (isPromptReportEnabled()) {
      recordPromptReport(systemPrompt, {
        sessionKey: request.sessionId,
        source: request.source,
        route: request.model,
        heartbeat: slimPromptApplied,
      });
    }
    const temperature = this.resolveTemperature(request);
    const maxTokens = this.resolveMaxTokens(request);
    let lastError: unknown;

    // Negative Router: consult the 3-tier DFA engine before model selection.
    // If the router blocks the request, return an error immediately.
    // If the router suggests a model or redirect, override request.model.
    // If not configured, this is a no-op and existing behavior is preserved.
    if (this.negativeRouter) {
      try {
        const lastUserMsg = [...request.messages].reverse().find(m => m.role === 'user');
        const userText = lastUserMsg?.content ?? '';
        const routingResult: RoutingResult = this.negativeRouter.route('', userText);

        if (routingResult.blocked) {
          log.warn({ category: routingResult.category, tier: routingResult.tier }, 'NegativeRouter: request blocked');
          return {
            content: `[NegativeRouter] Request blocked (category=${routingResult.category})`,
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
            model: request.model ?? 'blocked',
            finishReason: 'stop',
            routing: this._trace({
              path: 'blocked',
              reason: `negative-router:${routingResult.category}`,
              activeModel: request.model ?? 'blocked',
              selectedModel: request.model ?? 'blocked',
              costUSD: 0,
            }),
          };
        }

        if (routingResult.redirect) {
          log.info({ redirect: routingResult.redirect, category: routingResult.category }, 'NegativeRouter: request redirected');
          request = { ...request, model: routingResult.redirect };
        } else if (routingResult.model && routingResult.confidence >= 0.5) {
          log.debug({ model: routingResult.model, category: routingResult.category, confidence: routingResult.confidence }, 'NegativeRouter: model hint applied');
          request = { ...request, model: routingResult.model };
        }
      } catch (routerErr) {
        log.warn({ err: String(routerErr) }, 'NegativeRouter threw — continuing without routing');
      }
    }

    // -------------------------------------------------------------------------
    // Smart-route fast-path: send genuinely simple turns straight to a single
    // cheap model, skipping the cloud-consensus race. Wires the cost-optimizer
    // (task-difficulty estimate + cheap-tier model pick) and the dispatch-router
    // (cheap-vs-primary decision with novelty + anti-self-promotion guards) into
    // the live call path. Inert when no model cheaper than the primary exists, so
    // default behavior is unchanged. On ANY error it falls through to the normal
    // consensus + failover path below — never a reliability regression.
    // Kill-switch: SUDO_SMART_ROUTE_DISABLE=1
    // -------------------------------------------------------------------------
    const fastRoute = this._smartRoute(request);
    if (fastRoute) {
      log.info(
        { model: fastRoute.model, complexity: fastRoute.complexity, reason: fastRoute.reason },
        'Smart-route fast-path selected — bypassing consensus for a simple turn',
      );
      try {
        const profile = this._syntheticProfile(fastRoute.model);
        const resp = await this._callSingleModel(profile, request, systemPrompt, temperature, maxTokens);
        return {
          ...resp,
          routing: this._trace({ path: fastRoute.kind, reason: fastRoute.reason, activeModel: resp.model, costUSD: resp.usage.estimatedCost }),
        };
      } catch (err) {
        log.warn(
          { model: fastRoute.model, err: String(err) },
          'Smart-route fast-path failed — falling through to consensus + failover',
        );
        // Intentionally no recordError(): the cheap target may be a synthetic
        // profile unknown to the failover registry; the standard path below
        // owns recovery and cooldown for the registered models.
      }
    }

    // -------------------------------------------------------------------------
    // Phase 1: Consensus call across cloud models.
    // Query all cloud models in parallel, then pick the best answer by:
    //   - If models agree (Jaccard similarity > 0.7) → use fastest
    //   - If they disagree → use most detailed (content + tool calls)
    //
    // Kill-switch: SUDO_BRAIN_CONSENSUS_DISABLE=1 skips consensus and goes
    // straight to sequential failover (Phase 2). Use when token cost matters
    // more than answer quality (e.g. background cognitive ticks, KAIROS).
    // -------------------------------------------------------------------------
    const cloudProfiles = this.failover.getCloudProfiles();
    const consensusDisabled = process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] === '1';
    if (cloudProfiles.length > 0 && !consensusDisabled) {
      log.info({ cloudCount: cloudProfiles.length, models: cloudProfiles.map(p => p.id) }, 'Querying cloud models for consensus');

      try {
        const { result: consensusResult, agreement, method } = await queryAllModelsConsensus(
          cloudProfiles.map(p => p.id),
          async (modelId) => {
            const profile = cloudProfiles.find(p => p.id === modelId)!;
            try {
              const t0 = Date.now();
              const response = await this._callSingleModel(profile, request, systemPrompt, temperature, maxTokens);
              return {
                model: response.model,
                content: response.content ?? '',
                toolCalls: response.toolCalls ?? [],
                latencyMs: Date.now() - t0,
                usage: response.usage,
              };
            } catch (err) {
              // Attribute the failure to THIS model with its real category —
              // consensus swallows per-model rejections, so without this the
              // failover tracker never learns about a flaky participant.
              const { status, body, retryAfterMs } = Brain.extractErrorDetails(err);
              const category = this.failover.categorizeError(status, body);
              log.warn({ modelId, status, category, retryAfterMs }, 'Consensus participant failed');
              this.failover.recordError(modelId, category, { retryAfterMs });
              throw err;
            }
          },
          this._consensusOptions(request),
        );

        // Record success for the winning model
        this.failover.recordSuccess(consensusResult.model);
        log.info({ modelId: consensusResult.model, agreement, method }, 'Consensus winner selected');

        return {
          content: consensusResult.content,
          toolCalls: consensusResult.toolCalls as ToolCallFromLLM[],
          usage: consensusResult.usage,
          model: consensusResult.model,
          finishReason: consensusResult.toolCalls.length > 0 ? 'tool-calls' : 'stop',
          // Consensus builds its own response shape (doesn't spread _callSingleModel)
          // so surface the resolved sampling here too for replay capture.
          sampling: { temperature, maxTokens, ...(request.seed !== undefined ? { seed: request.seed } : {}) },
          routing: this._trace({
            path: 'consensus',
            reason: `consensus:${method}`,
            activeModel: consensusResult.model,
            costUSD: consensusResult.usage.estimatedCost,
            consensus: { agreement, method },
          }),
        };
      } catch (consensusErr) {
        // Per-model errors were already recorded with their real categories in
        // the caller above; a blanket recordError here would double-penalize
        // (and previously mis-filed everything as 'format'). If Phase 2 below
        // retries a profile that just failed here (possible via the failover
        // force-reset rescue) and it fails AGAIN, that second recordError is
        // intentional: two real failed calls, two records.
        log.warn({ err: consensusErr }, 'Consensus call failed — falling back to sequential failover');
      }
    }

    // -------------------------------------------------------------------------
    // Phase 2: Sequential fallback through remaining models.
    // -------------------------------------------------------------------------
    const _failoverStartedAt = Date.now(); // Phase 5: latency for the terminal-failure gateway-log row
    for (let attempt = 0; attempt < MAX_FAILOVER_ATTEMPTS; attempt++) {
      const profile = this.failover.getNextProfile();

      if (!profile) {
        throw new LLMError('All model profiles are exhausted or in cooldown', 'llm_all_profiles_exhausted', { attempt });
      }

      try {
        const result = await this._callSingleModel(profile, request, systemPrompt, temperature, maxTokens);
        this.idleBreaker.recordDurableProgress();
        return {
          ...result,
          routing: this._trace({
            path: 'failover',
            reason: `failover:attempt-${attempt + 1}`,
            activeModel: result.model,
            costUSD: result.usage.estimatedCost,
            failoverAttempts: attempt + 1,
          }),
        };
      } catch (err) {
        lastError = err;
        const { status, body, retryAfterMs } = Brain.extractErrorDetails(err);
        const category = this.failover.categorizeError(status, body);
        // Context overflow persists across every same-family profile — retrying
        // the identical oversized prompt is pure waste. Break out immediately with
        // a distinct error the agent loop catches to compact + retry.
        if (category === 'context_overflow') {
          throw new LLMError('Context window exceeded — prompt too long for the model', 'llm_context_overflow', { observedTokens: extractOverflowTokenCount(body ?? '') });
        }
        log.warn({ attempt, profileId: profile.id, status, category, retryAfterMs }, 'LLM call failed — trying next profile');
        this.failover.recordError(profile.id, category, { retryAfterMs });
        // Non-streaming timeout = no output produced → count toward the breaker.
        if (category === 'timeout') {
          const n = this.idleBreaker.recordIdleTimeout();
          log.warn({ attempt, profileId: profile.id, consecutiveIdle: n }, 'Idle-timeout recorded for brain idle breaker');
        }
        if (attempt < MAX_FAILOVER_ATTEMPTS - 1) {
          const waitMs = failoverBackoffMs(category, attempt, retryAfterMs);
          if (waitMs > 0) {
            log.info({ attempt, category, waitMs }, 'Failover backoff before next attempt');
            await sleep(waitMs);
          }
        }
      }
    }

    {
      // Don't serialize the raw error (SDK errors can embed API keys / Authorization
      // echoes / response bodies). Surface only structured status + category; attach
      // the original as a non-enumerable cause so it stays debuggable but isn't logged.
      const { status, body } = Brain.extractErrorDetails(lastError);
      const lastErrorCategory = this.failover.categorizeError(status, body);
      // gw-refactor Phase 5: ONE terminal-failure row for the whole failover
      // sequence (per-attempt errors are failover-internal). Fail-open helper.
      this._recordGatewayCall({
        traceId: randomUUID(),
        caller: request.source ?? 'chat',
        purpose: 'brain.call',
        priority: Brain._gatewayPriorityFor(request.source),
        irRequest: { legacy: true, messageCount: request.messages.length },
        errorClass: GATEWAY_ERROR_CLASS[lastErrorCategory] ?? 'unknown',
        latencyMs: Date.now() - _failoverStartedAt,
      });
      const allFailedErr = new LLMError('All failover attempts failed', 'llm_all_attempts_failed', {
        attempts: MAX_FAILOVER_ATTEMPTS,
        lastErrorStatus: status,
        lastErrorCategory,
      });
      Object.defineProperty(allFailedErr, 'cause', { value: lastError instanceof Error ? lastError : undefined, enumerable: false, configurable: true });
      throw allFailedErr;
    }
  }

  /**
   * Streaming LLM call. Yields text chunks as they arrive.
   *
   * @param request - The brain request parameters.
   * @yields Text chunks from the LLM stream.
   * @throws LLMError when all failover attempts are exhausted.
   */
  async *stream(request: BrainRequest): AsyncGenerator<string> {
    if (!request.messages || request.messages.length === 0) {
      throw new LLMError('BrainRequest.messages must be non-empty', 'llm_invalid_request');
    }

    const systemPrompt = await this.getSystemPrompt({ heartbeat: false });
    const temperature = this.resolveTemperature(request);
    const maxTokens = this.resolveMaxTokens(request);
    let lastError: unknown;

    const _streamFailoverStartedAt = Date.now(); // Phase 5: latency for the terminal-failure gateway-log row

    // Cross-call idle breaker: refuse to open yet another paid stream while a
    // provider is wedged (N consecutive idle-timeouts, no output). Half-opens
    // after the cooldown so a transient outage recovers without a restart.
    if (this.idleBreaker.shouldBlock()) {
      log.warn(this.idleBreaker.snapshot(), 'stream: brain idle circuit open — short-circuiting');
      throw new LLMError(this.idleBreaker.reason(), 'llm_idle_circuit_open', this.idleBreaker.snapshot());
    }

    for (let attempt = 0; attempt < MAX_FAILOVER_ATTEMPTS; attempt++) {
      const profile = this.failover.getNextProfile();

      if (!profile) {
        throw new LLMError('All model profiles are exhausted or in cooldown', 'llm_all_profiles_exhausted', { attempt });
      }

      const modelId = profile.id;
      const _streamStartedAt = Date.now();
      // Track whether THIS attempt produced any output — a pure idle stall (no
      // chunk) counts toward the breaker; partial-then-stall does not reset it.
      let yieldedAny = false;
      // Phase 5: ttft + output size for the gateway-log row (cheap counters).
      let _firstTokenAt: number | undefined;
      let _streamedChars = 0;
      log.info({ attempt, modelId }, 'Streaming LLM call starting');

      try {
        // F97 cutover: the IR transport is the ONLY wire path. A pre-first-token
        // transport failure throws to the failover catch below, which
        // classifies + cooldowns this profile and advances to the next one.
        // Once the facade resolves (first token seen) the stream is IR-owned:
        // a later terminal error throws from textStream (the transport never
        // re-requests — Rule 4) and brain's existing failover error handling
        // applies, exactly as a mid-stream provider error always did.
        const irSystem = buildEffectiveSystemPrompt(systemPrompt, request.messages);
        const facade = await streamTransportForBrain(
          {
            messages: request.messages,
            system: irSystem,
            source: request.source,
            temperature,
            maxTokens: clampMaxTokensToModel(modelId, maxTokens, { modelMax: process.env['SUDO_THINKING_MODEL_MAX'] }),
            tools: request.tools,
            ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
          },
          modelId,
        );
        if (request.sessionId !== undefined) noteTraceForSession(request.sessionId, facade.traceId);
        let irStreamCompleted = false;
        let irStreamErrored = false;
        try {
          for await (const chunk of facade.textStream) {
            if (!yieldedAny) _firstTokenAt = Date.now();
            yieldedAny = true;
            _streamedChars += chunk.length;
            yield chunk;
          }
          irStreamCompleted = true;
        } catch (err) {
          irStreamErrored = true;
          throw err;
        } finally {
          if (!irStreamCompleted && !irStreamErrored) {
            // Consumer broke out early — the model streamed fine; the
            // transport's own finally wrote the llm_calls row and aborted the
            // fetch. facade.usage settles immediately on break (last-known
            // partial usage), so bill it — fire-and-forget, NEVER throwing
            // from this finally.
            void Promise.resolve(facade.usage).then(
              (u) => {
                const usage = u !== undefined
                  ? buildTokenUsage(modelId, u, { create: u.cacheCreationInputTokens, read: u.cachedInputTokens })
                  : undefined;
                if (usage !== undefined && usage.completionTokens > 0) {
                  log.info({ modelId, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }, 'Streaming call ended early by consumer (IR transport)');
                }
                try {
                  this._recordBillingUsage(modelId, usage, { create: u?.cacheCreationInputTokens ?? 0, read: u?.cachedInputTokens ?? 0 }, Date.now() - _streamStartedAt, true, request.source ?? 'llm');
                } catch (billErr) {
                  log.warn({ modelId, err: billErr }, 'Billing record failed for cancelled IR stream (non-fatal)');
                }
              },
              () => { /* usage unavailable — facade promises never reject, defensive */ },
            );
            this.failover.recordSuccess(profile.id);
            this.idleBreaker.recordDurableProgress();
          }
        }
        this.failover.recordSuccess(profile.id);
        this.idleBreaker.recordDurableProgress();
        // Post-stream bookkeeping — best-effort, response already on the
        // wire. Brain's _recordGatewayCall AND runShadow are SKIPPED: the
        // transport already wrote the one llm_calls row for this call.
        try {
          const irUsage = await facade.usage;
          const usage = irUsage !== undefined
            ? buildTokenUsage(modelId, irUsage, { create: irUsage.cacheCreationInputTokens, read: irUsage.cachedInputTokens })
            : undefined;
          this._recordBillingUsage(modelId, usage, { create: irUsage?.cacheCreationInputTokens ?? 0, read: irUsage?.cachedInputTokens ?? 0 }, Date.now() - _streamStartedAt, true, request.source ?? 'llm');
          log.info({ modelId, promptTokens: usage?.promptTokens, completionTokens: usage?.completionTokens }, 'Streaming call completed (IR transport)');
        } catch (bookkeepErr) {
          log.warn({ modelId, err: bookkeepErr }, 'post-stream bookkeeping failed (IR path; response already delivered)');
        }
        return;

      } catch (err) {
        lastError = err;
        const { status, body, retryAfterMs } = Brain.extractErrorDetails(err);
        const category = this.failover.categorizeError(status, body);

        if (category === 'context_overflow') {
          throw new LLMError('Context window exceeded — prompt too long for the model', 'llm_context_overflow', { observedTokens: extractOverflowTokenCount(body ?? '') });
        }
        log.warn({ attempt, modelId, status, category, retryAfterMs, err }, 'Streaming LLM call failed — trying next profile');
        this.failover.recordError(profile.id, category, { retryAfterMs });
        // A timeout with zero output is a pure idle stall — count it toward the
        // cross-call breaker. Any output this attempt means real progress.
        if (category === 'timeout' && !yieldedAny) {
          const n = this.idleBreaker.recordIdleTimeout();
          log.warn({ attempt, modelId, consecutiveIdle: n }, 'Streaming idle-timeout recorded for brain idle breaker');
        }
        if (attempt < MAX_FAILOVER_ATTEMPTS - 1) {
          const waitMs = failoverBackoffMs(category, attempt, retryAfterMs);
          if (waitMs > 0) {
            log.info({ attempt, category, waitMs }, 'Streaming failover backoff before next attempt');
            await sleep(waitMs);
          }
        }
      }
    }

    {
      // Don't serialize the raw error (SDK errors can embed API keys / Authorization
      // echoes / response bodies). Surface only structured status + category; attach
      // the original as a non-enumerable cause so it stays debuggable but isn't logged.
      const { status, body } = Brain.extractErrorDetails(lastError);
      const lastErrorCategory = this.failover.categorizeError(status, body);
      // gw-refactor Phase 5: ONE terminal-failure row for the whole streaming
      // failover sequence. Fail-open helper.
      this._recordGatewayCall({
        traceId: randomUUID(),
        caller: request.source ?? 'chat',
        purpose: 'brain.stream',
        priority: Brain._gatewayPriorityFor(request.source),
        irRequest: { legacy: true, messageCount: request.messages.length },
        errorClass: GATEWAY_ERROR_CLASS[lastErrorCategory] ?? 'unknown',
        latencyMs: Date.now() - _streamFailoverStartedAt,
      });
      const streamFailErr = new LLMError('All streaming failover attempts failed', 'llm_all_attempts_failed', {
        attempts: MAX_FAILOVER_ATTEMPTS,
        lastErrorStatus: status,
        lastErrorCategory,
      });
      Object.defineProperty(streamFailErr, 'cause', { value: lastError instanceof Error ? lastError : undefined, enumerable: false, configurable: true });
      throw streamFailErr;
    }
  }

  /**
   * Fire-and-forget billing record for one completed LLM call. Persists the
   * cache-aware cost + prompt-cache split to api_call_log so the cost-reporter /
   * insights dashboards show live, cache-discounted spend (previously the table
   * had no writer and the dashboard read $0). Never throws — cost tracking must
   * not break a call. Skipped under vitest (no test-DB pollution) and via the
   * SUDO_COST_TRACKING=0 kill-switch.
   */
  /**
   * gw-refactor Phase 5: fire-and-forget GatewayCallLog row for one legacy
   * Brain call. FAIL-OPEN by contract: gated by SUDO_GATEWAY_LOG (default ON,
   * '0' disables) and fully try/caught so a logging bug can never break a
   * call. Skipped under vitest unless SUDO_GATEWAY_LOG_TEST=1 (same no-test-DB
   * -pollution idiom as _recordBillingUsage).
   *
   * NOTE: the legacy path is not IR — ir_request stores a cheap
   * {legacy:true, model, messageCount, system_chars} summary, never the full
   * messages. Full IR logging arrives with the IR transport at cutover.
   * BrainRequest carries no sessionId, so caller is request.source only and
   * noteTraceForSession is not called from Brain (session→trace correlation
   * goes live with the src/llm/client.ts path).
   */
  private _recordGatewayCall(entry: LLMCallRecord): void {
    try {
      if (process.env['SUDO_GATEWAY_LOG'] === '0') return;
      if (process.env['VITEST'] && process.env['SUDO_GATEWAY_LOG_TEST'] !== '1') return;
      getGatewayCallLog().record(entry);
    } catch (err) {
      if (!Brain._gatewayLogWarned) {
        Brain._gatewayLogWarned = true;
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Gateway call-log record failed (fail-open, warn once)');
      }
    }
  }

  /** Warn-once latch for _recordGatewayCall failures. */
  private static _gatewayLogWarned = false;

  /** Phase 5: coarse route tag for a legacy modelId ('provider/model'). */
  private static _gatewayRouteFor(modelId: string): string {
    const provider = modelId.split('/')[0] ?? 'unknown';
    return provider === 'anthropic' || provider === 'claude-oauth'
      ? 'anthropic:messages'
      : 'openai-compat:chat';
  }

  /** Phase 5: priority class from the caller tag (user-facing vs background). */
  private static _gatewayPriorityFor(source: string | undefined): string {
    return source === 'chat' || source === 'agent' ? 'user' : 'background';
  }

  private _recordBillingUsage(
    modelId: string,
    usage: TokenUsage | undefined,
    cache: { read: number; create: number },
    latencyMs: number,
    success: boolean,
    source: string,
    errorMsg?: string,
  ): void {
    if (process.env['VITEST'] || process.env['SUDO_COST_TRACKING'] === '0') return;
    try {
      getCostTracker().record({
        provider: modelId.split('/')[0] ?? 'unknown',
        model: modelId,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        estimatedCostUsd: usage?.estimatedCost,
        latencyMs,
        success,
        error: errorMsg,
        source,
        cacheReadTokens: cache.read,
        cacheCreationTokens: cache.create,
      });
    } catch { /* best-effort; cost tracking never breaks the call path */ }
  }

  /**
   * Execute a single LLM call for a given profile.
   * Handles model resolution, tool attachment, refusal detection, and text fallback.
   * Records success/error on the failover tracker.
   */
  /**
   * BO2b/S1 prompt-cache tail relocation. Returns a NEW message array with the
   * per-turn volatile context moved to a single user-role message at the TAIL
   * (immediately before the latest user message). brainRequestToIR folds every
   * role:'system' message into ir.system — the cached prefix that precedes the
   * WHOLE conversation — so any per-turn system content there (workspace daily
   * log '## Today', AUTO-ROUTING hints, deep insights, commitments, activation)
   * plus the volatile Recent-Memory+Date block busts the history cache. Moving
   * them to a user-role tail message keeps ir.system byte-stable (persona only)
   * so the append-only history caches too, while the model still receives every
   * string (repositioned, not dropped). Never mutates the input array.
   *
   * Kept in the cached prefix (byte-stable turn-over-turn): _durable system
   * messages (compaction summaries, session-fork handoffs = collapsed history)
   * and the session-stable memory blocks (## Yesterday, ## Long-Term Memory).
   * Off with SUDO_PROMPT_CACHE_TAIL_MEMORY=0 (or SUDO_PROMPT_CACHE=0) → returns
   * the input array unchanged (byte-identical to prior behavior).
   */
  private _applyTailRelocation(messages: BrainMessage[], volatileTailBlock: string): BrainMessage[] {
    const on =
      process.env['SUDO_PROMPT_CACHE'] !== '0' &&
      process.env['SUDO_PROMPT_CACHE_TAIL_MEMORY'] !== '0';
    // SUDO_FOLD_SYSTEM_MESSAGES is a distinct, mutually-exclusive strategy that
    // folds array system messages into the system param — let it own them.
    if (!on || readFoldSystemEnabled()) return messages;
    return relocateVolatileToTail(messages, volatileTailBlock);
  }

  private async _callSingleModel(
    profile: ModelProfile,
    request: BrainRequest,
    systemPrompt: string,
    temperature: number,
    maxTokens: number,
  ): Promise<BrainResponse> {
    let modelId: string;
    // ALWAYS use the profile's model ID. The caller (cloud racing / failover loop)
    // already selected the correct profile. Using request.model or routeModel() here
    // overrides the profile and breaks failover — all parallel calls hit the same
    // model, and fallback to local models still calls the cloud model.
    modelId = profile.id;

    // SUDO_PROMPT_CACHE=1 + Anthropic model: explicit cache_control breakpoints
    // (see stream() — same gating; non-Anthropic paths unchanged).
    const cacheBreakpoints = isCacheBreakpointsEnabled() && isAnthropicModelId(modelId);

    // Fold dropped array system messages into the model input (opt-in). No-op
    // when SUDO_FOLD_SYSTEM_MESSAGES is unset → byte-identical to prior behavior.
    // Cache path: persona stays in buildCachedSystemMessages(systemPrompt)
    // (cached prefix preserved) and the folded content rides a separate uncached
    // system message. Non-cache path: folded into the `system` param.
    // BO2b/S1: relocate per-turn volatile context to the tail on a COPY (never
    // mutate request.messages — the failure-summary messageCount must reflect the
    // original request). The volatile block is threaded on a transient request
    // field (set in call()) to avoid changing _callSingleModel's arity. No-op when
    // the flag is off or nothing is relocatable.
    const volatileTailBlock = (request as { _volatileTailBlock?: string })._volatileTailBlock ?? '';
    const wireMessages = this._applyTailRelocation(request.messages, volatileTailBlock);
    const effectiveSystem = buildEffectiveSystemPrompt(systemPrompt, wireMessages);
    // Telemetry: exact size of the in-loop system guidance folded into the model
    // input this call (the per-turn token cost of SUDO_FOLD_SYSTEM_MESSAGES).
    if (readFoldSystemEnabled()) {
      const foldedChars = extractSystemMessageContent(wireMessages).length;
      if (foldedChars > 0) {
        log.info({ foldedChars, approxTokens: Math.round(foldedChars / 4), cachePath: cacheBreakpoints, model: modelId }, 'system-fold: in-loop guidance delivered to model');
      }
    }

    // F97: the transport's adapters own message/system/tool wire shaping,
    // provider tool-name sanitization + reversal, and prompt-cache breakpoints.
    // This map stays only for the text/JSON tool-call fallback parsers below
    // (structured names already arrive reversed from the transport).
    const toolNameReverseMap = new Map<string, string>();
    const _callStartedAt = Date.now();
    // F97 cutover: the ONE wire hop goes through the IR transport, wrapped in
    // the auth-profile key-rotation port (env-key providers with 2+ numbered
    // keys rotate via CallIROptions.apiKeyOverride). Everything around it —
    // failover loop, cooldowns, billing, post-processing below — is unchanged.
    // A transport throw lands in the failover catch, which classifies +
    // cooldowns this profile and advances to the next one.
    const irRequestBase = {
      messages: wireMessages,
      system: effectiveSystem,
      source: request.source,
      temperature,
      maxTokens: clampMaxTokensToModel(modelId, maxTokens, { modelMax: process.env['SUDO_THINKING_MODEL_MAX'] }),
      tools: request.tools,
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
    };
    const irCall = await this._callIRWithKeyRotation(profile, irRequestBase, modelId);
    const _irTraceId = irCall.traceId;
    // Session→trace correlation: markOutcomeForSession lands on the
    // transport's llm_calls row for this call.
    if (request.sessionId !== undefined) noteTraceForSession(request.sessionId, irCall.traceId);
    let result = irCall.result as unknown as BrainCompletion;

    // --- Tool-empty retry: some providers (Ollama cloud) return empty content
    // when tools are attached but don't actually support structured tool calls.
    // Retry once WITHOUT tools to get a text response.
    // Kill-switch: SUDO_TOOL_EMPTY_RETRY_DISABLE=1
    // ---
    const hadTools = request.tools && request.tools.length > 0;
    const isEmpty = (!result.text || result.text.trim().length === 0) && (result.toolCalls ?? []).length === 0;
    if (
      hadTools &&
      isEmpty &&
      process.env['SUDO_TOOL_EMPTY_RETRY_DISABLE'] !== '1'
    ) {
      log.warn({ modelId }, 'Empty response with tools — retrying without tools');
      // Same attempt, no tools, slightly raised temperature to avoid
      // deterministic empty loops — through the transport (F97).
      const { tools: _droppedTools, ...noToolReq } = irRequestBase;
      const retry = await callTransportForBrain(
        { ...noToolReq, temperature: Math.min(temperature + 0.1, 1.0) },
        modelId,
      );
      result = retry.result as unknown as BrainCompletion;
      log.info({ modelId, textLen: result.text?.length ?? 0 }, 'Retried without tools');
    }
    // --- end tool-empty retry ---

    // --- Grok refusal detection (kill-switch: SUDO_GROK_REFUSAL_DETECT_DISABLE=1) ---
    if (process.env['SUDO_GROK_REFUSAL_DETECT_DISABLE'] !== '1') {
      if (isGrokRefusal(result.text ?? '')) {
        log.warn({ modelId }, 'Grok refusal detected in 200-OK body — treating as error');
        throw new LLMError('Grok refusal detected', 'llm_grok_refusal');
      }
    }
    // --- end refusal detection ---

    // --- Reasoning field extraction (Ollama cloud models) ---
    // Ollama cloud models (kimi-k2.6:cloud, glm-5.1:cloud) return actual content
    // in result.reasoning, NOT result.text. The Vercel AI SDK exposes this.
    // If text is empty but reasoning exists, use reasoning as the content.
    let extractedText = result.text ?? '';
    if (!extractedText.trim()) {
      // SDK v6: the plain reasoning string lives in result.reasoningText, while
      // result.reasoning is an Array<ReasoningPart> ({ type, text }). Prefer the
      // string field; fall back to joining the array parts. Keep string/object
      // handling for compatibility with older SDK shapes.
      const reasoning = result.reasoning as unknown;
      if (result.reasoningText && result.reasoningText.trim()) {
        extractedText = result.reasoningText;
      } else if (Array.isArray(reasoning)) {
        extractedText = reasoning
          .map((p) => (p as { text?: string })?.text ?? '')
          .join('');
      } else if (typeof reasoning === 'string') {
        extractedText = reasoning;
      } else if (reasoning && typeof reasoning === 'object') {
        extractedText = (reasoning as { text?: string }).text ?? '';
      }
      if (extractedText.trim()) {
        log.debug({ modelId, reasoningLen: extractedText.length }, 'Extracted content from reasoning field');
      }
    }
    // --- end reasoning extraction ---

    const cacheTokens = extractPromptCacheTokens((result as { providerMetadata?: unknown }).providerMetadata);
    const usage = buildTokenUsage(modelId, result.usage, cacheTokens);
    this._recordBillingUsage(modelId, usage, cacheTokens, Date.now() - _callStartedAt, true, request.source ?? 'llm');
    const toolCalls = this.extractToolCalls(result.toolCalls ?? []);
    const finishReason = (result.finishReason ?? 'stop') as BrainResponse['finishReason'];

    // Fallback: parse XML or JSON text tool calls if structured output is empty.
    let finalToolCalls = toolCalls;
    let finalContent = extractedText;
    let finalFinishReason = finishReason;

    if (
      process.env['SUDO_TEXT_TOOLCALL_FALLBACK_DISABLE'] !== '1' &&
      finalToolCalls.length === 0 &&
      finishReason !== 'tool-calls'
    ) {
      // Strip the balanced {...} object(s) containing "tool_calls" (depth-counted via
      // findBalancedJsonObjects) instead of a greedy regex that stops at the first
      // `}` — the regex left `]}` fragments visible or excised surrounding prose.
      const stripJsonToolCalls = (text: string): string => {
        let out = text;
        for (const obj of findBalancedJsonObjects(text)) {
          if (obj.includes('"tool_calls"')) out = out.replace(obj, '');
        }
        return out.trim();
      };

      // Scan result.text first, then result.reasoningText — some reasoning models
      // express tool intent in reasoning rather than message text, so the fallback
      // would otherwise silently miss the call and narrate a side-effect that never ran.
      const sources: string[] = [];
      if (typeof result.text === 'string') sources.push(result.text);
      if (typeof result.reasoningText === 'string') sources.push(result.reasoningText);

      for (const src of sources) {
        if (finalToolCalls.length > 0) break;
        if (src.includes('<tool_call>')) {
          finalToolCalls = this._parseTextToolCalls(src, toolNameReverseMap);
          if (finalToolCalls.length > 0) {
            finalContent = src.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
          }
        } else if (src.includes('"tool_calls"')) {
          finalToolCalls = this._parseJsonToolCalls(src, toolNameReverseMap);
          if (finalToolCalls.length > 0) {
            finalContent = stripJsonToolCalls(src);
          }
        }
      }

      if (finalToolCalls.length > 0) {
        finalFinishReason = 'tool-calls';
        log.warn(
          { modelId, count: finalToolCalls.length, via: finalContent !== result.text ? 'json' : 'xml' },
          'Text tool-call fallback ACTIVATED — finishReason flipped to tool-calls',
        );
      }
    }

    // Reverse provider-sanitized tool names back to the dotted originals so the
    // agent dispatcher resolves the real tool (mcp_connect -> mcp.connect). Covers
    // both structured tool_calls and the text/JSON fallback parsers, since the
    // model only ever saw the sanitized names.
    if (toolNameReverseMap.size > 0) {
      for (const c of finalToolCalls) {
        const original = toolNameReverseMap.get(c.name);
        if (original) c.name = original;
      }
    }

    this.failover.recordSuccess(profile.id);
    // Prompt-cache diagnostic (gated, no behaviour change when unset). Logs the raw
    // providerMetadata Anthropic returned plus a stable-prefix fingerprint, so we can
    // tell mint-vs-read-vs-silent and detect byte-instability across consciousness ticks.
    if (process.env['SUDO_PROMPT_CACHE_DEBUG'] === '1') {
      try {
        let stablePrefixHash: string | undefined;
        let stablePrefixLen: number | undefined;
        if (cacheBreakpoints) {
          const cached = buildCachedSystemMessages(systemPrompt)[0]?.content ?? '';
          stablePrefixLen = cached.length;
          stablePrefixHash = createHash('sha256').update(cached).digest('hex').slice(0, 12);
        }
        log.info({
          modelId,
          cacheBreakpoints,
          stablePrefixHash,
          stablePrefixLen,
          providerMetadata: (result as { providerMetadata?: unknown }).providerMetadata,
        }, 'prompt-cache-debug: raw providerMetadata (call path)');
      } catch (e) {
        log.warn({ err: e }, 'prompt-cache-debug: providerMetadata logging failed');
      }
    }
    recordPromptCacheUsageFromProviderMetadata((result as { providerMetadata?: unknown }).providerMetadata);
    log.info({ modelId, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, estimatedCost: usage.estimatedCost, finishReason: finalFinishReason }, 'LLM call succeeded');

    // F97: no brain-side GatewayCallLog row and no runShadow — the transport
    // wrote the one llm_calls row (trace ${_irTraceId}), and the legacy
    // ai-SDK transformation the shadow compared no longer runs.
    void _irTraceId;

    return {
      content: finalContent, toolCalls: finalToolCalls, usage,
      model: modelId, finishReason: finalFinishReason,
      // Resolved sampling — captured for deterministic replay (SUDO_TRACE_CAPTURE).
      sampling: { temperature, maxTokens, ...(request.seed !== undefined ? { seed: request.seed } : {}) },
    };
  }

  /**
   * Decide whether this turn is eligible for the cheap-model fast-path.
   *
   * Combines two previously-dormant routers:
   *  - cost-optimizer: `estimateTaskComplexity()` gives a 1–10 difficulty signal
   *    and `pickOptimalModel(..., 'cheapest')` resolves the cheap-tier model when
   *    no explicit `SUDO_CHEAP_MODEL` is configured.
   *  - dispatch-router: applies the cheap-model-router guards plus novelty scoring,
   *    an LRU cache, and the anti-self-promotion guard.
   *
   * Returns the chosen cheap model when (and only when) the turn is simple AND a
   * genuinely cheaper model than the primary is available; otherwise null, which
   * leaves the existing consensus + failover path fully intact.
   *
   * Kill-switch: SUDO_SMART_ROUTE_DISABLE=1.
   */
  private _smartRoute(
    request: BrainRequest,
  ): { model: string; reason: string; complexity: number; kind: RoutingPath } | null {
    // -----------------------------------------------------------------------
    // Per-session cache affinity (opt-in; default OFF => byte-identical routing).
    // When enabled for a conversational session, stick to ONE provider so its
    // prompt cache stays warm (S1). The smart router still governs turn-1
    // discovery, every non-affinity session, and every non-conversational call
    // (no sessionId) — the S16 learning lead is never disabled.
    // -----------------------------------------------------------------------
    if (
      sessionCacheAffinityEnabled() &&
      request.sessionId &&
      request.race !== true &&
      (!request.model || request.model === 'auto')
    ) {
      let pin = getSessionAffinity(request.sessionId);
      if (!pin) {
        // Explicit operator pin skips first-turn discovery; otherwise fall
        // through to normal routing THIS turn and capture the winner in call().
        const explicit = explicitAffinityProvider();
        if (explicit) pin = setSessionAffinity(request.sessionId, explicit);
      }
      if (pin) {
        return { model: pin.model, reason: 'cache-affinity', complexity: 0, kind: 'affinity' };
      }
    }

    if (process.env['SUDO_SMART_ROUTE_DISABLE'] === '1') return null;
    // Respect explicit model pins and callers that force the cloud race.
    if (request.model && request.model !== 'auto') return null;
    if (request.race === true) return null;

    const lastUserMsg = [...request.messages].reverse().find((m) => m.role === 'user');
    const userText = lastUserMsg?.content ?? '';
    if (!userText.trim()) return null;

    // cost-optimizer: difficulty signal + cheap-tier model resolution.
    // Resolution order: SUDO_CHEAP_MODEL env → config models.cheap → cost-optimizer.
    const complexity = estimateTaskComplexity(userText);
    const cheapModel =
      process.env['SUDO_CHEAP_MODEL']?.trim() ||
      this.config?.models?.cheap ||
      pickOptimalModel(complexity, 'cheapest');

    // C9: reasoning-tier — couple reasoningLevel to model selection. High/xhigh
    // reasoning prefers the stronger (premium) tier, taking precedence over the
    // cheap fast-path so deep-reasoning turns are never down-routed. Inert when no
    // premium model is configured. Resolution: SUDO_PREMIUM_MODEL → models.premium.
    // Kill-switch: SUDO_REASONING_TIER_DISABLE=1.
    if (
      process.env['SUDO_REASONING_TIER_DISABLE'] !== '1' &&
      (request.reasoningLevel === 'high' || request.reasoningLevel === 'xhigh')
    ) {
      const premiumModel = process.env['SUDO_PREMIUM_MODEL']?.trim() || this.config?.models?.premium;
      if (premiumModel && premiumModel !== this.primaryModel) {
        return { model: premiumModel, reason: `reasoning-tier:${request.reasoningLevel}`, complexity, kind: 'reasoning-tier' };
      }
    }

    // Cheap fast-path — only when a genuinely cheaper model than the primary exists.
    // dispatch-router applies the cheap-model-router guards + novelty + LRU cache.
    if (cheapModel && cheapModel !== this.primaryModel) {
      const decision = this.dispatchRouter.route({
        userText,
        history: request.messages as unknown as HistoryMessage[],
        primaryModel: this.primaryModel,
        cheapModel,
        hasAttachments: (lastUserMsg?.images?.length ?? 0) > 0,
      });
      if (decision.cheapUsed) {
        return { model: decision.model, reason: decision.reason, complexity, kind: 'cheap' };
      }
    }

    // A3: explicit "auto" → let the zero-cost keyword model-router pick a
    // category-appropriate model (coding/analysis/research/fast). Inert while the
    // category models all resolve to the primary; activates once they differ.
    if (request.model === 'auto') {
      const routed = routeModel('', userText);
      if (routed.model && routed.model !== this.primaryModel) {
        return { model: routed.model, reason: `category-route:${routed.category}`, complexity, kind: 'category' };
      }
    }

    return null;
  }

  /**
   * Run one IR-transport call for a profile through the auth-profile rotation
   * path (F97 port of the former ai-SDK _generateWithKeyRotation).
   *
   * When 2+ numbered API keys are configured for the provider (e.g.
   * XAI_API_KEY_1, XAI_API_KEY_2), each rate-limit / auth / billing failure
   * rotates to the next key (CallIROptions.apiKeyOverride) and retries the
   * SAME model before the caller's model-level failover gives up. Non-key
   * errors (overload, timeout, format, …) propagate immediately so the
   * model-failover loop can switch models. Custom providers and the oauth
   * managers (claude-oauth / xai-oauth) carry their own single credential —
   * no rotation, plain transport call.
   */
  private async _callIRWithKeyRotation(
    profile: ModelProfile,
    irRequest: Parameters<typeof callTransportForBrain>[0],
    modelId: string,
  ): Promise<BrainTransportCall> {
    // ModelProfile.provider is typed narrower than runtime reality (profiles
    // carry claude-oauth / xai-oauth / ollama / custom names too) — widen.
    const provider: string = profile.provider;
    if (isCustomProvider(provider) || provider === 'claude-oauth' || provider === 'xai-oauth' || provider === 'ollama') {
      return callTransportForBrain(irRequest, modelId);
    }
    const keyCount = this._ensureRotationKeys(provider);
    if (keyCount < 2) {
      return callTransportForBrain(irRequest, modelId);
    }
    let lastErr: unknown;
    for (let k = 0; k < keyCount; k++) {
      const key = this.authRotation.getNextKey(provider);
      if (!key) break;
      try {
        const res = await callTransportForBrain(irRequest, modelId, { apiKeyOverride: key.apiKey });
        this.authRotation.reportSuccess(provider, key.keyId);
        return res;
      } catch (err) {
        lastErr = err;
        const { status, body } = Brain.extractErrorDetails(err);
        const authCat = Brain._toAuthErrorCategory(this.failover.categorizeError(status, body));
        // Not a key-specific failure (overload/timeout/format) — let the
        // model-failover loop handle it rather than burning more keys.
        if (!authCat) throw err;
        log.warn({ provider, keyId: key.keyId, status, authCat }, 'API key error — rotating to next key');
        this.authRotation.reportError(provider, key.keyId, authCat);
      }
    }
    throw lastErr ?? new LLMError('All API keys for provider exhausted', 'llm_all_keys_exhausted', { provider });
  }

  /**
   * Lazily load a provider's numbered env keys into the rotation manager (once per
   * provider per Brain instance) and return how many keys are registered.
   */
  private _ensureRotationKeys(provider: string): number {
    if (!this.rotationLoaded.has(provider)) {
      this.rotationLoaded.add(provider);
      this.authRotation.loadKeysFromEnv(provider);
    }
    return this.authRotation.getStatus(provider).length;
  }

  /**
   * Map a Brain failover ErrorCategory to the rotation manager's AuthErrorCategory.
   * Returns null for errors that are NOT key-specific (so they skip rotation and
   * trigger model-level failover instead).
   */
  private static _toAuthErrorCategory(category: ErrorCategory): AuthErrorCategory | null {
    switch (category) {
      case 'rate_limit':
        return 'rate_limit';
      case 'billing':
        return 'billing_error';
      case 'auth':
      case 'auth_permanent':
        return 'auth_invalid';
      default:
        return null;
    }
  }

  /**
   * Resolve latency-aware consensus options from the request, falling back to
   * per-process env defaults. All-undefined (the default) makes the consensus
   * phase wait for every model — behavior-preserving.
   */
  private _consensusOptions(request: BrainRequest): ConsensusOptions {
    const num = (v: unknown): number | undefined => {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    };
    const minAgreement = num(request.consensusMinAgreement) ?? num(process.env['SUDO_CONSENSUS_MIN_AGREEMENT']);
    const minResponders = num(request.consensusMinResponders) ?? num(process.env['SUDO_CONSENSUS_MIN_RESPONDERS']);
    const timeoutMs = num(request.consensusTimeoutMs) ?? num(process.env['SUDO_CONSENSUS_TIMEOUT_MS']);
    return {
      // Only a threshold in (0, 1] enables agreement-based early-exit.
      minAgreement: minAgreement !== undefined && minAgreement > 0 && minAgreement <= 1 ? minAgreement : undefined,
      minResponders: minResponders !== undefined && minResponders >= 1 ? Math.floor(minResponders) : undefined,
      timeoutMs: timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : undefined,
    };
  }

  /**
   * Build a RoutingTrace for the answer and emit a compact, human-readable
   * routing line (observability + cost transparency). Returned for attachment
   * to the BrainResponse so UIs/channels can surface the decision.
   */
  private _trace(opts: {
    path: RoutingPath;
    reason: string;
    activeModel: string;
    costUSD: number;
    selectedModel?: string;
    consensus?: { agreement: number; method: 'fastest' | 'most-detailed' };
    failoverAttempts?: number;
  }): RoutingTrace {
    const selectedModel = opts.selectedModel ?? this.primaryModel;
    const trace: RoutingTrace = {
      path: opts.path,
      reason: opts.reason,
      selectedModel,
      activeModel: opts.activeModel,
      switched: opts.activeModel !== selectedModel,
      costUSD: opts.costUSD,
      ...(opts.consensus ? { consensus: opts.consensus } : {}),
      ...(opts.failoverAttempts !== undefined ? { failoverAttempts: opts.failoverAttempts } : {}),
    };
    log.info({ routing: trace }, describeRouting(trace));
    return trace;
  }

  /**
   * Build a minimal ModelProfile wrapper for an arbitrary model string so the
   * fast-path can reuse `_callSingleModel()`. Only `id` is consumed there; the
   * remaining fields carry inert defaults and never touch the failover registry.
   */
  private _syntheticProfile(modelString: string): ModelProfile {
    const slash = modelString.indexOf('/');
    const provider = (slash >= 0 ? modelString.slice(0, slash) : modelString) as ModelProfile['provider'];
    const modelId = slash >= 0 ? modelString.slice(slash + 1) : modelString;
    return {
      id: modelString,
      provider,
      modelId,
      priority: 0,
      lastUsed: 0,
      cooldownUntil: 0,
      consecutiveErrors: 0,
      disabled: false,
    };
  }

  /**
   * Return a diagnostic snapshot of all model profiles and their cooldown state.
   */
  getFailoverStatus(): ReturnType<ModelFailover['getStatus']> {
    return this.failover.getStatus();
  }

  /**
   * Force-reset all model cooldowns and error counters.
   * Call after a restart or when provider outages are known to have resolved.
   */
  resetAllCooldowns(): void {
    this.failover.resetAllCooldowns();
  }

  // ---------------------------------------------------------------------------
  // Error detail extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract HTTP status code and body from an error, handling Vercel AI SDK's
   * nested error wrapping (RetryError -> APICallError).
   *
   * The SDK wraps provider errors in a RetryError that has no statusCode field.
   * The real status lives inside the lastError/errors array as an APICallError
   * with a `statusCode` property.
   */
  private static extractErrorDetails(err: unknown): { status: number; body: string | undefined; retryAfterMs: number | undefined } {
    // Collect every node in the SDK's error wrapping. The real APICallError
    // (carrying statusCode + responseBody) can be the error itself, nested
    // under `.cause` (standard Error chaining the streamText path uses),
    // `.lastError` (RetryError), or inside an `.errors[]` array. Walking all of
    // them means a buried 401 is recovered instead of defaulting to 500 — the
    // bug that made a dead OAuth token look like a transient "overloaded" blip.
    const nodes = Brain._collectErrorNodes(err);

    // Prefer the most specific status: a concrete non-500 code from any node
    // wins over a missing/500 one. Pair `body` with the node whose status won
    // (BUG-10-02): a later status-winner with no body of its own must not keep
    // an earlier, unrelated node's body — that logs a misleading status/body mix.
    let status: number | undefined;
    let statusBody: string | undefined; // body from the status-winning node
    let fallbackBody: string | undefined; // first body seen, used only when no status node exists
    let numericStatusFound = false;
    for (const obj of nodes) {
      const s = (obj['statusCode'] as number | undefined) ?? (obj['status'] as number | undefined);
      const b = (obj['responseBody'] as string | undefined) ?? (obj['message'] as string | undefined);
      if (typeof s === 'number' && (status === undefined || (status === 500 && s !== 500))) {
        status = s;
        statusBody = b; // pair with the trusted node (may be undefined)
        numericStatusFound = true;
      }
      if (!fallbackBody && b) fallbackBody = b;
    }

    // Signature scan for auth (401): a streamed auth failure can surface with a
    // MISLEADING outer status (a wrapper's 400/429, or a 500) while the real
    // cause named in the text is an auth error. Run this UNCONDITIONALLY
    // (BUG-10-01): 401 maps to a *recoverable* AUTH cooldown in failover, so
    // parking there behind a misleading status is the correct, reversible action.
    const hay = nodes
      .map((o) => `${String(o['responseBody'] ?? '')} ${String(o['message'] ?? '')}`)
      .join(' ')
      .toLowerCase();
    if (/authentication_error|invalid bearer token|invalid[_ ]api[_ ]key|invalid x-api-key|invalid_grant|oauth token (?:expired|invalid)/.test(hay)) {
      status = 401;
    } else if (
      // Permission (403) is DIFFERENT: it maps to auth_permanent → the failover
      // profile is disabled PERMANENTLY, not cooled down. So we do NOT upgrade
      // unconditionally — that would let an incidental "permission_error" string
      // echoed in tool output permanently kill a model. Only upgrade when we
      // have no trustworthy concrete status AND the structured JSON error shape
      // (`"type":"permission_error"`) is present, not a bare substring.
      (status === undefined || status === 500) &&
      /"type"\s*:\s*"permission_error"/.test(hay)
    ) {
      status = 403;
    }

    // If a node carried a numeric status, its own body is authoritative — even
    // when absent — so we never mislabel an unrelated node's body with the
    // winning status (BUG-10-02). Only when NO numeric-status node exists (e.g.
    // a signature-only auth match) do we fall back to the first body seen, which
    // is the text that named the cause.
    const body = numericStatusFound ? statusBody : fallbackBody;

    if (process.env['SUDO_DEBUG_ERR_BODY'] === '1' && typeof status === 'number' && status >= 400 && status < 500) {
      log.warn({ status, body: String(body ?? '').slice(0, 800) }, 'DEBUG: provider 4xx error body');
    }

    return { status: status ?? 500, body, retryAfterMs: Brain._extractRetryAfter(err) };
  }

  /**
   * Walk the SDK's error wrapping (`cause`, `lastError`, `errors[]`) and return
   * every object node, deepest-first traversal, cycle-safe. Shared by
   * extractErrorDetails and _extractRetryAfter so both see the same nodes —
   * previously _extractRetryAfter skipped `.cause` and missed Retry-After
   * headers on the streamText path (BUG-10-03). Chains deeper than the limit
   * are logged rather than silently truncated (BUG-10-06).
   */
  private static _collectErrorNodes(err: unknown): Record<string, unknown>[] {
    const MAX_DEPTH = 6;
    const nodes: Record<string, unknown>[] = [];
    const seen = new Set<unknown>();
    let truncated = false;
    const visit = (e: unknown, depth: number): void => {
      if (!e || typeof e !== 'object' || seen.has(e)) return;
      if (depth > MAX_DEPTH) { truncated = true; return; }
      seen.add(e);
      const obj = e as Record<string, unknown>;
      nodes.push(obj);
      visit(obj['cause'], depth + 1);
      visit(obj['lastError'], depth + 1);
      const errs = obj['errors'];
      if (Array.isArray(errs)) for (const inner of errs) visit(inner, depth + 1);
    };
    visit(err, 0);
    if (truncated) {
      log.debug({ nodeCount: nodes.length, maxDepth: MAX_DEPTH }, 'extractErrorDetails: error chain exceeded depth limit — deeper nodes ignored');
    }
    return nodes;
  }

  /**
   * Extract a Retry-After hint (in ms) from an error's response headers, digging
   * through the SDK's RetryError wrapping (lastError / errors[]). Returns undefined
   * when no usable Retry-After is present.
   */
  private static _extractRetryAfter(err: unknown): number | undefined {
    // Share the full traversal (incl. `.cause`) so a Retry-After header on the
    // streamText path's nested cause is honored, not just top/lastError/errors[]
    // (BUG-10-03).
    const candidates = Brain._collectErrorNodes(err);

    for (const c of candidates) {
      const headers = (c['responseHeaders'] ?? c['headers']) as Record<string, unknown> | undefined;
      const raw = Brain._headerValue(headers, 'retry-after');
      const ms = Brain._parseRetryAfter(raw);
      if (ms !== undefined) return ms;
    }
    return undefined;
  }

  /** Case-insensitive header lookup returning the value as a string. */
  private static _headerValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === name) {
        const v = headers[k];
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return String(v);
        // Node's IncomingHttpHeaders / fetch polyfills can present a value as
        // string[] — take the first entry rather than dropping it (BUG-10-04).
        if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
        return undefined;
      }
    }
    return undefined;
  }

  /** Parse a Retry-After value (delta-seconds or HTTP-date) into milliseconds-from-now. */
  private static _parseRetryAfter(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const trimmed = raw.trim();
    const secs = Number(trimmed);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
      const delta = dateMs - Date.now();
      return delta > 0 ? delta : 0;
    }
    return undefined;
  }
}
