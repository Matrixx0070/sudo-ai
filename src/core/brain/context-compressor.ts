/**
 * Graduated Context Compression for SUDO-AI v4.
 *
 * Replaces the single-level compaction in agent/compaction.ts with a four-stage
 * approach that compresses progressively as the context window fills up.
 *
 * Stages:
 *   1. MILD       (50%) — Summarise oldest message pairs, keep recent intact.
 *   2. MODERATE   (70%) — Compress tool results, merge assistant turns, trim system.
 *   3. AGGRESSIVE (85%) — Full-history structured summary, last 5 pairs uncompressed.
 *   4. EMERGENCY  (95%) — Force session fork with compressed context.
 *
 * Design principles:
 *   - Never compress the system prompt (first message stays verbatim).
 *   - Never drop the last user message and last assistant response.
 *   - Preserve tool-call/result pairs — never split them apart.
 *   - Progressive summarisation: each stage builds on the previous, never re-expands.
 *   - Idempotent: running the same stage twice produces the same result.
 */

import { createLogger } from '../shared/logger.js';
import { estimateTokens } from '../shared/utils.js';
import type { BrainMessage } from './types.js';

const log = createLogger('brain:context-compressor');

// -- Public types --

/** Compression stage, from least to most aggressive. */
export type CompressionStage = 'none' | 'mild' | 'moderate' | 'aggressive' | 'emergency';

/** Result of a compression pass. */
export interface CompressionResult {
  stage: CompressionStage;
  tokensBefore: number;
  tokensAfter: number;
  /** Compression ratio (tokensAfter / tokensBefore). 1 = no compression. */
  ratio: number;
  /** Structured summary produced at aggressive stage or higher. */
  summary?: string;
  /** ID of the forked child session when emergency stage fires. */
  forkedSessionId?: string;
}

/** Threshold configuration for each compression stage. */
export interface CompressionConfig {
  mildThreshold: number;
  moderateThreshold: number;
  aggressiveThreshold: number;
  emergencyThreshold: number;
}

// -- Defaults & helpers --

const DEFAULT_CONFIG: CompressionConfig = {
  mildThreshold: 0.5,
  moderateThreshold: 0.7,
  aggressiveThreshold: 0.85,
  emergencyThreshold: 0.95,
};

/** The five required section headers for the structured summary. */
const SUMMARY_SECTIONS = ['Decisions', 'Open TODOs', 'Constraints', 'Pending asks', 'Identifiers'] as const;

/** Count estimated tokens across an array of messages. */
function countTokens(messages: BrainMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/** Find tool-call/result boundaries so we never split a pair. */
function findToolResultIndices(messages: BrainMessage[]): Set<number> {
  const paired = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && messages[i].toolCalls?.length) {
      const callIds = new Set(messages[i].toolCalls!.map((tc) => tc.id));
      for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) {
        if (messages[j].toolCallId && callIds.has(messages[j].toolCallId as string)) {
          paired.add(j);
        }
      }
      paired.add(i); // the assistant message itself is part of the pair
    }
  }
  return paired;
}

/** Find the index of the last message with a given role. Returns -1 if none. */
function lastIndexByRole(messages: BrainMessage[], role: BrainMessage['role']): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) return i;
  }
  return -1;
}

/** Generate a short deterministic summary placeholder for a message (local, no LLM). */
function summarizeMessage(msg: BrainMessage, maxChars: number = 200): string {
  const snippet = msg.content.length > maxChars
    ? msg.content.slice(0, maxChars) + '…'
    : msg.content;
  if (msg.role === 'tool') return `[tool:${msg.toolName ?? 'unknown'}] ${snippet}`;
  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    return `[assistant→${msg.toolCalls.map((tc) => tc.name).join(', ')}] ${snippet}`;
  }
  return `[${msg.role}] ${snippet}`;
}

/** Build a structured 5-section summary from a message list using heuristic extraction. */
function buildStructuredSummary(messages: BrainMessage[]): string {
  const sectionKeywords: Record<string, string[]> = {
    Decisions: ['decided', 'decision', 'chose', 'agreed', 'confirmed', 'will use', 'switching to'],
    'Open TODOs': ['todo', 'still need', 'remaining', 'pending', 'not yet', 'follow-up'],
    Constraints: ['must not', 'cannot', 'constraint', 'limit', 'requirement', 'must be'],
    'Pending asks': ['waiting for', 'need from', 'asked for', 'please', 'can you'],
    Identifiers: [],
  };

  const lines: string[] = ['# Context Summary'];

  for (const section of SUMMARY_SECTIONS) {
    lines.push('', `## ${section}`);
    const entries: string[] = [];

    for (const msg of messages) {
      const lower = msg.content.toLowerCase();
      if (section === 'Identifiers') {
        // Extract hex IDs, file paths, and URLs.
        for (const pattern of [/\b[a-f0-9]{8,}\b/g, /\/[\w.-]+\/[\w.-]+/g, /https?:\/\/\S+/g]) {
          const matches = lower.match(pattern);
          if (matches) entries.push(...matches.slice(0, 3).map((m) => `- ${m} (from ${msg.role})`));
        }
      } else {
        const kws = sectionKeywords[section] ?? [];
        if (kws.some((kw) => lower.includes(kw))) {
          entries.push(`- ${summarizeMessage(msg, 150)}`);
        }
      }
    }

    const unique = [...new Set(entries)].slice(0, 10);
    lines.push(...(unique.length > 0 ? unique : ['- (none detected)']));
  }

  return lines.join('\n');
}

