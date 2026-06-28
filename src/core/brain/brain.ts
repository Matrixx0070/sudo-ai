/**
 * Brain — the central intelligence core of SUDO-AI v3.
 *
 * Wraps the Vercel AI SDK with multi-model failover, persona/mood management,
 * system prompt assembly, token cost tracking, and streaming support.
 */

import { generateText, streamText, tool as aiTool, jsonSchema } from 'ai';
import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { recordPromptCacheUsageFromProviderMetadata, extractPromptCacheTokens } from '../shared/prompt-cache-telemetry.js';
import { LLMError } from '../shared/errors.js';
import { DEFAULT_MODEL, FALLBACK_MODEL, MAX_AGENT_ITERATIONS } from '../shared/constants.js';
import { ModelFailover } from './failover.js';
import {
  type BrainStrategy,
  type BrainCallOpts,
  DEFAULT_BRAIN_STRATEGY,
  resolveEffectiveStrategy,
} from './brain-strategy.js';
import { runDebate } from './brain-debate.js';
import { runTreeSearch } from './brain-tree-search.js';
import { getModel, getModelWithKey, initProviders } from './providers.js';
import { clampMaxTokensToModel } from './thinking-inject.js';
import { isCustomProvider } from './custom-providers.js';
import { assembleSystemPrompt } from './system-prompt.js';
import { sortToolEntries, isCacheBreakpointsEnabled, isAnthropicModelId, buildCachedSystemMessages, markLastToolForCache } from './prompt-cache-discipline.js';
import { warnOnDuplicateToolNames } from './tool-name-collision.js';
import { getPersonaTemperature } from './personas.js';
import { getMoodTemperatureDelta } from './moods.js';
import { buildTokenUsage } from './costs.js';
import { isGrokRefusal } from './grok-refusal-detect.js';
import { getCostTracker } from '../billing/cost-tracker.js';
import { queryAllModelsConsensus, type ConsensusOptions } from './model-consensus.js';
import { DispatchRouter } from './dispatch-router.js';
import { estimateTaskComplexity, pickOptimalModel } from './cost-optimizer.js';
import { routeModel } from './model-router.js';
import { AuthProfileRotation } from './auth-profile-rotation.js';
import type { AuthErrorCategory } from './auth-profile-rotation.js';
import { describeRouting } from './routing-trace.js';
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

const log = createLogger('brain');

/**
 * Per-attempt backoff cap (ms) for failover when a provider is overloaded /
 * transient / timing out. Raised 5s → 15s and tunable via
 * SUDO_FAILOVER_BACKOFF_CAP_MS so a multi-second-to-minute cloud incident can
 * be ridden out instead of immediately surfacing "All failover attempts
 * failed". Clamped to [1s, 60s].
 */
export const FAILOVER_BACKOFF_CAP_MS = Math.min(
  60_000,
  Math.max(1_000, Number(process.env['SUDO_FAILOVER_BACKOFF_CAP_MS']) || 15_000),
);

/**
 * Backoff between sequential failover attempts when the previous profile
 * failed with a transient/overloaded category. Without this, the entire
 * chain fires in <2ms — a single anthropic blip 500s opus, sonnet, and
 * any same-window upstream simultaneously (observed live 2026-06-17 02:40).
 * If the upstream sent a retry-after header, honour it (capped). Otherwise
 * exponential: 250ms × 2^attempt, capped at FAILOVER_BACKOFF_CAP_MS.
 *
 * Kill-switch: SUDO_FAILOVER_BACKOFF_DISABLE=1 restores the zero-wait
 * burst (default off — always wait).
 */
export function failoverBackoffMs(category: string, attempt: number, retryAfterMs?: number): number {
  if (process.env['SUDO_FAILOVER_BACKOFF_DISABLE'] === '1') return 0;
  if (category !== 'overloaded' && category !== 'transient' && category !== 'timeout') return 0;
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    return Math.min(retryAfterMs, FAILOVER_BACKOFF_CAP_MS);
  }
  // Guard against a NaN/undefined/huge attempt counter: Math.pow(2, NaN) = NaN,
  // Math.min(cap, NaN) = NaN, and setTimeout(fn, NaN) fires immediately —
  // re-creating the zero-wait thundering-herd this backoff exists to prevent.
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const exp = Math.min(safeAttempt, 20);
  return Math.min(FAILOVER_BACKOFF_CAP_MS, 250 * Math.pow(2, exp));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Maximum number of provider failover attempts per call. Raised 6 → 10 and
 * tunable via SUDO_FAILOVER_MAX_ATTEMPTS (clamped [1, 30]). Combined with the
 * 15s FAILOVER_BACKOFF_CAP_MS, a fully-overloaded chain now rides out ~60-75s
 * before surfacing an error (was ~9s) — per the operator's request to keep
 * retrying past 60s on a total upstream outage.
 *
 * Trade-off: when EVERY provider is down, a single reply can now take up to
 * ~75s instead of failing fast. Normal operation is unaffected — backoff only
 * applies to overloaded/transient/timeout categories, which are rare.
 */
