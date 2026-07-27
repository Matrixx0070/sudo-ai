/**
 * agent.command — the single full-control entry point for the grok-web-mcp
 * boundary (ADR 0001). Grok app-chat, via the registered MCP connector, calls
 * THIS tool with a natural-language instruction; it runs a complete owner-tier
 * sudo-ai agent turn (every tool, memory, channel) and returns the reply. That
 * turns Grok app-chat into a true remote control for the whole agent, instead
 * of the readonly peephole the public boundary otherwise enforces.
 *
 * SECURITY POSTURE (owner tier — Frank's explicit choice 2026-07-27):
 *   - The capability token in the public MCP URL is the sole auth gate. Holding
 *     it = keys to the kingdom. That is deliberate.
 *   - The instruction is untrusted external-model text (it arrives via grok's
 *     cloud). The public server's F18 arg-injection gate still scores it before
 *     this tool ever runs (mcp-public-server.ts inspectArgs).
 *   - Runs at isOwner:true so owner-gated tools (restart, self-modify, email…)
 *     are reachable. This is the whole point of "full control".
 *   - Registered ONLY when SUDO_GROK_WEB_MCP_COMMAND=1 (default OFF), and only
 *     ever reaches the wire as the ONE blessed non-readonly commandTool the
 *     public server allows past its readonly-only rule.
 *
 * Budgets (doctrine invariant #10): a per-day cap and an in-flight cap bound
 * how hard the external cloud can drive the agent; exhaustion refuses loudly.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { getAgentLoop, getSessionManager } from './index.js';

const logger = createLogger('agent.command');

/** The tool name — also the single value passed as the public server's commandTool. */
export const AGENT_COMMAND_TOOL_NAME = 'agent.command';

/** Channel tag for command-driven sessions (used by the recursion guard). */
const COMMAND_CHANNEL = 'grok-mcp';
const COMMAND_PEER = 'owner';

// ---------------------------------------------------------------------------
// Budgets — overridable via env
// ---------------------------------------------------------------------------

