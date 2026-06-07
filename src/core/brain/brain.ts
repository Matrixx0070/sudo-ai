/**
 * Brain — the central intelligence core of SUDO-AI v3.
 *
 * Wraps the Vercel AI SDK with multi-model failover, persona/mood management,
 * system prompt assembly, token cost tracking, and streaming support.
 */

import { generateText, streamText, tool as aiTool, jsonSchema } from 'ai';
import { createLogger } from '../shared/logger.js';
import { LLMError } from '../shared/errors.js';
import { DEFAULT_MODEL, FALLBACK_MODEL, MAX_AGENT_ITERATIONS } from '../shared/constants.js';
import { ModelFailover } from './failover.js';
import { getModel, getModelWithKey, initProviders } from './providers.js';
import { assembleSystemPrompt } from './system-prompt.js';
import { getPersonaTemperature } from './personas.js';
import { getMoodTemperatureDelta } from './moods.js';
import { buildTokenUsage } from './costs.js';
import { isGrokRefusal } from './grok-refusal-detect.js';
import { queryAllModelsConsensus } from './model-consensus.js';
import { DispatchRouter } from './dispatch-router.js';
import { estimateTaskComplexity, pickOptimalModel } from './cost-optimizer.js';
import { routeModel } from './model-router.js';
import { AuthProfileRotation } from './auth-profile-rotation.js';
import type { AuthErrorCategory } from './auth-profile-rotation.js';
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
} from './types.js';
import type { SudoConfig } from '../config/types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { NegativeRouter, RoutingResult } from './negative-router.js';
import type { HistoryMessage } from '../agent/cheap-model-router.js';

const log = createLogger('brain');

/** Maximum number of provider failover attempts per call. */
const MAX_FAILOVER_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Concatenated-JSON splitter — handles LLMs that batch multiple tool call
// argument objects into a single arguments string, e.g. grok-3 via xai.
// ---------------------------------------------------------------------------

/**
 * Split a string that may contain one or more concatenated JSON objects.
 *
 * The scanner tracks brace depth and whether it is inside a JSON string
 * literal (respecting backslash-escape sequences), so values that contain
 * literal `{` or `}` characters inside strings are handled correctly.
 *
 * @param raw - The raw arguments string from the LLM.
 * @returns An array of parsed objects; empty array on total failure.
 */
