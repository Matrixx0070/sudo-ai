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
import { getModel, initProviders } from './providers.js';
import { assembleSystemPrompt } from './system-prompt.js';
import { getPersonaTemperature } from './personas.js';
import { getMoodTemperatureDelta } from './moods.js';
import { buildTokenUsage } from './costs.js';
import { isGrokRefusal } from './grok-refusal-detect.js';
import { routeModel, isAutoModel } from './model-router.js';
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
} from './types.js';
import type { SudoConfig } from '../config/types.js';
import { ToolRegistry } from '../tools/registry.js';

const log = createLogger('brain');

/** Maximum number of provider failover attempts per call. */
const MAX_FAILOVER_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Concatenated-JSON splitter — handles LLMs that batch multiple tool call
// argument objects into a single arguments string, e.g. grok-3 via sudoapi.
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

  /**
   * @param config - Full SudoConfig (or null for env-only mode).
   */
  private providersReady: Promise<void>;

  constructor(config: unknown) {
    this.config = config as SudoConfig | null;
    const modelIds = this.buildModelList();
    this.failover = new ModelFailover(modelIds);
    // Auto-init providers on construction (async, awaited on first call)
    this.providersReady = initProviders();
    log.info({ modelCount: modelIds.length, models: modelIds }, 'Brain initialised');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildModelList(): string[] {
    const models: string[] = [];

    if (this.config?.models?.primary) {
      for (const entry of this.config.models.primary) {
        if (entry.id) models.push(entry.id);
      }
    }

    if (this.config?.models?.fallback?.id) {
      const fb = this.config.models.fallback.id;
      if (!models.includes(fb)) models.push(fb);
    }

    if (models.length === 0) {
      models.push(DEFAULT_MODEL, FALLBACK_MODEL);
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
      // providers (e.g. grok-3 via sudoapi) — parse it if so.
      let rawArgField: unknown = raw['input'] ?? raw['args'] ?? {};

      // If the field is a string, try to parse it.  Some OpenAI-compatible
      // providers (including grok-3 via sudoapi) return the raw JSON string
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

    // Try Claude CLI first if enabled (uses Claude Max subscription via CLI)
    // Only for non-tool conversations — Claude CLI can't call tools
    if (process.env['CLAUDE_CLI_ENABLED'] === 'true' && !request.tools?.length) {
      try {
        const { callClaudeCLI } = await import('./claude-cli-provider.js');

        // Build full prompt with system context + conversation history
        const systemPrompt = await this.getSystemPrompt({ heartbeat: false });
        const conversationParts: string[] = [];

        // Add system prompt (truncated to keep CLI fast)
        const systemTruncated = systemPrompt.length > 4000
          ? systemPrompt.substring(0, 4000) + '\n...(system prompt truncated)'
          : systemPrompt;
        conversationParts.push(systemTruncated);
        conversationParts.push('');

        // Add recent conversation history (last 6 messages max)
        const recentMessages = request.messages.slice(-6);
        for (const msg of recentMessages) {
          const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
          conversationParts.push(`${role}: ${msg.content}`);
        }

        const fullPrompt = conversationParts.join('\n');
        const result = await callClaudeCLI(fullPrompt, { timeout: 90000 });

        if (result.success && result.content) {
          log.info({ model: 'claude-cli', durationMs: result.durationMs, chars: result.content.length }, 'Claude CLI call succeeded');
          return {
            content: result.content,
            model: 'claude-cli',
            toolCalls: [],
            finishReason: 'stop' as const,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
          };
        }
      } catch (cliErr) {
        log.debug({ err: String(cliErr) }, 'Claude CLI failed — falling back to API providers');
      }
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

    // v5: Add strong tool-use instruction when tools are available
    // Without this, the model generates text instead of calling tools
    if (toolSummaries.length > 0) {
      systemPrompt += `\n\n## CRITICAL TOOL-USE INSTRUCTION
You have ${toolSummaries.length} tools available. When the user asks you to DO something (check, search, navigate, read, write, screenshot, execute, etc.), you MUST call the appropriate tool. Do NOT describe what you would do — CALL THE TOOL. Do NOT say "I would use..." — USE IT. Return tool_calls, not text. Only respond with text AFTER you have executed the tools and have real results to report.`;
    }
    const temperature = this.resolveTemperature(request);
    const maxTokens = this.resolveMaxTokens(request);
    let lastError: unknown;

    // -------------------------------------------------------------------------
    // Phase 1: Race all available cloud models in parallel (fastest wins).
    // Wait for ALL to settle, then pick the first successful one with content.
    // This avoids returning empty responses from a "fast" model that failed
    // silently (Ollama sometimes returns finishReason:stop with zero tokens).
    // -------------------------------------------------------------------------
    const cloudProfiles = this.failover.getCloudProfiles();
    if (cloudProfiles.length > 0) {
      log.info({ cloudCount: cloudProfiles.length, models: cloudProfiles.map(p => p.id) }, 'Racing cloud models in parallel');
      const cloudPromises = cloudProfiles.map(profile =>
        this._callSingleModel(profile, request, systemPrompt, temperature, maxTokens)
          .then(result => ({ success: true as const, result, profile }))
          .catch(err => ({ success: false as const, err, profile }))
      );

      const cloudResults = await Promise.allSettled(cloudPromises);
      for (const settled of cloudResults) {
        if (settled.status === 'fulfilled' && settled.value.success) {
          const result = settled.value.result;
          // Reject empty responses — they mean the model failed silently.
          if (result.content?.trim().length > 0 || result.toolCalls?.length > 0) {
            log.info({ modelId: result.model }, 'Cloud model race winner');
            return result;
          }
          log.warn({ modelId: result.model }, 'Cloud model returned empty content — treating as failure');
          this.failover.recordError(settled.value.profile.id, 'format');
        }
      }
      log.warn('All cloud models failed or returned empty — falling back to local models');
    }

    // -------------------------------------------------------------------------
    // Phase 2: Sequential fallback through local models (and any remaining).
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
        const { status, body } = Brain.extractErrorDetails(err);
        const category = this.failover.categorizeError(status, body);
        log.warn({ attempt, profileId: profile.id, status, category }, 'LLM call failed — trying next profile');
        this.failover.recordError(profile.id, category);
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

      const modelId = (request.model && request.model.includes('/')) ? request.model : profile.id;
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
        const { status, body } = Brain.extractErrorDetails(err);
        const category = this.failover.categorizeError(status, body);

        log.warn({ attempt, modelId, status, category, err }, 'Streaming LLM call failed — trying next profile');
        this.failover.recordError(profile.id, category);
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
    if (isAutoModel(request.model)) {
      const lastUser = [...request.messages].reverse().find(m => m.role === 'user');
      const decision = routeModel('', lastUser?.content ?? '');
      modelId = decision.model;
    } else {
      modelId = (request.model && request.model.includes('/')) ? request.model : profile.id;
    }

    const modelHandle = getModel(modelId);

    const callParams: Record<string, unknown> = {
      model: modelHandle,
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
    let result = await generateText(callParams as Parameters<typeof generateText>[0]);

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

    const usage = buildTokenUsage(modelId, result.usage);
    const toolCalls = this.extractToolCalls(result.toolCalls ?? []);
    const finishReason = (result.finishReason ?? 'stop') as BrainResponse['finishReason'];

    // Fallback: parse XML or JSON text tool calls if structured output is empty.
    let finalToolCalls = toolCalls;
    let finalContent = result.text ?? '';
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
  private static extractErrorDetails(err: unknown): { status: number; body: string | undefined } {
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

    return { status: status ?? 500, body };
  }
}
