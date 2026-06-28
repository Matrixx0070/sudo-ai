/**
 * @file session-compactor.ts
 * @description SessionCompactor — intelligent context compression for active sessions.
 *
 * As sessions grow long, the accumulated context (tool calls, thinking blocks,
 * conversation turns) consumes an increasing share of the context window.
 * SessionCompactor compresses this history into dense summaries, freeing tokens
 * for productive work while preserving the most important information.
 *
 * Core operations:
 *   - compact()           — run a full compaction pass on a session's context
 *   - summarizeToolCalls()— compress repetitive tool call sequences
 *   - summarizeThinking() — compress extended thinking/reasoning blocks
 *   - estimateTokenCount()— estimate tokens in a context block
 *
 * Compaction is lossy but structured: the compaction result records exactly
 * how many tokens were saved so that downstream systems can budget accordingly.
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';

const log = createLogger('consciousness:session-compactor');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A tool call recorded in a session. */
export interface ToolCall {
  /** Tool name (e.g. 'read_file', 'execute_command'). */
  name: string;
  /** Brief description of the input/arguments. */
  input: string;
  /** Brief description of the output/result. */
  output: string;
  /** ISO-8601 timestamp when the call was made. */
  timestamp: string;
  /** Whether the call succeeded or failed. */
  success: boolean;
}

/** A thinking/reasoning block in a session. */
export interface ThinkingBlock {
  /** The reasoning content. */
  content: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Depth of thinking (0 = surface, higher = deeper). */
  depth: number;
}

/** A conversation turn in a session. */
export interface ConversationTurn {
  /** Role: 'user', 'assistant', 'system', 'tool'. */
  role: string;
  /** The text content. */
  content: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

/** A complete session context ready for compaction. */
export interface SessionContext {
  /** Session identifier. */
  id: string;
  /** All tool calls in the session. */
  toolCalls: ToolCall[];
  /** All thinking/reasoning blocks. */
  thinkingBlocks: ThinkingBlock[];
  /** All conversation turns. */
  turns: ConversationTurn[];
}

/** Result of a compaction operation. */
export interface CompactionResult {
  /** Unique result identifier. */
  id: string;
  /** Session that was compacted. */
  sessionId: string;
  /** Estimated tokens before compaction. */
  originalTokens: number;
  /** Estimated tokens after compaction. */
  compactedTokens: number;
  /** Percentage savings (0-100). */
  savingsPercent: number;
  /** The compacted session context. */
  compacted: SessionContext;
  /** ISO-8601 timestamp when compaction was performed. */
  compactedAt: string;
}

/** Configuration for the SessionCompactor. */
export interface SessionCompactorConfig {
  /** Minimum number of tool calls before summarization kicks in. */
  toolCallSummarizationThreshold: number;
  /** Maximum characters per tool call summary line. */
  maxToolCallSummaryChars: number;
  /** Minimum thinking block length (chars) before summarization. */
  thinkingSummarizationThreshold: number;
  /** Maximum characters per thinking summary. */
  maxThinkingSummaryChars: number;
  /** Maximum number of conversation turns to keep verbatim. */
  maxVerbatimTurns: number;
  /** Maximum characters per older turn (truncated). */
  maxOldTurnChars: number;
}

const DEFAULT_CONFIG: Readonly<SessionCompactorConfig> = {
  toolCallSummarizationThreshold: 10,
  maxToolCallSummaryChars: 120,
  thinkingSummarizationThreshold: 500,
  maxThinkingSummaryChars: 200,
  maxVerbatimTurns: 6,
  maxOldTurnChars: 150,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Rough token estimate: 1 token ~ 4 chars. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate text to maxChars, breaking at word boundary. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars - 1);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.5 ? slice.slice(0, lastSpace) : slice) + '...';
}

// ---------------------------------------------------------------------------
// SessionCompactor
// ---------------------------------------------------------------------------

/**
 * Intelligent context compressor for long-running sessions.
 *
 * Compaction is lossy but structured — it preserves the most important
 * information (recent turns, failed tool calls, key insights) while
 * aggressively compressing repetitive patterns and verbose reasoning.
 */
export class SessionCompactor {
  private readonly config: Readonly<SessionCompactorConfig>;
  private compactionCount = 0;
  private totalTokensSaved = 0;

