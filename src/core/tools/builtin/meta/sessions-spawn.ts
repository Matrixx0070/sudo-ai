/**
 * meta.sessions.spawn — Spawn a new subordinate agent session with a given task.
 *
 * Creates a new session via the injected sessionManager, then runs the agent
 * loop against that session. If either dependency has not been injected
 * (e.g. during tests or early boot), the tool returns a graceful
 * not-initialised error rather than throwing.
 *
 * Budget enforcement (Session 19):
 *   - MAX_SPAWN_DEPTH: prevents unbounded recursive sub-agent chains.
 *   - MAX_SPAWNS_PER_SESSION: per-parent spawn count cap with 1-hour TTL cleanup.
 *   - MAX_CONCURRENT_SPAWNS: global anti-fork-bomb guard.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { getAgentLoop, getChannelRouter, getSessionManager } from './index.js';
import { isCommsIdempotencyEnabled, getCommsIdempotencyStore } from '../../../comms/idempotency.js';

const logger = createLogger('meta.sessions.spawn');

// ---------------------------------------------------------------------------
// Budget constants — overridable via environment variables
// ---------------------------------------------------------------------------

const MAX_SPAWN_DEPTH: number = (() => {
  const v = parseInt(process.env['SUDO_MAX_SPAWN_DEPTH'] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 3;
})();

const MAX_SPAWNS_PER_SESSION: number = (() => {
  const v = parseInt(process.env['SUDO_MAX_SPAWNS_PER_SESSION'] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 10;
})();

const MAX_CONCURRENT_SPAWNS: number = (() => {
  const v = parseInt(process.env['SUDO_MAX_CONCURRENT_SPAWNS'] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 20;
})();

// ---------------------------------------------------------------------------
// Module-level budget tracking state
// ---------------------------------------------------------------------------

/** Maps sessionId → spawn depth (0 = user-initiated root, 1 = first sub-agent, etc.) */
const depthMap = new Map<string, number>();

/** Maps parentSessionId → { count of spawns made, timestamp of last spawn } */
const spawnCountMap = new Map<string, { count: number; lastAt: number }>();

/** Number of spawned agents currently running (incremented before run, decremented in finally). */
let concurrentSpawns = 0;

// ---------------------------------------------------------------------------
// TTL cleanup — sweep spawn counts older than 1 hour every 10 minutes
// ---------------------------------------------------------------------------

const TTL_SWEEP_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes
const TTL_ENTRY_MAX_AGE_MS  = 60 * 60 * 1000;   // 1 hour

const _cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - TTL_ENTRY_MAX_AGE_MS;
  for (const [id, entry] of spawnCountMap) {
    if (entry.lastAt < cutoff) {
      spawnCountMap.delete(id);
      logger.debug({ parentSession: id }, 'sessions.spawn: TTL-swept spawn count entry');
    }
  }
}, TTL_SWEEP_INTERVAL_MS);

// Prevent the timer from keeping the process alive in tests / short-lived runs.
if (typeof _cleanupTimer.unref === 'function') _cleanupTimer.unref();

// ---------------------------------------------------------------------------
// Test helper — exported so unit tests can reset state between runs
// ---------------------------------------------------------------------------

/**
 * Reset all in-process budget tracking state.
 * ONLY call this from tests — never from production code.
 */
export function _resetBudgetState(): void {
  depthMap.clear();
  spawnCountMap.clear();
  concurrentSpawns = 0;
}

// ---------------------------------------------------------------------------
// Duck-typed interfaces (avoid circular imports)
// ---------------------------------------------------------------------------

interface SessionManagerLike {
  getOrCreate(channel: string, peerId: string): Promise<{ id: string | number }>;
}

interface AgentLoopLike {
  run(sessionId: string, message: string): Promise<{ text: string }>;
}

