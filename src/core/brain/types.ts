/**
 * Core type definitions for the Brain module.
 * Covers request/response shapes, model profiles, personas, and moods.
 */

import type { ErrorCategory } from '../shared/errors.js';
import type { RoutingTrace } from './routing-trace.js';

// Re-export for consumers that only import from brain.
export type { ErrorCategory };
export type { RoutingTrace };

// ---------------------------------------------------------------------------
// Persona & Mood discriminated unions
// ---------------------------------------------------------------------------

/** Active persona that shapes the agent's domain focus. */
export type PersonaType =
  | 'producer'
  | 'researcher'
  | 'marketer'
  | 'coder'
  | 'creative'
  | 'assistant'
  | 'pragmatic'
  | 'friendly';

/** Operational mood that modifies response style. */
export type MoodType =
  | 'focused'
  | 'analytical'
  | 'collaborative'
  | 'celebratory'
  | 'diagnostic';

// ---------------------------------------------------------------------------
// Message & tool-call shapes
// ---------------------------------------------------------------------------

/** A single tool call returned by the LLM. */
export interface ToolCallFromLLM {
  /** Provider-assigned unique ID for this call. */
  id: string;
  /** Registered tool name. */
  name: string;
  /** Parsed argument object. */
  arguments: Record<string, unknown>;
}

/** A single message in the conversation thread. */
export interface BrainMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present when role === 'assistant' and LLM invoked tools. */
  toolCalls?: ToolCallFromLLM[];
  /** Present when role === 'tool' — links back to the originating call. */
  toolCallId?: string;
  /** Name of the tool that produced this result (present when role === 'tool'). */
  toolName?: string;
  /**
   * Image attachments for multimodal models.
   * Based on Codex input_modalities: ['text', 'image'].
   * Only supported when the target model accepts image input.
   */
  images?: Array<{
    /** Whether the image data is a base64-encoded string or a remote URL. */
    type: 'base64' | 'url';
    /** Base64-encoded image content or the remote image URL. */
    data: string;
    /** MIME type of the image. Defaults to 'image/png' if omitted. */
    mediaType?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  }>;
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

/**
 * Reasoning depth control — maps to (temperature, maxTokens) presets.
 *
 * - low:   temp=0.3, maxTokens=1024   — fast, direct answers
 * - medium: temp=0.5, maxTokens=4096  — balanced (default)
 * - high:  temp=0.7, maxTokens=8192   — deeper thinking
 * - xhigh: temp=0.8, maxTokens=16384  — maximum reasoning effort
 */
export type ReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh';

/** Input parameters for a Brain LLM call. */
export interface BrainRequest {
  /** Ordered conversation messages (system excluded — Brain prepends it). */
  messages: BrainMessage[];
  /** Override the model string, e.g. "openai/gpt-4o". Use "auto" for smart routing. */
  model?: string;
  /** Sampling temperature 0–2. */
  temperature?: number;
  /** Max tokens to generate. */
  maxTokens?: number;
  /** Vercel AI SDK-compatible tool schema objects. */
  tools?: import('../tools/types.js').ToolSchema[];
  /** Whether to use streaming mode. */
  stream?: boolean;
  /**
   * Reasoning depth preset. When set, overrides `temperature` and `maxTokens`
   * unless those are also explicitly specified.
   *
   * - low:    temp=0.3, maxTokens=1024
   * - medium: temp=0.5, maxTokens=4096
   * - high:   temp=0.7, maxTokens=8192
   * - xhigh:  temp=0.8, maxTokens=16384
   */
  reasoningLevel?: ReasoningLevel;
  /**
   * Input modalities supported by the target model.
   * Based on Codex input_modalities field.
   * Only include modalities the chosen model actually accepts.
   */
  inputModalities?: ('text' | 'image' | 'audio')[];
  /**
   * Force parallel cloud-model racing for this call even when
   * SUDO_BRAIN_RACE_DISABLE=1 is set globally. Use for user-facing
   * latency-sensitive paths (e.g. Telegram chat). Background callers
   * (cognitive ticks, KAIROS, self-build) should leave this unset.
   */
  race?: boolean;
  /**
   * Latency-aware consensus: early-exit once `consensusMinResponders` cloud models
   * agree at ≥ this Jaccard score (0–1). Unset → wait for all models (default).
   * Also settable per-process via SUDO_CONSENSUS_MIN_AGREEMENT.
   */
  consensusMinAgreement?: number;
  /** Min completed responders before consensus early-exit can fire (default 2). */
  consensusMinResponders?: number;
  /** Overall wall-clock cap (ms) for the consensus phase. Env: SUDO_CONSENSUS_TIMEOUT_MS. */
  consensusTimeoutMs?: number;
}

/** Token usage and estimated cost for a single LLM call. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Estimated USD cost based on provider rate table. */
  estimatedCost: number;
}

/** Normalised output from a Brain LLM call. */
export interface BrainResponse {
  content: string;
  toolCalls: ToolCallFromLLM[];
  usage: TokenUsage;
  /** Provider-qualified model that actually responded. */
  model: string;
  finishReason: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error';
  /** Routing/observability trace for this call (which path, cost, switches). */
  routing?: RoutingTrace;
}

// ---------------------------------------------------------------------------
// Model profile (used by failover)
// ---------------------------------------------------------------------------

/** Runtime state of a single model profile tracked by the failover system. */
export interface ModelProfile {
  /** Unique key matching config model ID, e.g. "xai/grok-3-fast". */
  id: string;
  /** Provider name extracted from id. */
  provider: 'xai' | 'openai' | 'anthropic' | 'google';
  /** Raw model ID passed to the provider SDK, e.g. "grok-3-fast". */
  modelId: string;
  /** Lower number = higher priority. Tried first. */
  priority: number;
  /** Unix ms timestamp of last successful call. */
  lastUsed: number;
  /** Unix ms timestamp after which this profile is eligible again. 0 = no cooldown. */
  cooldownUntil: number;
  /** Count of consecutive errors since last success. */
  consecutiveErrors: number;
  /** When true, this profile is permanently disabled (e.g. auth_permanent). */
  disabled: boolean;
}

// ---------------------------------------------------------------------------
// System prompt assembly options
// ---------------------------------------------------------------------------

/** Options passed to assembleSystemPrompt(). */
export interface SystemPromptOptions {
  /** Include HEARTBEAT.md context block. */
  heartbeat?: boolean;
  /** Active persona to inject. */
  persona?: PersonaType;
  /** Active mood to inject. */
  mood?: MoodType;
  /** Available tools to list in the prompt. */
  tools?: Array<{ name: string; description: string }>;
  /** Arbitrary extra instructions appended last. */
  customInstructions?: string;
  /** Recent memory context lines (from daily log). */
  memoryContext?: string;
  /** Internal state string from the consciousness layer (section 7.5). */
  consciousnessContext?: string;
  /**
   * Dynamic contextual hints derived from the user message (see system-hints.ts).
   * Injected as a dedicated section between mood and AGENTS.md.
   */
  activeHints?: string[];
  /**
   * Pre-rendered analytical reasoning-lens block (see reasoning-lens.ts),
   * injected as a dedicated "Reasoning Lens" section when the task matches.
   */
  reasoningLens?: string;
  /**
   * Session peerId for scoping workspace injections.
   * If provided and does NOT match mainPeerId, MEMORY.md is excluded.
   */
  peerId?: string;
  /**
   * The main peerId (from TELEGRAM_CHAT_ID env var).
   * Defaults to process.env.TELEGRAM_CHAT_ID?.split(',')[0]?.trim()
   */
  mainPeerId?: string;
}