export const MAX_FAILOVER_ATTEMPTS = Math.min(
  30,
  Math.max(1, Number(process.env['SUDO_FAILOVER_MAX_ATTEMPTS']) || 10),
);

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
  let objectStart = -1; // sentinel: -1 = not currently inside a top-level object

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
      if (depth < 0) {
        // Unbalanced closing brace — input is corrupt. A stale objectStart from
        // a prior segment would slice the wrong bytes, so abort rather than
        // emit garbage that could drive tool dispatch with wrong arguments.
        log.warn({ at: i }, 'splitConcatenatedJsonObjects: unbalanced closing brace — aborting parse');
        return [];
      }
      if (depth === 0 && objectStart >= 0) {
        const segment = trimmed.slice(objectStart, i + 1);
        objectStart = -1;
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

  if (depth !== 0) {
    // Trailing object truncated mid-stream (depth never returned to 0). Nothing
    // partial was pushed (we only push on depth===0), but surface it so callers
    // can tell "no tool calls" from "tool calls truncated".
    log.warn({ depth }, 'splitConcatenatedJsonObjects: truncated trailing object — ignored');
  }

  return results;
}

/**
 * Scan arbitrary text for ALL balanced top-level JSON objects, returning each
 * `{...}` substring. Unlike splitConcatenatedJsonObjects this does NOT require
 * the text to start with `{` — it locates objects embedded anywhere (e.g. an
 * LLM that wraps a `{"tool_calls":[...]}` payload in prose). String/escape
 * aware, O(n), no regex backtracking.
 */
function findBalancedJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let objectStart = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\' && inString) { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === '}') {
      if (depth === 0) continue; // stray closing brace outside any object — ignore
      depth--;
      if (depth === 0 && objectStart >= 0) {
        out.push(text.slice(objectStart, i + 1));
        objectStart = -1;
      }
    }
  }

  return out;
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
/**
 * Opt-in (SUDO_FOLD_SYSTEM_MESSAGES=1). `toSDKMessages` drops every role:'system'
 * message from request.messages (the SDK requires system content via the `system`
 * param, not the array). That silently discards ALL in-loop guidance injected as
 * system messages — auto-plan PLAN, compaction/session-fork summaries, safety
 * warnings, routing hints, etc. — so the model never sees them. When this flag is
 * on, their content is FOLDED into the `system` param instead, so it actually
 * reaches the model. Default OFF: flipping it delivers many previously-inert
 * injections at once — a real behavior + token change — so measure before enabling.
 */
export function readFoldSystemEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_FOLD_SYSTEM_MESSAGES'] === '1';
}

/** Concatenate non-empty role:'system' message contents, in order (for folding). */
export function extractSystemMessageContent(messages: BrainMessage[]): string {
  return messages
    .filter((m) => m.role === 'system' && typeof m.content === 'string' && m.content.trim().length > 0)
    .map((m) => m.content)
    .join('\n\n');
}

/**
 * The effective system prompt: the base persona `systemPrompt` with any
 * request-array system messages appended, when folding is enabled. Pure +
 * exported for tests. Disabled or no system messages → returns `systemPrompt`
 * unchanged (byte-identical to prior behavior). NOTE: when folding AND Anthropic
 * prompt-caching are both on, the per-turn folded suffix reduces cache hits on
 * the system prefix — acceptable for this opt-in flag; prod (ollama) is uncached.
 */
export function buildEffectiveSystemPrompt(
  systemPrompt: string,
  messages: BrainMessage[],
  enabled: boolean = readFoldSystemEnabled(),
): string {
  if (!enabled) return systemPrompt;
  const folded = extractSystemMessageContent(messages);
  return folded.length > 0 ? `${systemPrompt}\n\n${folded}` : systemPrompt;
}