interface ChannelRouterLike {
  send(channel: string, peerId: string, text: string): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const sessionsSpawnTool: ToolDefinition = {
  name: 'sessions.spawn',
  description:
    'Spawn a new subordinate agent session to work on a task in parallel. ' +
    'Returns the new session ID once the agent has been queued. ' +
    'Use when you need to delegate work to a child agent or run tasks concurrently.',
  category: 'meta',
  timeout: 60_000,
  parameters: {
    task: {
      type: 'string',
      required: true,
      description: 'Full task description or instruction to pass to the new agent session.',
    },
    channel: {
      type: 'string',
      required: false,
      description: 'Delivery channel for the spawned session (e.g. "telegram", "api"). Defaults to the current session channel.',
    },
    peerId: {
      type: 'string',
      required: false,
      description: 'Peer/user identifier within the channel to associate with the spawned session.',
    },
    model: {
      type: 'string',
      required: false,
      description: 'Model override for the spawned session (e.g. "claude-opus-4-5"). Defaults to the configured model.',
    },
    announceBack: {
      type: 'boolean',
      required: false,
      description: 'Whether to announce results back to the parent session (default: true)',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task = params['task'] as string | undefined;
    const channel = params['channel'] as string | undefined;
    const peerId = params['peerId'] as string | undefined;
    // Default announceBack to true when not explicitly set to false
    const announceBack = params['announceBack'] !== false;

    logger.info({ session: ctx.sessionId, channel, announceBack }, 'sessions.spawn invoked');

    // ------------------------------------------------------------------
    // Input validation
    // ------------------------------------------------------------------

    if (!task?.trim()) {
      return { success: false, output: 'sessions.spawn: "task" parameter is required and must be non-empty.' };
    }

    // ------------------------------------------------------------------
    // Budget guard 1 — depth limit
    // ------------------------------------------------------------------

    const currentDepth = depthMap.get(ctx.sessionId) ?? 0;
    if (currentDepth >= MAX_SPAWN_DEPTH) {
      logger.warn({ session: ctx.sessionId, currentDepth, max: MAX_SPAWN_DEPTH }, 'sessions.spawn: depth limit reached');
      return {
        success: false,
        output: `Sub-agent depth limit reached (current: ${currentDepth}, max: ${MAX_SPAWN_DEPTH}). Unwind the chain before spawning more.`,
      };
    }

    // ------------------------------------------------------------------
    // Budget guard 2 — per-session spawn count
    // ------------------------------------------------------------------

    const spawnEntry = spawnCountMap.get(ctx.sessionId);
    const currentCount = spawnEntry?.count ?? 0;
    if (currentCount >= MAX_SPAWNS_PER_SESSION) {
      logger.warn({ session: ctx.sessionId, currentCount, max: MAX_SPAWNS_PER_SESSION }, 'sessions.spawn: per-session count limit reached');
      return {
        success: false,
        output: `Session spawn limit reached (spawned: ${currentCount}, max: ${MAX_SPAWNS_PER_SESSION}). Wait for current sub-agents to complete or start a new session.`,
      };
    }

    // ------------------------------------------------------------------
    // Budget guard 3 — global concurrent cap
    // ------------------------------------------------------------------

    if (concurrentSpawns >= MAX_CONCURRENT_SPAWNS) {
      logger.warn({ concurrentSpawns, max: MAX_CONCURRENT_SPAWNS }, 'sessions.spawn: global concurrent cap reached');
      return {
        success: false,
        output: `Too many concurrent sub-agents (running: ${concurrentSpawns}, max: ${MAX_CONCURRENT_SPAWNS}). Try again when current work completes.`,
      };
    }

    // ------------------------------------------------------------------
    // Dependency checks
    // ------------------------------------------------------------------

    const sessionManager = getSessionManager() as SessionManagerLike | null;
    if (!sessionManager) {
      logger.warn({ session: ctx.sessionId }, 'sessions.spawn: sessionManager not initialised');
      return {
        success: false,
        output: 'sessions.spawn: session manager has not been initialised. Call injectMetaToolDeps() with a sessionManager before using this tool.',
      };
    }

    const agentLoop = getAgentLoop() as AgentLoopLike | null;
    if (!agentLoop) {
      logger.warn({ session: ctx.sessionId }, 'sessions.spawn: agentLoop not initialised');
      return {
        success: false,
        output: 'sessions.spawn: agent loop has not been initialised. Call injectMetaToolDeps() with an agentLoop before using this tool.',
      };
    }

    // ------------------------------------------------------------------
    // Commit budget increments SYNCHRONOUSLY before any await.
    // This closes the TOCTOU race: without this, multiple concurrent
    // calls all pass the checks above then each see the same counter
    // values before any of them increments. Incrementing here (same JS
    // tick as the checks) ensures subsequent concurrent calls see the
    // updated counters immediately.
    //
    // concurrentSpawns is decremented in the finally block below.
    // spawnCountMap count intentionally stays after a failed run —
    // it tracks attempts per session (abuse signal), not live count.
    // ------------------------------------------------------------------

    // Idempotency (opt-in): a re-dispatched turn must not spawn a SECOND sub-agent
    // for an identical task from the same parent session. Distinct from the
    // announce-back guard below (which dedups the RESULT message, not the run).
    // The claim is held 'pending' for the whole sub-agent run, so a concurrent
    // identical spawn is also suppressed. Confirmed on success, released on error.
    const spawnIdemOn = isCommsIdempotencyEnabled();
    let spawnClaim: { key: string; duplicate: boolean } | null = null;
    if (spawnIdemOn) {
      try {
        spawnClaim = getCommsIdempotencyStore().begin({ channel: 'spawn', recipient: ctx.sessionId ?? 'root', body: task });
      } catch (err) {
        logger.warn({ session: ctx.sessionId, err: String(err) }, 'sessions.spawn: idempotency begin failed — spawning unguarded (fail-open)');
      }
      if (spawnClaim?.duplicate) {
        logger.warn({ session: ctx.sessionId, key: spawnClaim.key }, 'sessions.spawn: duplicate spawn suppressed (idempotency)');
        return {
          success: true,
          output: 'sessions.spawn: duplicate suppressed — an identical task was already spawned from this session within the idempotency window.',
          data: { task, duplicate: true },
        };
      }
    }

    concurrentSpawns++;
    spawnCountMap.set(ctx.sessionId, { count: currentCount + 1, lastAt: Date.now() });

    try {
      // Resolve or create a session for the given channel + peer.
      const resolvedChannel = channel ?? 'web';
      const resolvedPeer = peerId ?? `sub:${ctx.sessionId}`;
      const session = await sessionManager.getOrCreate(resolvedChannel, resolvedPeer);
      const sessionId = String(session.id);

      // Record depth for the new child session.
      // Must happen after getOrCreate because we need the session ID.
      const childDepth = currentDepth + 1;
      depthMap.set(sessionId, childDepth);

      logger.info({ session: ctx.sessionId, spawnedSession: sessionId, depth: childDepth }, 'Session resolved for spawn');

      const result = await agentLoop.run(sessionId, task);

      logger.info({ session: ctx.sessionId, spawnedSession: sessionId }, 'Agent session completed');

      // Announce-back: send the sub-agent result to the parent session (non-fatal).
      if (announceBack && ctx.sessionId?.trim()) {
        try {
          const channelRouter = getChannelRouter() as ChannelRouterLike | null;
          if (channelRouter) {
            const announcement = `[Sub-agent result for: ${task}]\n\n${result.text}`;
            // Idempotency guard (opt-in): a re-dispatched spawn must not
            // re-announce an identical result to the same parent session.
            const idemOn = isCommsIdempotencyEnabled();
            const claim = idemOn
              ? getCommsIdempotencyStore().begin({ channel: resolvedChannel, recipient: ctx.sessionId, body: announcement })
              : null;
            if (claim?.duplicate) {
              logger.warn({ session: ctx.sessionId, key: claim.key }, 'sessions.spawn: duplicate announce-back suppressed (idempotency)');
            } else {
              try {
                await channelRouter.send(resolvedChannel, ctx.sessionId, announcement);
                if (claim) getCommsIdempotencyStore().confirm(claim.key);
                logger.info({ session: ctx.sessionId, spawnedSession: sessionId }, 'Announce-back sent to parent session');
              } catch (sendErr) {
                if (claim) getCommsIdempotencyStore().release(claim.key); // allow retry of a genuine failure
                throw sendErr;
              }
            }
          } else {
            logger.warn({ session: ctx.sessionId }, 'sessions.spawn: channelRouter not available — skipping announce-back');
          }
        } catch (announceErr) {
          const announceMsg = announceErr instanceof Error ? announceErr.message : String(announceErr);
          logger.warn({ session: ctx.sessionId, err: announceMsg }, 'sessions.spawn: announce-back failed (non-fatal)');
        }
      }

      if (spawnClaim) { try { getCommsIdempotencyStore().confirm(spawnClaim.key, sessionId); } catch { /* confirm best-effort */ } }
      return {
        success: true,
        output: `Agent session spawned successfully. Session ID: ${sessionId}\n\nOutput:\n${result.text}`,
        data: { sessionId, task, channel: resolvedChannel, peerId: resolvedPeer, depth: childDepth },
      };
    } catch (err) {
      // Release the idempotency claim so a genuine retry of a failed spawn proceeds.
      if (spawnClaim) { try { getCommsIdempotencyStore().release(spawnClaim.key); } catch { /* release best-effort */ } }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ session: ctx.sessionId, err: msg }, 'sessions.spawn error');
      return { success: false, output: `sessions.spawn error: ${msg}` };
    } finally {
      concurrentSpawns--;
    }
  },
};