export function splitConcatenatedJsonObjects(raw: string): Record<string, unknown>[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return [];

  const results: Record<string, unknown>[] = [];
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let objectStart = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const segment = trimmed.slice(objectStart, i + 1);
        try {
          const parsed = JSON.parse(segment) as Record<string, unknown>;
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            results.push(parsed);
          }
        } catch {
          // malformed segment — skip it
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Message format conversion: internal BrainMessage -> Vercel AI SDK ModelMessage
// ---------------------------------------------------------------------------

/**
 * Convert our internal BrainMessage[] to the format that Vercel AI SDK's
 * generateText/streamText expects (ModelMessage[]).
 *
 * Key differences:
 * - Assistant messages with tool calls use content array with ToolCallPart objects
 * - Tool result messages use content array with ToolResultPart objects
 */
function toSDKMessages(messages: BrainMessage[]): unknown[] {
  return messages
    .filter((msg) => {
      // System messages are handled via the 'system' param of generateText.
      // Including them in the messages array causes SDK schema validation errors.
      return msg.role !== 'system';
    })
    .map((msg) => {
      // Assistant message with tool calls: convert to content array format.
      // The SDK expects ToolCallPart objects in the content array.
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const contentParts: unknown[] = [];
        if (msg.content) {
          contentParts.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          contentParts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.name,
            // Ensure input is always an object, never null/undefined.
            input: tc.arguments ?? {},
          });
        }
        return { role: 'assistant', content: contentParts };
      }

      // Tool result message: ALWAYS convert to content array with tool-result parts.
      // The SDK v6 requires role='tool', content = array of ToolResultPart.
      // Never let a tool message fall through to plain string content — SDK rejects it.
      if (msg.role === 'tool') {
        const callId = msg.toolCallId ?? `fallback_${Date.now()}`;
        return {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            toolName: msg.toolName ?? '',
            output: { type: 'text', value: typeof msg.content === 'string' ? msg.content : String(msg.content ?? '') },
          }],
        };
      }

      // Plain assistant and user messages pass through as-is.
      return { role: msg.role, content: msg.content ?? '' };
    });
}

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
  private currentPersona: PersonaType = 'assistant';
  private currentMood: MoodType = 'focused';
  private readonly config: SudoConfig | null;
  /** RAG engine — injected post-construction via setRAGEngine(). Null = no retrieval. */
  private ragEngine: RAGEngineInterface | null = null;
  /** Negative router — injected post-construction via setNegativeRouter(). Undefined = no routing. */
  private negativeRouter: NegativeRouter | undefined;
  /** Highest-priority model id, captured at construction — the primary for smart-routing. */
  private readonly primaryModel: string;
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
    this.primaryModel = modelIds[0] ?? DEFAULT_MODEL;
    // Auto-init providers on construction (async, awaited on first call)
    this.providersReady = initProviders();
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
  private _parseTextToolCalls(text: string): ToolCallFromLLM[] {
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
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        log.warn({ raw }, 'Text tool-call fallback: JSON parse failed — skipping block');
        continue;
      }

      const name = typeof parsed['name'] === 'string' ? parsed['name'] : '';
      if (!name) {
        log.warn({ parsed }, 'Text tool-call fallback: missing "name" field — skipping');
        continue;
      }

      // SECURITY: tool name must be in live registry — rejects injection from external content.
      if (!knownToolNames.has(name)) {
        log.warn({ name }, 'Text tool-call fallback: tool name not in registry — DROPPED (injection guard)');
        continue;
      }

      const args = (parsed['args'] ?? parsed['arguments'] ?? parsed['input'] ?? {}) as Record<string, unknown>;
      const id = `text-tc-${Date.now()}-${results.length}`;
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
  private _parseJsonToolCalls(text: string): ToolCallFromLLM[] {
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

    // Find JSON objects containing "tool_calls" key anywhere in the text.
    const results: ToolCallFromLLM[] = [];
    const jsonPattern = /\{[\s\S]*?"tool_calls"[\s\S]*?\}/g;
    let match: RegExpExecArray | null;

    while ((match = jsonPattern.exec(text)) !== null) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        // The outer JSON may be incomplete — try to extract just the tool_calls array.
        const arrMatch = /"tool_calls"\s*:\s*(\[[\s\S]*?\])/.exec(match[0]);
        if (!arrMatch) continue;
        try {
          const calls = JSON.parse(arrMatch[1]) as unknown[];
          parsed = { tool_calls: calls };
        } catch {
          log.warn({ raw: match[0].slice(0, 200) }, 'JSON tool-call fallback: parse failed — skipping');
          continue;
        }
      }

      const calls = Array.isArray(parsed['tool_calls']) ? (parsed['tool_calls'] as unknown[]) : [];
      for (const call of calls) {
        if (!call || typeof call !== 'object') continue;
        const c = call as Record<string, unknown>;
        const name = typeof c['name'] === 'string' ? c['name'] : '';
        if (!name) {
          log.warn({ call }, 'JSON tool-call fallback: missing "name" field — skipping');
          continue;
        }

        // SECURITY: name must be in live registry.
        if (!knownToolNames.has(name)) {
          log.warn({ name }, 'JSON tool-call fallback: tool name not in registry — DROPPED (injection guard)');
          continue;
        }

        const args = (c['arguments'] ?? c['args'] ?? c['input'] ?? {}) as Record<string, unknown>;
        const id = `json-tc-${Date.now()}-${results.length}`;
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
  async getSystemPrompt(options: Partial<SystemPromptOptions> = {}): Promise<string> {
    return assembleSystemPrompt({
      persona: this.currentPersona,
      mood: this.currentMood,
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

  async call(request: BrainRequest): Promise<BrainResponse> {
    await this.providersReady;

    if (!request.messages || request.messages.length === 0) {
      throw new LLMError('BrainRequest.messages must be non-empty', 'llm_invalid_request');
    }

    // Extract tool names/descriptions to include in the system prompt so the LLM
    // knows what tools are available and when to use them.
    const toolSummaries = (request.tools ?? []).map((t) => {
      const raw = t as Record<string, unknown>;
      const fn = raw['function'] as Record<string, unknown> | undefined;
      return {
        name: (fn?.['name'] as string | undefined) ?? (raw['name'] as string | undefined) ?? '',
        description: (fn?.['description'] as string | undefined) ?? (raw['description'] as string | undefined) ?? '',
      };
    }).filter((s) => s.name);

    // RAG: retrieve relevant memory context from the last user message.
    // Failures are fully swallowed — never let RAG break the main call path.
    let ragMemoryContext: string | undefined;
    if (this.ragEngine) {
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

    let systemPrompt = await this.getSystemPrompt({
      heartbeat: false,
      tools: toolSummaries.length > 0 ? toolSummaries : undefined,
      ...(ragMemoryContext ? { memoryContext: ragMemoryContext } : {}),
    });

    // v5: Tool-use instruction — softened for Ollama models which tend to
    // return tool_calls for conversational queries when the instruction is
    // too aggressive. We still encourage tool use for actions but allow
    // direct text responses for conversation.
    if (toolSummaries.length > 0) {
      systemPrompt += `\n\n## TOOL-USE INSTRUCTION
You have ${toolSummaries.length} tools available. When the user asks you to DO something concrete (check, search, navigate, read, write, screenshot, execute, etc.), call the appropriate tool. For casual conversation, greetings, opinions, or general questions, respond with normal text — do NOT call tools.`;
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
        return await this._callSingleModel(profile, request, systemPrompt, temperature, maxTokens);
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
            const response = await this._callSingleModel(profile, request, systemPrompt, temperature, maxTokens);
            return {
              model: response.model,
              content: response.content ?? '',
              toolCalls: response.toolCalls ?? [],
              latencyMs: 0,
              usage: response.usage,
            };
          },
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
        };
      } catch (consensusErr) {
        log.warn({ err: consensusErr }, 'Consensus call failed — falling back to sequential failover');
        // Record errors for all cloud models that participated
        for (const profile of cloudProfiles) {
          this.failover.recordError(profile.id, 'format');
        }
      }
    }

    // -------------------------------------------------------------------------
    // Phase 2: Sequential fallback through remaining models.
    // -------------------------------------------------------------------------
    for (let attempt = 0; attempt < MAX_FAILOVER_ATTEMPTS; attempt++) {
      const profile = this.failover.getNextProfile();

      if (!profile) {
        throw new LLMError('All model profiles are exhausted or in cooldown', 'llm_all_profiles_exhausted', { attempt });
      }

      try {
        const result = await this._callSingleModel(profile, request, systemPrompt, temperature, maxTokens);
        return result;
      } catch (err) {
        lastError = err;
        const { status, body, retryAfterMs } = Brain.extractErrorDetails(err);
        const category = this.failover.categorizeError(status, body);
        log.warn({ attempt, profileId: profile.id, status, category, retryAfterMs }, 'LLM call failed — trying next profile');
        this.failover.recordError(profile.id, category, { retryAfterMs });
      }
    }

    throw new LLMError('All failover attempts failed', 'llm_all_attempts_failed', {
      attempts: MAX_FAILOVER_ATTEMPTS,
      lastError: String(lastError),
    });
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

    for (let attempt = 0; attempt < MAX_FAILOVER_ATTEMPTS; attempt++) {
      const profile = this.failover.getNextProfile();

      if (!profile) {
        throw new LLMError('All model profiles are exhausted or in cooldown', 'llm_all_profiles_exhausted', { attempt });
      }

      const modelId = profile.id;
      log.info({ attempt, modelId }, 'Streaming LLM call starting');

      try {
        const modelHandle = getModel(modelId);

        const streamParams: Record<string, unknown> = {
          model: modelHandle,
          system: systemPrompt,
          messages: toSDKMessages(request.messages),
          temperature,
          maxOutputTokens: maxTokens,
        };

        if (request.tools && request.tools.length > 0) {
          streamParams.tools = Object.fromEntries(
            request.tools.map((t) => {
              const raw = t as Record<string, unknown>;
              const fn = raw['function'] as Record<string, unknown> | undefined;
              const name = (fn?.['name'] as string | undefined) ?? (raw['name'] as string | undefined) ?? '';
              const desc = (fn?.['description'] as string | undefined) ?? (raw['description'] as string | undefined) ?? '';
              const params = (fn?.['parameters'] as Record<string, unknown> | undefined) ?? (raw['parameters'] as Record<string, unknown> | undefined) ?? {};
              return [name, aiTool({
                description: desc,
                inputSchema: jsonSchema(params),
              })];
            })
          );
        }

        const result = streamText(streamParams as Parameters<typeof streamText>[0]);

        for await (const chunk of result.textStream) {
          yield chunk;
        }

        // result is StreamTextResult (not a Promise); usage is PromiseLike<LanguageModelUsage>.
        const finalUsage = await result.usage;
        const usage = buildTokenUsage(modelId, finalUsage);

        this.failover.recordSuccess(profile.id);
        log.info({ modelId, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }, 'Streaming call completed');
        return;

      } catch (err) {
        lastError = err;
        const { status, body, retryAfterMs } = Brain.extractErrorDetails(err);
        const category = this.failover.categorizeError(status, body);

        log.warn({ attempt, modelId, status, category, retryAfterMs, err }, 'Streaming LLM call failed — trying next profile');
        this.failover.recordError(profile.id, category, { retryAfterMs });
      }
    }

    throw new LLMError('All streaming failover attempts failed', 'llm_all_attempts_failed', {
      attempts: MAX_FAILOVER_ATTEMPTS,
      lastError: String(lastError),
    });
  }

  /**
   * Execute a single LLM call for a given profile.
   * Handles model resolution, tool attachment, refusal detection, and text fallback.
   * Records success/error on the failover tracker.
   */
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

    const callParams: Record<string, unknown> = {
      system: systemPrompt,
      messages: toSDKMessages(request.messages),
      temperature,
      maxOutputTokens: maxTokens,
    };
    if (request.tools && request.tools.length > 0) {
      callParams.tools = Object.fromEntries(
        request.tools.map((t: any) => {
          const name = t.function?.name ?? t.name;
          const desc = t.function?.description ?? t.description;
          const params = t.function?.parameters ?? t.parameters;
          return [name, aiTool({
            description: desc,
            inputSchema: jsonSchema(params),
          })];
        })
      );
    }
    // A4: obtain the completion through the auth-profile rotation path — rotates
    // across multiple API keys for this provider on rate-limit/auth/billing errors
    // before model-level failover gives up. Sets callParams.model to the chosen
    // key's handle; the single env-key path runs unchanged when <2 keys exist.
    let result = await this._generateWithKeyRotation(profile, callParams);

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
      const noToolParams = { ...callParams };
      delete noToolParams.tools;
      // Slightly raise temperature for the retry to avoid deterministic empty loops
      noToolParams.temperature = Math.min(temperature + 0.1, 1.0);
      result = await generateText(noToolParams as Parameters<typeof generateText>[0]);
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

    const usage = buildTokenUsage(modelId, result.usage);
    const toolCalls = this.extractToolCalls(result.toolCalls ?? []);
    const finishReason = (result.finishReason ?? 'stop') as BrainResponse['finishReason'];

    // Fallback: parse XML or JSON text tool calls if structured output is empty.
    let finalToolCalls = toolCalls;
    let finalContent = extractedText;
    let finalFinishReason = finishReason;

    if (
      process.env['SUDO_TEXT_TOOLCALL_FALLBACK_DISABLE'] !== '1' &&
      finalToolCalls.length === 0 &&
      finishReason !== 'tool-calls' &&
      typeof result.text === 'string'
    ) {
      if (result.text.includes('<tool_call>')) {
        finalToolCalls = this._parseTextToolCalls(result.text);
        if (finalToolCalls.length > 0) {
          finalContent = result.text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
        }
      } else if (result.text.includes('"tool_calls"')) {
        finalToolCalls = this._parseJsonToolCalls(result.text);
        if (finalToolCalls.length > 0) {
          finalContent = result.text.replace(/\{[\s\S]*?"tool_calls"[\s\S]*?\}/g, '').trim();
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

    this.failover.recordSuccess(profile.id);
    log.info({ modelId, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, estimatedCost: usage.estimatedCost, finishReason: finalFinishReason }, 'LLM call succeeded');

    return { content: finalContent, toolCalls: finalToolCalls, usage, model: modelId, finishReason: finalFinishReason };
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
  ): { model: string; reason: string; complexity: number } | null {
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
        return { model: premiumModel, reason: `reasoning-tier:${request.reasoningLevel}`, complexity };
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
        return { model: decision.model, reason: decision.reason, complexity };
      }
    }

    // A3: explicit "auto" → let the zero-cost keyword model-router pick a
    // category-appropriate model (coding/analysis/research/fast). Inert while the
    // category models all resolve to the primary; activates once they differ.
    if (request.model === 'auto') {
      const routed = routeModel('', userText);
      if (routed.model && routed.model !== this.primaryModel) {
        return { model: routed.model, reason: `category-route:${routed.category}`, complexity };
      }
    }

    return null;
  }

  /**
   * Run generateText for a profile through the auth-profile rotation path.
   *
   * When 2+ API keys are configured for the provider (e.g. XAI_API_KEY_1,
   * XAI_API_KEY_2), each rate-limit / auth / billing failure rotates to the next
   * key and retries the SAME model before the caller's model-level failover gives
   * up. Non-key errors (overload, timeout, format, …) propagate immediately so the
   * model-failover loop can switch models. With fewer than 2 keys it falls back to
   * the single env-key path — byte-for-byte the previous behavior.
   *
   * Sets `callParams.model` to the chosen key's handle as a side effect, so the
   * downstream tool-empty retry reuses the same working key.
   */
  private async _generateWithKeyRotation(
    profile: ModelProfile,
    callParams: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<typeof generateText>>> {
    const provider = profile.provider;
    const keyCount = this._ensureRotationKeys(provider);

    // Single-key / env path — unchanged behavior.
    if (keyCount < 2) {
      callParams.model = getModel(profile.id);
      return generateText(callParams as Parameters<typeof generateText>[0]);
    }

    let lastErr: unknown;
    for (let k = 0; k < keyCount; k++) {
      const key = this.authRotation.getNextKey(provider);
      if (!key) break;
      try {
        callParams.model = await getModelWithKey(profile.id, key.apiKey);
        const res = await generateText(callParams as Parameters<typeof generateText>[0]);
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
    const asAny = err as Record<string, unknown>;

    // Direct status or statusCode on the error object itself.
    let status = (asAny['status'] as number | undefined) ?? (asAny['statusCode'] as number | undefined);
    let body = (asAny['message'] as string | undefined);

    // If this is a Vercel AI SDK RetryError, dig into lastError or errors array
    // to find the APICallError with the real HTTP status code.
    if (!status || status === 500) {
      const lastError = asAny['lastError'] as Record<string, unknown> | undefined;
      const errors = asAny['errors'] as unknown[] | undefined;

      // Try lastError first (most recent failure).
      if (lastError && typeof lastError === 'object') {
        const innerStatus = (lastError['statusCode'] as number | undefined) ?? (lastError['status'] as number | undefined);
        if (innerStatus) {
          status = innerStatus;
          body = (lastError['responseBody'] as string | undefined) ?? (lastError['message'] as string | undefined) ?? body;
        }
      }

      // If still no status, scan the errors array for any APICallError.
      if ((!status || status === 500) && Array.isArray(errors)) {
        for (let i = errors.length - 1; i >= 0; i--) {
          const inner = errors[i] as Record<string, unknown> | undefined;
          if (inner && typeof inner === 'object') {
            const innerStatus = (inner['statusCode'] as number | undefined) ?? (inner['status'] as number | undefined);
            if (innerStatus && innerStatus !== 500) {
              status = innerStatus;
              body = (inner['responseBody'] as string | undefined) ?? (inner['message'] as string | undefined) ?? body;
              break;
            }
          }
        }
      }
    }

    return { status: status ?? 500, body, retryAfterMs: Brain._extractRetryAfter(err) };
  }

  /**
   * Extract a Retry-After hint (in ms) from an error's response headers, digging
   * through the SDK's RetryError wrapping (lastError / errors[]). Returns undefined
   * when no usable Retry-After is present.
   */
  private static _extractRetryAfter(err: unknown): number | undefined {
    const top = err as Record<string, unknown> | null;
    if (!top || typeof top !== 'object') return undefined;

    const candidates: Record<string, unknown>[] = [top];
    const lastError = top['lastError'] as Record<string, unknown> | undefined;
    if (lastError && typeof lastError === 'object') candidates.push(lastError);
    const errors = top['errors'] as unknown[] | undefined;
    if (Array.isArray(errors)) {
      for (const e of errors) {
        if (e && typeof e === 'object') candidates.push(e as Record<string, unknown>);
      }
    }

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