/**
 * Cache-safe fold for the Anthropic prompt-cache path: returns the folded
 * content as a SEPARATE, uncached leading system message (no cache_control) to
 * sit AFTER `buildCachedSystemMessages(systemPrompt)`. This keeps the cached
 * persona prefix byte-identical turn to turn (cache hits preserved); the
 * per-turn folded content is simply uncached input — which it must be, since
 * new dynamic content can never be cached. Empty / disabled → [] (no-op).
 */
export function buildFoldedSystemMessages(
  messages: BrainMessage[],
  enabled: boolean = readFoldSystemEnabled(),
): Array<{ role: 'system'; content: string }> {
  if (!enabled) return [];
  const folded = extractSystemMessageContent(messages);
  return folded.length > 0 ? [{ role: 'system', content: folded }] : [];
}

function toSDKMessages(messages: BrainMessage[]): unknown[] {
  return messages
    .filter((msg) => {
      // System messages are handled via the 'system' param of generateText.
      // Including them in the messages array causes SDK schema validation errors.
      if (msg.role === 'system') {
        // Expected + handled, not an error: system content belongs in the
        // `system` param, and with SUDO_FOLD_SYSTEM_MESSAGES=1 it's folded in
        // (no loss). Routine → debug. (Was 90+/run of WARN noise for a by-design
        // drop — the single highest-frequency warning in the daemon logs.)
        log.debug(
          { contentPreview: String(msg.content ?? '').slice(0, 80) },
          'system-role message routed out of request.messages array (handled via system prompt / folding)',
        );
        return false;
      }
      return true;
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
        let callId = msg.toolCallId;
        if (!callId) {
          // A missing toolCallId from upstream is a bug worth surfacing. Use a
          // collision-free UUID (Date.now() collides for two tool messages in
          // the same ms, cross-wiring tool results back to the wrong call).
          callId = `fallback_${randomUUID()}`;
          log.warn({ toolName: msg.toolName }, 'tool message missing toolCallId — synthesised fallback id');
        }
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

/**
 * Resolve a /model switch target against the configured failover chain.
 * Accepts the full "provider/model-id" ref or the bare model id, both
 * case-insensitive. Returns the canonical configured ref, or null when the
 * target is not configured (switching to arbitrary unconfigured models would
 * bypass the failover chain and provider key setup).
 */
export function resolveModelSwitch(configured: string[], target: string): string | null {
  const t = target.trim().toLowerCase();
  if (!t) return null;
  return (
    configured.find((m) => m.toLowerCase() === t) ??
    configured.find((m) => m.toLowerCase().split('/').pop() === t) ??
    null
  );
}

/** Minimal interface required from a RAG engine — avoids importing RAGEngine directly. */
interface RAGEngineInterface {
  retrieveContext(query: string, maxChunks?: number): Promise<string>;
}

/**
 * The subset of a resolved generateText result that `_callSingleModel` consumes.
 * A full generateText result is structurally assignable to this; the streaming
 * path (`_completeOnce` for claude-oauth) reconstructs it from streamText's
 * aggregate promises. `reasoning`/`providerMetadata` stay `unknown` because the
 * downstream code already accesses them through casts and tolerates absence.
 */
type BrainCompletion = {
  text: Awaited<ReturnType<typeof generateText>>['text'];
  toolCalls: Awaited<ReturnType<typeof generateText>>['toolCalls'];
  usage: Awaited<ReturnType<typeof generateText>>['usage'];
  finishReason: Awaited<ReturnType<typeof generateText>>['finishReason'];
  reasoning: unknown;
  reasoningText: string | undefined;
  providerMetadata: unknown;
};

/** Core LLM interface with failover, persona, and mood management. */
export class Brain {
  private readonly failover: ModelFailover;
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
    this.configuredModels = modelIds.length > 0 ? modelIds : [DEFAULT_MODEL];
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
    await this.providersReady;

    if (!request.messages || request.messages.length === 0) {
      throw new LLMError('BrainRequest.messages must be non-empty', 'llm_invalid_request');
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
      return runDebate(this, request);
    }
    if (effectiveStrategy === 'tree-search') {
      // Forward only the tree-search-relevant opts. The verifier opt is
      // ignored on `single` and `debate` by design — debate doesn't
      // candidate-score, and single has nothing to reroll against.
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

    // Reasoning lens: inject an analytical framework when the task matches
    // (root-cause / hypothesis / decision / adversarial / strategic). Scoped by
    // keyword, capped, and kill-switchable (SUDO_REASONING_LENS_DISABLE=1) — inert
    // for plain turns. See reasoning-lens.ts.
    const lensUserText = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const lens = selectLenses(lensUserText);
    if (lens) {
      log.debug({ lensIds: lens.ids }, 'Reasoning lenses injected into system prompt');
    }

    let systemPrompt = await this.getSystemPrompt({
      heartbeat: false,
      tools: toolSummaries.length > 0 ? toolSummaries : undefined,
      ...(ragMemoryContext ? { memoryContext: ragMemoryContext } : {}),
      ...(lens ? { reasoningLens: lens.text } : {}),
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
              const response = await this._callSingleModel(profile, request, systemPrompt, temperature, maxTokens);
              return {
                model: response.model,
                content: response.content ?? '',
                toolCalls: response.toolCalls ?? [],
                latencyMs: 0,
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
    for (let attempt = 0; attempt < MAX_FAILOVER_ATTEMPTS; attempt++) {
      const profile = this.failover.getNextProfile();

      if (!profile) {
        throw new LLMError('All model profiles are exhausted or in cooldown', 'llm_all_profiles_exhausted', { attempt });
      }

      try {
        const result = await this._callSingleModel(profile, request, systemPrompt, temperature, maxTokens);
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
        log.warn({ attempt, profileId: profile.id, status, category, retryAfterMs }, 'LLM call failed — trying next profile');
        this.failover.recordError(profile.id, category, { retryAfterMs });
        if (attempt < MAX_FAILOVER_ATTEMPTS - 1) {
          const waitMs = failoverBackoffMs(category, attempt, retryAfterMs);
          if (waitMs > 0) {
            log.info({ attempt, category, waitMs }, 'Failover backoff before next attempt');
            await sleep(waitMs);
          }
        }
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
      const _streamStartedAt = Date.now();
      log.info({ attempt, modelId }, 'Streaming LLM call starting');

      try {
        const modelHandle = getModel(modelId);

        // SUDO_PROMPT_CACHE=1 + Anthropic model: explicit cache_control breakpoints —
        // system prompt split at the dynamic boundary (stable part cached) and the
        // last sorted tool marked. Non-Anthropic paths are byte-identical to before.
        const cacheBreakpoints = isCacheBreakpointsEnabled() && isAnthropicModelId(modelId);

        // Fold dropped array system messages into the model input (opt-in;
        // cache-safe — see _callSingleModel). No-op when the flag is unset.
        const effectiveSystem = buildEffectiveSystemPrompt(systemPrompt, request.messages);
        if (readFoldSystemEnabled()) {
          const foldedChars = extractSystemMessageContent(request.messages).length;
          if (foldedChars > 0) {
            log.info({ foldedChars, approxTokens: Math.round(foldedChars / 4), cachePath: cacheBreakpoints, model: modelId, stream: true }, 'system-fold: in-loop guidance delivered to model');
          }
        }

        const streamParams: Record<string, unknown> = {
          model: modelHandle,
          messages: cacheBreakpoints
            ? [...buildCachedSystemMessages(systemPrompt), ...buildFoldedSystemMessages(request.messages), ...toSDKMessages(request.messages)]
            : toSDKMessages(request.messages),
          temperature,
          maxOutputTokens: clampMaxTokensToModel(modelId, maxTokens, { modelMax: process.env['SUDO_THINKING_MODEL_MAX'] }),
        };
        if (!cacheBreakpoints) {
          streamParams.system = effectiveSystem;
        }

        if (request.tools && request.tools.length > 0) {
          const toolEntries = request.tools.map((t): [string, object] => {
            const name = t.function?.name ?? '';
            const desc = t.function?.description ?? '';
            const params = t.function?.parameters ?? {};
            return [name, aiTool({
              description: desc,
              inputSchema: jsonSchema(params),
            })];
          });
          warnOnDuplicateToolNames(toolEntries);
          // SUDO_PROMPT_CACHE=1: deterministic tool order → byte-stable prefix for provider caches.
          let sortedEntries = sortToolEntries(toolEntries);
          if (cacheBreakpoints) {
            sortedEntries = markLastToolForCache(sortedEntries);
          }
          streamParams.tools = Object.fromEntries(sortedEntries);
        }

        // AI SDK v6: a provider error before/during streaming ends textStream
        // WITHOUT throwing (the real error goes to onError, not the iterator).
        // Capture it so an auth/rate-limit failure fails over instead of being
        // recorded as an empty, successful stream.
        let streamError: unknown;
        const result = streamText({
          ...(streamParams as Parameters<typeof streamText>[0]),
          onError: (e: { error: unknown }) => { streamError = e.error; },
        });

        let streamCompleted = false;
        let streamErrored = false;
        try {
          for await (const chunk of result.textStream) {
            yield chunk;
          }
          if (streamError) throw streamError;
          streamCompleted = true;
        } catch (err) {
          streamErrored = true;
          throw err;
        } finally {
          if (!streamCompleted && !streamErrored) {
            // The consumer broke out of the stream (generator return() at the
            // yield), so execution never reaches the post-loop bookkeeping
            // below. The model itself streamed fine: credit it, and detach the
            // abandoned usage promise — stream cancellation can reject it,
            // which would otherwise surface as an unhandled rejection.
            void Promise.resolve(result.usage).then(
              (u) => {
                const usage = buildTokenUsage(modelId, u);
                if (usage.completionTokens > 0) {
                  log.info({ modelId, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }, 'Streaming call ended early by consumer');
                }
              },
              () => { /* stream cancelled — usage unavailable */ },
            );
            this.failover.recordSuccess(profile.id);
          }
        }

        // result is StreamTextResult (not a Promise); usage is PromiseLike<LanguageModelUsage>.
        // A usage rejection after a fully-delivered stream must not poison the
        // failover record — or worse, propagate to the outer catch and retry-
        // stream a duplicate response. The model already served the text.
        let finalUsage: Awaited<typeof result.usage> | undefined;
        try {
          finalUsage = await result.usage;
        } catch (usageErr) {
          log.warn({ modelId, err: usageErr }, 'Usage unavailable after completed stream');
        }
        // Anthropic prompt-cache telemetry. providerMetadata is a PromiseLike on streamText;
        // await defensively so a cancelled-after-completion stream can't poison the success path.
        // Resolve it BEFORE building usage so the cost estimate can discount cached tokens.
        let cacheTokens = { create: 0, read: 0 };
        try {
          const meta = await (result as { providerMetadata?: PromiseLike<unknown> }).providerMetadata;
          cacheTokens = extractPromptCacheTokens(meta);
          recordPromptCacheUsageFromProviderMetadata(meta);
        } catch { /* providerMetadata may reject on cancelled streams — non-fatal */ }

        const usage = finalUsage
          ? buildTokenUsage(modelId, finalUsage, cacheTokens)
          : undefined;

        this.failover.recordSuccess(profile.id);
        this._recordBillingUsage(modelId, usage, cacheTokens, Date.now() - _streamStartedAt, true, request.source ?? 'llm');
        log.info({ modelId, promptTokens: usage?.promptTokens, completionTokens: usage?.completionTokens }, 'Streaming call completed');
        return;

      } catch (err) {
        lastError = err;
        const { status, body, retryAfterMs } = Brain.extractErrorDetails(err);
        const category = this.failover.categorizeError(status, body);

        log.warn({ attempt, modelId, status, category, retryAfterMs, err }, 'Streaming LLM call failed — trying next profile');
        this.failover.recordError(profile.id, category, { retryAfterMs });
        if (attempt < MAX_FAILOVER_ATTEMPTS - 1) {
          const waitMs = failoverBackoffMs(category, attempt, retryAfterMs);
          if (waitMs > 0) {
            log.info({ attempt, category, waitMs }, 'Streaming failover backoff before next attempt');
            await sleep(waitMs);
          }
        }
      }
    }

    throw new LLMError('All streaming failover attempts failed', 'llm_all_attempts_failed', {
      attempts: MAX_FAILOVER_ATTEMPTS,
      lastError: String(lastError),
    });
  }

  /**
   * Fire-and-forget billing record for one completed LLM call. Persists the
   * cache-aware cost + prompt-cache split to api_call_log so the cost-reporter /
   * insights dashboards show live, cache-discounted spend (previously the table
   * had no writer and the dashboard read $0). Never throws — cost tracking must
   * not break a call. Skipped under vitest (no test-DB pollution) and via the
   * SUDO_COST_TRACKING=0 kill-switch.
   */
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
    const effectiveSystem = buildEffectiveSystemPrompt(systemPrompt, request.messages);
    // Telemetry: exact size of the in-loop system guidance folded into the model
    // input this call (the per-turn token cost of SUDO_FOLD_SYSTEM_MESSAGES).
    if (readFoldSystemEnabled()) {
      const foldedChars = extractSystemMessageContent(request.messages).length;
      if (foldedChars > 0) {
        log.info({ foldedChars, approxTokens: Math.round(foldedChars / 4), cachePath: cacheBreakpoints, model: modelId }, 'system-fold: in-loop guidance delivered to model');
      }
    }

    const callParams: Record<string, unknown> = {
      messages: cacheBreakpoints
        ? [...buildCachedSystemMessages(systemPrompt), ...buildFoldedSystemMessages(request.messages), ...toSDKMessages(request.messages)]
        : toSDKMessages(request.messages),
      temperature,
      maxOutputTokens: clampMaxTokensToModel(modelId, maxTokens, { modelMax: process.env['SUDO_THINKING_MODEL_MAX'] }),
    };
    // Best-effort deterministic sampling — forwarded only when the caller pins a
    // seed; providers that don't support it ignore the field.
    if (request.seed !== undefined) callParams.seed = request.seed;
    if (!cacheBreakpoints) {
      callParams.system = effectiveSystem;
    }
    if (request.tools && request.tools.length > 0) {
      const toolEntries = request.tools.map((t: any): [string, object] => {
        const name = t.function?.name ?? t.name;
        const desc = t.function?.description ?? t.description;
        const params = t.function?.parameters ?? t.parameters;
        return [name, aiTool({
          description: desc,
          inputSchema: jsonSchema(params),
        })];
      });
      warnOnDuplicateToolNames(toolEntries);
      // SUDO_PROMPT_CACHE=1: deterministic tool order → byte-stable prefix for provider caches.
      let sortedEntries = sortToolEntries(toolEntries);
      if (cacheBreakpoints) {
        sortedEntries = markLastToolForCache(sortedEntries);
      }
      callParams.tools = Object.fromEntries(sortedEntries);
    }
    // A4: obtain the completion through the auth-profile rotation path — rotates
    // across multiple API keys for this provider on rate-limit/auth/billing errors
    // before model-level failover gives up. Sets callParams.model to the chosen
    // key's handle; the single env-key path runs unchanged when <2 keys exist.
    const _callStartedAt = Date.now();
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
      // When cacheBreakpoints=true the system prompt lives in callParams.messages
      // (leading system messages), not callParams.system — do not re-add a system key here.
      const noToolParams = { ...callParams };
      delete noToolParams.tools;
      // Slightly raise temperature for the retry to avoid deterministic empty loops
      noToolParams.temperature = Math.min(temperature + 0.1, 1.0);
      result = await this._completeOnce(profile.provider, noToolParams);
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
  ): Promise<BrainCompletion> {
    const provider = profile.provider;

    // Custom providers (gap #27) carry a single configured key and have no
    // rotation profiles — skip rotation entirely so numbered _API_KEY_N vars
    // for a custom name don't spin the loop with keys that never get used.
    if (isCustomProvider(provider)) {
      callParams.model = getModel(profile.id);
      return this._completeOnce(provider, callParams);
    }

    const keyCount = this._ensureRotationKeys(provider);

    // Single-key / env path — unchanged behavior.
    if (keyCount < 2) {
      callParams.model = getModel(profile.id);
      return this._completeOnce(provider, callParams);
    }

    let lastErr: unknown;
    for (let k = 0; k < keyCount; k++) {
      const key = this.authRotation.getNextKey(provider);
      if (!key) break;
      try {
        callParams.model = await getModelWithKey(profile.id, key.apiKey);
        const res = await this._completeOnce(provider, callParams);
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
   * Run one completion and return it in generateText's resolved shape.
   *
   * For `claude-oauth` this streams instead of buffering. A non-streaming
   * generateText holds the claude-oauth response headers until the whole
   * completion finishes, which trips the provider's fast-fail headers timer
   * (default 45s, providers.ts) on long Opus turns and surfaces as a false stall
   * — the exact trap PRs #277-#279 fixed in the coder tools (swarm/analyze/codex/
   * arsenal). The central brain.call() path had the same defect, and it sits on
   * the highest-frequency caller (consciousness/cognitive-stream every tick).
   * streamText sends `stream:true`, so Anthropic lands headers in ~1-2s, the
   * headers timer clears, and the body-idle guard (providers.ts) bounds a stall
   * mid-body; awaiting the aggregate promises drains the stream to the full
   * completion. Reasoning/providerMetadata are best-effort — a post-completion
   * rejection (e.g. a cancelled stream) must not fail an otherwise-served call,
   * mirroring stream()'s defensive handling.
   *
   * Every other provider has no headers timer, so it keeps the simpler buffered
   * generateText path byte-for-byte. Kill-switch SUDO_BRAIN_OAUTH_STREAM_DISABLE=1
   * forces the legacy generateText path for claude-oauth too.
   */
  private async _completeOnce(
    provider: string,
    callParams: Record<string, unknown>,
  ): Promise<BrainCompletion> {
    if (provider !== 'claude-oauth' || process.env['SUDO_BRAIN_OAUTH_STREAM_DISABLE'] === '1') {
      return generateText(callParams as Parameters<typeof generateText>[0]);
    }
    // AI SDK v6 streamText rejects the aggregate promises (result.text, …) with a
    // generic NoOutputGeneratedError that DROPS the underlying cause — no
    // statusCode, no responseBody. The real provider error (e.g. APICallError
    // 401) is delivered ONLY to onError. Capture it so failover classifies the
    // true status (auth/rate-limit/overloaded) instead of defaulting to 500
    // "overloaded" and re-hammering a dead credential. (Verified empirically:
    // 401 → aggregate throws NoOutputGeneratedError, onError gets APICallError.)
    let streamError: unknown;
    const result = streamText({
      ...(callParams as Parameters<typeof streamText>[0]),
      onError: (e: { error: unknown }) => { streamError = e.error; },
    });
    // Awaiting these aggregates consumes the stream (feeding the body-idle guard)
    // and resolves the same fields generateText returns. A rejection here is a
    // real call failure and propagates to the rotation/failover loop — prefer the
    // onError-captured provider error so its status survives.
    const [text, toolCalls, usage, finishReason] = await Promise.all([
      result.text,
      result.toolCalls,
      result.usage,
      result.finishReason,
    ]).catch((err: unknown): never => { throw streamError ?? err; });
    const reasoning: unknown = await Promise.resolve(result.reasoning).catch(() => undefined);
    const reasoningText: string | undefined = await Promise.resolve(result.reasoningText).catch(() => undefined);
    const providerMetadata: unknown = await Promise.resolve(result.providerMetadata).catch(() => undefined);
    return { text, toolCalls, usage, finishReason, reasoning, reasoningText, providerMetadata };
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
    const nodes: Record<string, unknown>[] = [];
    const seen = new Set<unknown>();
    const visit = (e: unknown, depth: number): void => {
      if (!e || typeof e !== 'object' || seen.has(e) || depth > 6) return;
      seen.add(e);
      const obj = e as Record<string, unknown>;
      nodes.push(obj);
      visit(obj['cause'], depth + 1);
      visit(obj['lastError'], depth + 1);
      const errs = obj['errors'];
      if (Array.isArray(errs)) for (const inner of errs) visit(inner, depth + 1);
    };
    visit(err, 0);

    // Prefer the most specific status: a concrete non-500 code from any node
    // wins over a missing/500 one. Keep the body from the node we trust.
    let status: number | undefined;
    let body: string | undefined;
    for (const obj of nodes) {
      const s = (obj['statusCode'] as number | undefined) ?? (obj['status'] as number | undefined);
      const b = (obj['responseBody'] as string | undefined) ?? (obj['message'] as string | undefined);
      if (typeof s === 'number' && (status === undefined || (status === 500 && s !== 500))) {
        status = s;
        if (b) body = b;
      }
      if (!body && b) body = b;
    }

    // Signature fallback: a streamed auth failure can surface as a status-less
    // (or 500-wrapped) error whose text still names the cause. Recover the real
    // status so failover parks the tier on the long AUTH cooldown instead of
    // re-hammering a dead credential every minute.
    if (status === undefined || status === 500) {
      const hay = nodes
        .map((o) => `${String(o['responseBody'] ?? '')} ${String(o['message'] ?? '')}`)
        .join(' ')
        .toLowerCase();
      if (/authentication_error|invalid bearer token|invalid[_ ]api[_ ]key|invalid x-api-key|invalid_grant|oauth token (?:expired|invalid)/.test(hay)) {
        status = 401;
      } else if (/permission_error/.test(hay)) {
        status = 403;
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