const MAX_PER_DAY: number = (() => {
  const v = parseInt(process.env['SUDO_GROK_COMMAND_MAX_PER_DAY'] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 200;
})();

// Default 1 = serialize command turns. The command session is STABLE (reused
// across calls, so Grok app-chat gets conversational continuity), and two turns
// on one session concurrently would interleave its history. Operators who want
// parallel commands (and accept that risk) can raise this.
const MAX_IN_FLIGHT: number = (() => {
  const v = parseInt(process.env['SUDO_GROK_COMMAND_MAX_IN_FLIGHT'] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

// ---------------------------------------------------------------------------
// Rolling 24h budget + in-flight tracking (module state, like sessions.spawn)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
/** Timestamps (ms) of accepted commands within the rolling window. */
let commandTimestamps: number[] = [];
let inFlight = 0;
/** Session IDs with a command turn currently running — the recursion guard set. */
const activeCommandSessions = new Set<string>();

function pruneWindow(now: number): void {
  const cutoff = now - DAY_MS;
  if (commandTimestamps.length > 0 && commandTimestamps[0]! < cutoff) {
    commandTimestamps = commandTimestamps.filter((t) => t >= cutoff);
  }
}

/** Test-only: reset budget + in-flight state between runs. */
export function _resetCommandBudget(): void {
  commandTimestamps = [];
  inFlight = 0;
  activeCommandSessions.clear();
}

// ---------------------------------------------------------------------------
// Duck-typed deps (avoid circular imports — same pattern as sessions-spawn)
// ---------------------------------------------------------------------------

interface SessionManagerLike {
  getOrCreate(channel: string, peerId: string): Promise<{ id: string | number }>;
}

interface AgentLoopLike {
  run(
    sessionId: string,
    message: string,
    onEvent?: unknown,
    opts?: { caller?: { isOwner?: boolean; channel?: string; peerId?: string } },
  ): Promise<{ text: string }>;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const agentCommandTool: ToolDefinition = {
  name: AGENT_COMMAND_TOOL_NAME,
  description:
    'Run a full sudo-ai agent turn from a natural-language instruction and return its reply. ' +
    'This is the remote-control entry point: the instruction is executed with the agent\'s FULL ' +
    'capabilities (all tools, memory, channels) as the owner. Use it to make sudo-ai DO something — ' +
    'e.g. "check my email and reply to Sam", "build and restart yourself", "what is the server status".',
  category: 'meta',
  // NOT readonly — this drives the whole agent. It only reaches the external
  // MCP boundary as the single blessed commandTool (mcp-public-server.ts), and
  // is only registered when SUDO_GROK_WEB_MCP_COMMAND=1.
  safety: 'destructive',
  // Hidden from the AGENT's own tool menu — this is an EXTERNAL entry point
  // only. It stays reachable via the MCP boundary (listAll/get/execute) but the
  // model never sees it in a normal turn, so it can't call agent.command on
  // itself. (Recursion guard below is the belt to this suspenders.)
  hiddenFromAgent: true,
  timeout: 600_000,
  parameters: {
    instruction: {
      type: 'string',
      required: true,
      description: 'The natural-language command for sudo-ai to carry out, exactly as the owner would phrase it.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const instruction = (params['instruction'] as string | undefined)?.trim();
    if (!instruction) {
      return { success: false, output: 'agent.command: "instruction" is required and must be non-empty.' };
    }

    // Recursion guard: if THIS call is happening inside a session that already
    // has a command turn running, refuse — otherwise the agent could call
    // agent.command on itself and nest full turns. Session IDs are random
    // nanoids (not channel-prefixed), so membership in the live set is the
    // reliable signal, not the id shape.
    if (typeof ctx.sessionId === 'string' && activeCommandSessions.has(ctx.sessionId)) {
      logger.warn({ session: ctx.sessionId }, 'agent.command: refused recursive invocation from an active command session');
      return { success: false, output: 'agent.command cannot be called from within a command-driven turn.' };
    }

    const now = Date.now();
    pruneWindow(now);

    // Budget guard 1 — rolling per-day cap.
    if (commandTimestamps.length >= MAX_PER_DAY) {
      logger.warn({ used: commandTimestamps.length, max: MAX_PER_DAY }, 'agent.command: daily budget exhausted');
      return {
        success: false,
        output: `agent.command daily budget exhausted (${commandTimestamps.length}/${MAX_PER_DAY} in the last 24h). ` +
          'Raise SUDO_GROK_COMMAND_MAX_PER_DAY or wait for the window to roll.',
      };
    }

    // Budget guard 2 — global in-flight cap (bounds how hard the cloud can drive us).
    if (inFlight >= MAX_IN_FLIGHT) {
      logger.warn({ inFlight, max: MAX_IN_FLIGHT }, 'agent.command: in-flight cap reached');
      return {
        success: false,
        output: `agent.command is busy (${inFlight}/${MAX_IN_FLIGHT} turns running). Try again once a turn completes.`,
      };
    }

    const sessionManager = getSessionManager() as SessionManagerLike | null;
    const agentLoop = getAgentLoop() as AgentLoopLike | null;
    if (!sessionManager || !agentLoop) {
      logger.warn({ hasSm: !!sessionManager, hasLoop: !!agentLoop }, 'agent.command: deps not injected');
      return {
        success: false,
        output: 'agent.command: agent loop / session manager not initialised (injectMetaToolDeps not called).',
      };
    }

    // Commit budget SYNCHRONOUSLY before the first await (TOCTOU-safe, like sessions.spawn).
    commandTimestamps.push(now);
    inFlight++;
    let sessionId: string | null = null;
    try {
      const session = await sessionManager.getOrCreate(COMMAND_CHANNEL, COMMAND_PEER);
      sessionId = String(session.id);
      activeCommandSessions.add(sessionId);
      logger.info({ sessionId, instructionLen: instruction.length }, 'agent.command: running owner-tier turn');

      const result = await agentLoop.run(sessionId, instruction, undefined, {
        caller: { isOwner: true, channel: COMMAND_CHANNEL, peerId: COMMAND_PEER },
      });

      const text = result.text?.trim() || '(the turn completed with no textual reply)';
      logger.info({ sessionId, replyLen: text.length }, 'agent.command: turn complete');
      return { success: true, output: text, data: { sessionId } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'agent.command: turn failed');
      return { success: false, output: `agent.command failed: ${msg}` };
    } finally {
      inFlight--;
      if (sessionId !== null) activeCommandSessions.delete(sessionId);
    }
  },
};
