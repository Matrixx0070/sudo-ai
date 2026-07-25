/**
 * @file grok-web-tool-loop.ts
 * @description Multi-turn tool-execution loop over the FREE grok.com app-chat
 * lane (SuperGrok weekly pool). Turns the single-turn `chatGrokWeb` + the
 * prompt-emulated parse layer (grok-web-tools.ts) into an agentic brain:
 *
 *   observe → grok replies → (tool_use? run it, feed result back : final text)
 *
 * The loop is I/O-injected — `chat` (one app-chat turn) and `executeTool` (run
 * a sudo-ai tool) are passed in — so it is fully unit-testable without a live
 * seat, and the same loop works whether `chat` is chatGrokWeb, a mock, or a
 * different free lane later.
 *
 * Discipline carried from the loop-engineering lessons:
 *  - Every tool ERROR re-enters the loop as an observation (tool_result
 *    is_error:true), never silently swallowed (silent-failure rule / #751).
 *  - A hard iteration cap halts with an explicit stopReason — no unbounded loop.
 *  - Model output is raw external text; the CALLER quarantines it before it
 *    drives any control decision beyond this loop (invariant 2).
 */

import type { IRMessage } from '../../shared-types/ir/v1.js';
import type { IRTool } from '../../shared-types/ir/v1.js';
import { buildChatMessage, parseGrokReply, type IdFn } from './grok-web-tools.js';

/** One app-chat turn: given the rendered message, return grok's raw reply. */
export type GrokChatFn = (message: string) => Promise<{ text: string }>;

/** Result of executing one sudo-ai tool for the loop. */
export interface GrokToolExecResult {
  /** Text fed back to grok as the tool_result. */
  content: string;
  /** Marks the result as an error observation (grok sees "Tool error: …"). */
  isError?: boolean;
}

/** Run a tool call. May throw — the loop converts a throw into an error result. */
export type GrokToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<GrokToolExecResult>;

export interface GrokToolLoopOptions {
  /** Hard ceiling on tool round-trips before halting. Default 8. */
  maxIterations?: number;
  /** Injectable id minter for tool_use blocks (deterministic in tests). */
  idFn?: IdFn;
}

export type GrokToolLoopStopReason = 'final' | 'max_iterations';

export interface GrokToolLoopResult {
  /** grok's final answer text ('' if it stopped without one). */
  finalText: string;
  /** Why the loop ended. */
  stopReason: GrokToolLoopStopReason;
  /** Tool round-trips executed. */
  iterations: number;
  /** Full IR transcript incl. every tool_use / tool_result (for logging/eval). */
  messages: IRMessage[];
}

/**
 * Drive the ReACT loop on the free app-chat lane.
 *
 * @param seed     initial IR messages (the user turn + any prior context)
 * @param tools    tool roster offered to grok (rendered into the prompt)
 * @param chat     one-turn app-chat call (e.g. a closure over chatGrokWeb)
 * @param execute  runs a named tool with its parsed input
 */
export async function runGrokWebToolLoop(
  seed: readonly IRMessage[],
  tools: readonly IRTool[],
  chat: GrokChatFn,
  execute: GrokToolExecutor,
  opts: GrokToolLoopOptions = {},
): Promise<GrokToolLoopResult> {
  const maxIterations = opts.maxIterations ?? 8;
  const messages: IRMessage[] = [...seed];

  for (let i = 0; i < maxIterations; i++) {
    const message = buildChatMessage(messages, tools);
    const reply = await chat(message);
    const parsed = parseGrokReply(reply.text ?? '', opts.idFn);

    if (parsed.kind === 'text') {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: parsed.text }] });
      return { finalText: parsed.text, stopReason: 'final', iterations: i, messages };
    }

    // tool_use: record grok's call, run the tool, feed the result back.
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: parsed.id, name: parsed.name, input: parsed.input }],
    });

    let result: GrokToolExecResult;
    try {
      result = await execute(parsed.name, parsed.input);
    } catch (err) {
      // A throwing tool is an observation, not a loop crash.
      result = { content: `Tool "${parsed.name}" failed: ${(err as Error).message}`, isError: true };
    }

    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: parsed.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        },
      ],
    });
  }

  // Ran out of iterations without a final answer — halt explicitly.
  return {
    finalText: '',
    stopReason: 'max_iterations',
    iterations: maxIterations,
    messages,
  };
}
