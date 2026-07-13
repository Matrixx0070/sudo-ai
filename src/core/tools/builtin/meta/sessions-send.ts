/**
 * @file sessions-send.ts
 * @description sessions.send (Spec 6) — one session messages another. Resolves a
 * target session, enforces ACL (owner-tier only) + size + hop-depth + cycle,
 * injects a clear envelope, and delivers by running a turn on the target via the
 * injected agentLoop (which also wakes an idle target). Optional waitForReply
 * returns the target's reply (or a clean timeout). The delivered turn inherits
 * the origin's owner tier so a multi-agent pipeline stays same-owner.
 *
 * MVP targets by sessionId (agent-name resolution + durable offline queue are
 * PR2). Reuses the meta-tool deps already injected for sessions.spawn.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { getSessionManager, getAgentLoop } from './index.js';
import { checkAndAdvance, setSendChain, buildEnvelope, auditSend } from '../../../agents/session-bus.js';

const logger = createLogger('meta.sessions.send');
const MAX_MESSAGE_BYTES = 32 * 1024;
const DEFAULT_WAIT_MS = 120_000;

interface SessionManagerLike { get(sessionId: string): Promise<{ id: string | number } | undefined> }
interface AgentLoopLike {
  run(
    sessionId: string,
    message: string,
    onEvent?: undefined,
    opts?: { race?: boolean; caller?: { isOwner?: boolean; channel?: string; peerId?: string } },
  ): Promise<{ text: string }>;
}

export const sessionsSendTool: ToolDefinition = {
  name: 'sessions.send',
  description:
    'Send a message from THIS session to ANOTHER agent session (multi-agent handoff, e.g. researcher → writer). ' +
    'The target receives a clearly-labelled envelope and runs a turn on it. Set waitForReply:true to get the ' +
    "target's reply back (with a timeout). Owner-tier only. Hop depth is capped and cycles are blocked.",
  category: 'meta',
  timeout: 130_000,
  parameters: {
    targetSessionId: { type: 'string', required: true, description: 'The target session id to deliver to.' },
    message: { type: 'string', required: true, description: 'The message/handoff content for the target session.' },
    waitForReply: { type: 'boolean', required: false, description: "Await the target's reply (default false = fire-and-forget)." },
    timeoutMs: { type: 'number', required: false, description: 'Reply timeout in ms when waitForReply (default 120000).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const targetSessionId = typeof params['targetSessionId'] === 'string' ? params['targetSessionId'].trim() : '';
    const message = typeof params['message'] === 'string' ? params['message'] : '';
    const waitForReply = params['waitForReply'] === true;
    const timeoutMs = typeof params['timeoutMs'] === 'number' && params['timeoutMs'] > 0 ? params['timeoutMs'] : DEFAULT_WAIT_MS;

    // ACL: owner-tier sessions only. A KNOWN non-owner is refused; unknown
    // identity (internal/autonomous turns) is allowed (channel policy is the
    // authoritative per-caller gate, per Spec 3).
    if (ctx.isOwner === false) {
      auditSend({ event: 'blocked-acl', from: ctx.sessionId, target: targetSessionId });
      return { success: false, output: 'sessions.send: refused — only owner-tier sessions may message other sessions.' };
    }
    if (!targetSessionId || !message) {
      return { success: false, output: 'sessions.send: "targetSessionId" and "message" are required.' };
    }
    if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
      return { success: false, output: `sessions.send: message exceeds ${MAX_MESSAGE_BYTES} bytes.` };
    }

    const sm = getSessionManager() as SessionManagerLike | null;
    const loop = getAgentLoop() as AgentLoopLike | null;
    if (!sm || !loop) {
      return { success: false, output: 'sessions.send: session manager / agent loop not initialised (injectMetaToolDeps).' };
    }

    // Unknown target → tool error (acceptance 3).
    const target = await sm.get(targetSessionId).catch(() => undefined);
    if (!target) {
      return { success: false, output: `sessions.send: unknown target session "${targetSessionId}".` };
    }

    // Hop-depth + cycle (acceptance 4).
    const gate = checkAndAdvance(ctx.sessionId, targetSessionId);
    if (!gate.ok) {
      auditSend({ event: 'blocked-hop', from: ctx.sessionId, target: targetSessionId, reason: gate.reason });
      return { success: false, output: `sessions.send: ${gate.reason}` };
    }
    // Stamp the advanced chain on the target so ITS onward sends are gated too.
    setSendChain(targetSessionId, gate.next!);

    const envelope = buildEnvelope(ctx.sessionId, ctx.channel, message);
    // The delivered turn inherits the origin's owner tier (same-owner pipeline).
    const runOpts = { race: true, caller: { isOwner: ctx.isOwner, channel: 'session', peerId: ctx.sessionId } };
    auditSend({ event: 'deliver', from: ctx.sessionId, target: targetSessionId, waitForReply, depth: gate.next!.depth });
    logger.info({ from: ctx.sessionId, target: targetSessionId, waitForReply, depth: gate.next!.depth }, 'sessions.send delivering');

    if (!waitForReply) {
      // Fire-and-forget: the target runs its turn in the background.
      void loop.run(targetSessionId, envelope, undefined, runOpts).catch((err) =>
        logger.warn({ target: targetSessionId, err: String(err) }, 'sessions.send background turn failed'),
      );
      return { success: true, output: `Delivered to session ${targetSessionId} (fire-and-forget).`, data: { targetSessionId, delivered: true, depth: gate.next!.depth } };
    }

    // waitForReply: race the target's turn against the timeout (acceptance 2).
    try {
      const raced = await Promise.race([
        loop.run(targetSessionId, envelope, undefined, runOpts),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('reply timeout')), timeoutMs)),
      ]);
      return { success: true, output: `Reply from ${targetSessionId}:\n${raced.text}`, data: { targetSessionId, reply: raced.text, depth: gate.next!.depth } };
    } catch (err) {
      const timedOut = err instanceof Error && err.message === 'reply timeout';
      return {
        success: !timedOut ? false : true,
        output: timedOut
          ? `sessions.send: delivered to ${targetSessionId} but no reply within ${timeoutMs}ms (target may still be working).`
          : `sessions.send: delivery failed — ${err instanceof Error ? err.message : String(err)}`,
        data: { targetSessionId, timedOut },
      };
    }
  },
};