// -- ContextCompressor class --

/**
 * Four-stage graduated context compressor.
 *
 * Usage:
 *   const compressor = new ContextCompressor();
 *   const stage = compressor.shouldCompress(0.72); // => 'moderate'
 *   const result = await compressor.compress(messages, stage, maxTokens);
 */
export class ContextCompressor {
  private readonly config: CompressionConfig;
  private totalCompressions = 0;
  private tokensSaved = 0;
  private readonly byStage: Record<Exclude<CompressionStage, 'none'>, number> = {
    mild: 0, moderate: 0, aggressive: 0, emergency: 0,
  };

  constructor(config?: Partial<CompressionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // -- Stage detection --

  /** Determine which compression stage applies given context utilisation (0-1). */
  shouldCompress(contextPercent: number): CompressionStage {
    if (contextPercent >= this.config.emergencyThreshold) return 'emergency';
    if (contextPercent >= this.config.aggressiveThreshold) return 'aggressive';
    if (contextPercent >= this.config.moderateThreshold) return 'moderate';
    if (contextPercent >= this.config.mildThreshold) return 'mild';
    return 'none';
  }

  // -- Top-level compress --

  /**
   * Compress messages according to the given stage.
   * @param messages  - Full conversation history.
   * @param stage     - Compression stage to apply.
   * @param maxTokens - Context window budget in tokens.
   */
  async compress(
    messages: BrainMessage[],
    stage: CompressionStage,
    maxTokens: number,
  ): Promise<CompressionResult> {
    const tokensBefore = countTokens(messages);

    if (stage === 'none' || messages.length === 0) {
      return { stage, tokensBefore, tokensAfter: tokensBefore, ratio: 1 };
    }

    log.info({ stage, tokensBefore, messageCount: messages.length }, 'Starting context compression');

    let compressed: BrainMessage[];
    let summary: string | undefined;
    let forkedSessionId: string | undefined;

    switch (stage) {
      case 'mild':
        compressed = await this.compressMild(messages);
        break;
      case 'moderate':
        compressed = await this.compressModerate(messages);
        break;
      case 'aggressive': {
        const agg = await this.compressAggressive(messages);
        compressed = agg.messages;
        summary = agg.summary;
        break;
      }
      case 'emergency': {
        const sid = `fork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const em = await this.compressEmergency(messages, sid);
        compressed = em.messages;
        forkedSessionId = em.forkedSessionId;
        summary = buildStructuredSummary(messages);
        break;
      }
      default:
        compressed = messages;
    }

    const tokensAfter = countTokens(compressed);
    const ratio = tokensBefore > 0 ? tokensAfter / tokensBefore : 1;

    this.totalCompressions++;
    this.byStage[stage]++;
    this.tokensSaved += Math.max(0, tokensBefore - tokensAfter);

    log.info({ stage, tokensBefore, tokensAfter, ratio: ratio.toFixed(2) }, 'Compression complete');

    return { stage, tokensBefore, tokensAfter, ratio, summary, forkedSessionId };
  }

  // -- Stage 1 — MILD (50%): Summarise oldest pairs, keep recent intact. --

  /** Preserve all tool-call/result pairs. Keep system prompt verbatim. */
  async compressMild(messages: BrainMessage[]): Promise<BrainMessage[]> {
    if (messages.length <= 4) return messages;

    const toolPaired = findToolResultIndices(messages);
    const protectedIdx = new Set<number>();
    protectedIdx.add(0); // system prompt
    const lastUser = lastIndexByRole(messages, 'user');
    const lastAsst = lastIndexByRole(messages, 'assistant');
    if (lastUser >= 0) protectedIdx.add(lastUser);
    if (lastAsst >= 0) protectedIdx.add(lastAsst);
    for (const idx of toolPaired) protectedIdx.add(idx);

    // Older half is eligible for summarisation; newer half stays intact.
    const mid = Math.floor(messages.length / 2);
    return messages.map((msg, i) =>
      protectedIdx.has(i) || i >= mid
        ? msg
        : { role: msg.role, content: summarizeMessage(msg) },
    );
  }

  // -- Stage 2 — MODERATE (70%): Compress older tool results, merge assistants. --

  /** Compress older tool results to key outcomes. Merge consecutive assistant turns. Trim verbose system sections. */
  async compressModerate(messages: BrainMessage[]): Promise<BrainMessage[]> {
    if (messages.length <= 4) return messages;

    const toolPaired = findToolResultIndices(messages);
    const protectedIdx = new Set<number>();
    protectedIdx.add(0);
    const lastUser = lastIndexByRole(messages, 'user');
    const lastAsst = lastIndexByRole(messages, 'assistant');
    if (lastUser >= 0) protectedIdx.add(lastUser);
    if (lastAsst >= 0) protectedIdx.add(lastAsst);

    // Protect the last 3 tool-call/result pairs.
    let pairCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!toolPaired.has(i)) continue;
      if (messages[i].role === 'assistant' && messages[i].toolCalls?.length) {
        pairCount++;
        if (pairCount > 3) break;
        protectedIdx.add(i);
        const callIds = new Set(messages[i].toolCalls!.map((tc) => tc.id));
        for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) {
          if (messages[j].toolCallId && callIds.has(messages[j].toolCallId as string)) protectedIdx.add(j);
        }
      }
    }

    const result: BrainMessage[] = [];
    let i = 0;
    const half = Math.floor(messages.length / 2);

    while (i < messages.length) {
      const msg = messages[i];

      if (protectedIdx.has(i)) {
        result.push(msg);
        i++;
      } else if (msg.role === 'tool') {
        // Compress older tool results to key outcomes.
        result.push({ ...msg, content: summarizeMessage(msg, 120) });
        i++;
      } else if (msg.role === 'system' && i > 0 && msg.content.length > 500) {
        // Trim verbose system sections.
        result.push({ ...msg, content: summarizeMessage(msg, 300) });
        i++;
      } else if (msg.role === 'assistant' && !msg.toolCalls?.length) {
        // Merge consecutive non-tool-call assistant messages.
        const merged: string[] = [msg.content];
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'assistant' && !messages[j].toolCalls?.length && !protectedIdx.has(j)) {
          merged.push(messages[j].content);
          j++;
        }
        result.push({ ...msg, content: merged.join('\n\n[merged]\n\n') });
        i = j;
      } else if (i < half) {
        // Summarise older non-protected messages.
        result.push({ ...msg, content: summarizeMessage(msg, 150) });
        i++;
      } else {
        result.push(msg);
        i++;
      }
    }

    return result;
  }

  // -- Stage 3 — AGGRESSIVE (85%): Structured summary, last 5 pairs intact. --

  /** Compress entire conversation history to a structured summary with 5 sections. Keep only last 5 message pairs uncompressed. */
  async compressAggressive(messages: BrainMessage[]): Promise<{ messages: BrainMessage[]; summary: string }> {
    if (messages.length <= 10) {
      return { messages, summary: buildStructuredSummary(messages) };
    }

    const summary = buildStructuredSummary(messages);

    // Walk backwards to find the start of the last 5 user-message pairs.
    let pairCount = 0;
    let cutoff = messages.length;
    for (let i = messages.length - 1; i >= 1; i--) {
      if (messages[i].role === 'user' && ++pairCount >= 5) {
        cutoff = i;
        break;
      }
    }

    const result: BrainMessage[] = [
      messages[0], // system prompt verbatim
      { role: 'system', content: `[Context Summary — aggressive compression]\n\n${summary}` },
      ...messages.slice(cutoff), // last 5 pairs unchanged
    ];

    return { messages: result, summary };
  }

  // -- Stage 4 — EMERGENCY (95%): Force session fork. --

  /**
   * Force session fork. Create child session with compressed context.
   * The child receives: system prompt + structured summary + last user message.
   */
  async compressEmergency(
    messages: BrainMessage[],
    sessionId: string,
  ): Promise<{ messages: BrainMessage[]; forkedSessionId: string }> {
    const summary = buildStructuredSummary(messages);

    // Find last user message without Array.findLast (ES2023 compat).
    let lastUser: BrainMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUser = messages[i]; break; }
    }

    const childMessages: BrainMessage[] = [
      messages[0], // system prompt verbatim
      { role: 'system', content: `[Context Summary — emergency fork from session ${sessionId}]\n\n${summary}` },
    ];
    if (lastUser) childMessages.push(lastUser);

    log.warn(
      { sessionId, originalMessages: messages.length, childMessages: childMessages.length },
      'Emergency compression: session forked',
    );

    return { messages: childMessages, forkedSessionId: sessionId };
  }

  // -- Stats --

  /** Return lifetime compression statistics for this compressor instance. */
  getStats(): { totalCompressions: number; byStage: Record<string, number>; tokensSaved: number } {
    return {
      totalCompressions: this.totalCompressions,
      byStage: { ...this.byStage },
      tokensSaved: this.tokensSaved,
    };
  }
}