  constructor(config?: Partial<SessionCompactorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info(
      {
        toolThreshold: this.config.toolCallSummarizationThreshold,
        thinkingThreshold: this.config.thinkingSummarizationThreshold,
      },
      'SessionCompactor initialized',
    );
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run a full compaction pass on a session context.
   * Applies tool call summarization, thinking compression, and turn trimming.
   */
  compact(context: SessionContext): CompactionResult {
    const originalTokens = this.estimateTokenCount(context);

    // Apply compaction strategies
    const compactedToolCalls = this.summarizeToolCalls(context.toolCalls);
    const compactedThinking = this.summarizeThinking(context.thinkingBlocks);
    const compactedTurns = this.compactTurns(context.turns);

    const compacted: SessionContext = {
      id: context.id,
      toolCalls: compactedToolCalls,
      thinkingBlocks: compactedThinking,
      turns: compactedTurns,
    };

    const compactedTokens = this.estimateTokenCount(compacted);
    const savingsPercent =
      originalTokens > 0
        ? Math.round(((originalTokens - compactedTokens) / originalTokens) * 100)
        : 0;

    const result: CompactionResult = {
      id: genId(),
      sessionId: context.id,
      originalTokens,
      compactedTokens,
      savingsPercent,
      compacted,
      compactedAt: new Date().toISOString(),
    };

    this.compactionCount++;
    this.totalTokensSaved += Math.max(0, originalTokens - compactedTokens);

    log.info(
      {
        sessionId: context.id,
        originalTokens,
        compactedTokens,
        savingsPercent,
      },
      'Session compacted',
    );

    return result;
  }

  /**
   * Summarize a sequence of tool calls into a compressed representation.
   *
   * Strategies:
   *   1. Group consecutive calls to the same tool
   *   2. Keep failed calls verbatim (they carry diagnostic information)
   *   3. Compress successful repeated calls into a summary line
   */
  summarizeToolCalls(calls: ToolCall[]): ToolCall[] {
    if (calls.length < this.config.toolCallSummarizationThreshold) {
      return [...calls];
    }

    const result: ToolCall[] = [];
    const groups: Map<string, ToolCall[]> = new Map();

    // First, extract all failed calls — these are kept verbatim
    const failedCalls: ToolCall[] = [];
    const successfulCalls: ToolCall[] = [];

    for (const call of calls) {
      if (!call.success) {
        failedCalls.push(call);
      } else {
        successfulCalls.push(call);
      }
    }

    // Group successful calls by tool name
    for (const call of successfulCalls) {
      const group = groups.get(call.name) ?? [];
      group.push(call);
      result: void 0; // avoid unused
      groups.set(call.name, group);
    }

    // Keep only the last MAX_FAILED_VERBATIM failed calls, truncating their
    // input/output (failure output often holds stack traces / paths / env vars).
    // Older failures collapse to a single elided summary so a tool that fails
    // thousands of times can't make the "compacted" result exceed the input.
    const MAX_FAILED_VERBATIM = 5;
    if (failedCalls.length > MAX_FAILED_VERBATIM) {
      const elided = failedCalls.length - MAX_FAILED_VERBATIM;
      result.push({
        name: 'failed-calls',
        input: `${elided} earlier failed call${elided === 1 ? '' : 's'} (elided)`,
        output: '',
        timestamp: failedCalls[0].timestamp,
        success: false,
      });
    }
    for (const call of failedCalls.slice(-MAX_FAILED_VERBATIM)) {
      result.push({
        ...call,
        input: truncate(call.input, this.config.maxToolCallSummaryChars),
        output: truncate(call.output, this.config.maxToolCallSummaryChars),
      });
    }

    // Compress each group of successful calls
    for (const [toolName, groupCalls] of groups) {
      if (groupCalls.length <= 2) {
        // Few calls: keep them but truncate input/output
        for (const call of groupCalls) {
          result.push({
            ...call,
            input: truncate(call.input, this.config.maxToolCallSummaryChars),
            output: truncate(call.output, this.config.maxToolCallSummaryChars),
          });
        }
      } else {
        // Many calls: summarize as a single entry
        const firstTime = groupCalls[0].timestamp;
        const lastTime = groupCalls[groupCalls.length - 1].timestamp;
        const summaryInput = `${groupCalls.length} calls to ${toolName}`;
        const summaryOutput = truncate(
          groupCalls.map((c) => truncate(c.output, 40)).join('; '),
          this.config.maxToolCallSummaryChars,
        );

        result.push({
          name: toolName,
          input: summaryInput,
          output: summaryOutput,
          timestamp: `${firstTime}..${lastTime}`,
          success: true,
        });
      }
    }

    // Sort by timestamp. Summarized groups carry a "start..end" range stamp;
    // compare on the start component so they collate against real ISO stamps.
    const startOf = (ts: string) => ts.split('..')[0];
    result.sort((a, b) => startOf(a.timestamp).localeCompare(startOf(b.timestamp)));

    return result;
  }

  /**
   * Compress thinking/reasoning blocks.
   *
   * Strategies:
   *   1. Short blocks (< threshold chars) are kept as-is
   *   2. Longer blocks are truncated to maxThinkingSummaryChars
   *   3. Very deep thinking (depth > 2) gets extra compression
   */
  summarizeThinking(blocks: ThinkingBlock[]): ThinkingBlock[] {
    return blocks.map((block) => {
      if (block.content.length < this.config.thinkingSummarizationThreshold) {
        return block;
      }

      // Deeper thinking gets more aggressive truncation
      const maxChars =
        block.depth > 2
          ? Math.floor(this.config.maxThinkingSummaryChars / 2)
          : this.config.maxThinkingSummaryChars;

      return {
        ...block,
        content: truncate(block.content, maxChars),
      };
    });
  }

  /**
   * Estimate the total token count of a session context.
   * Uses 4 chars/token approximation.
   */
  estimateTokenCount(context: SessionContext): number {
    let total = 0;

    for (const call of context.toolCalls) {
      total += estimateTokens(call.name);
      total += estimateTokens(call.input);
      total += estimateTokens(call.output);
    }

    for (const block of context.thinkingBlocks) {
      total += estimateTokens(block.content);
    }

    for (const turn of context.turns) {
      total += estimateTokens(turn.role);
      total += estimateTokens(turn.content);
    }

    return total;
  }

  /**
   * Get operational statistics.
   */
  getStats(): { totalCompactions: number; totalTokensSaved: number } {
    return {
      totalCompactions: this.compactionCount,
      totalTokensSaved: this.totalTokensSaved,
    };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Compact conversation turns: keep the most recent N verbatim,
   * truncate older turns.
   */
  private compactTurns(turns: ConversationTurn[]): ConversationTurn[] {
    if (turns.length <= this.config.maxVerbatimTurns) {
      return [...turns];
    }

    const splitIndex = turns.length - this.config.maxVerbatimTurns;
    const oldTurns = turns.slice(0, splitIndex);
    const recentTurns = turns.slice(splitIndex);

    // Compress old turns
    const compactedOld: ConversationTurn[] = oldTurns.map((turn) => ({
      ...turn,
      content: truncate(turn.content, this.config.maxOldTurnChars),
    }));

    return [...compactedOld, ...recentTurns];
  }
}