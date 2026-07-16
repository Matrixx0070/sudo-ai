/**
 * @file sessions-send.ts
 * @description sessions.send (Spec 6) — one session messages another. Resolves a
 * target session, enforces ACL (owner-tier only) + size + hop-depth + cycle,
 * injects a clear envelope, and delivers by running a turn on the target via the
 * injected agentLoop (which also wakes an idle target). Optional waitForReply
 * returns the target's reply (or a clean timeout). The delivered turn inherits
 * the origin's owner tier so a multi-agent pipeline stays same-owner.
 *
 * Targets by session id OR by friendly agent name (channel:peerId / peerId of an
 * active session — resolveTargetSession); durable offline queue via deliverMode.
 * Reuses the meta-tool deps already injected for sessions.spawn.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { getSessionManager, getAgentLoop } from './index.js';
import { checkAndAdvance, setSendChain, clearSendChain, buildEnvelope, auditSend, enqueueForTarget, isInflight, markInflight, clearInflight } from '../../../agents/session-bus.js';

const logger = createLogger('meta.sessions.send');
const MAX_MESSAGE_BYTES = 32 * 1024;
const DEFAULT_WAIT_MS = 120_000;

interface SessionSummary { id: string | number; channel?: string; peerId?: string }
interface SessionManagerLike {
  get(sessionId: string): Promise<{ id: string | number } | undefined>;
  /** Optional — enables friendly-name resolution (channel:peerId / peerId). */
  listActive?(): Promise<SessionSummary[]>;
}

/**
 * Resolve a target to a canonical session id. Tries an exact session id first
 * (back-compat), then falls back to a friendly NAME matched against active
 * sessions: an exact `channel:peerId`, else a bare `peerId`. Ambiguous bare names
 * (same peerId on multiple channels) return an error listing the candidates so
 * the caller can qualify with `channel:peerId`.
 */
async function resolveTargetSession(sm: SessionManagerLike, target: string): Promise<{ id: string } | { error: string }> {
  const byId = await sm.get(target).catch(() => undefined);
  if (byId) return { id: String(byId.id) };
  if (typeof sm.listActive !== 'function') return { error: `unknown target session "${target}".` };

  const active = await sm.listActive().catch(() => [] as SessionSummary[]);
  const t = target.toLowerCase();
  const full = active.filter((s) => `${s.channel}:${s.peerId}`.toLowerCase() === t);
  if (full.length === 1) return { id: String(full[0]!.id) };
  const byPeer = active.filter((s) => String(s.peerId).toLowerCase() === t);
  if (byPeer.length === 1) return { id: String(byPeer[0]!.id) };

  const matches = byPeer.length > 0 ? byPeer : full;
  if (matches.length > 1) {
    const cands = matches.slice(0, 8).map((s) => `${s.channel}:${s.peerId}`).join(', ');
    return { error: `ambiguous target "${target}" — matches ${matches.length} sessions (${cands}). Use a specific "channel:peerId" or the session id.` };
  }
  return { error: `unknown target session "${target}".` };
}
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
    targetSessionId: { type: 'string', required: true, description: 'The target: a session id, OR a friendly agent name — the "channel:peerId" (e.g. "web:researcher") or bare "peerId" of an active session (e.g. one from sessions.spawn). Ambiguous bare names are rejected with the candidates.' },
    message: { type: 'string', required: true, description: 'The message/handoff content for the target session.' },
    waitForReply: { type: 'boolean', required: false, description: "Await the target's reply (default false = fire-and-forget)." },
    timeoutMs: { type: 'number', required: false, description: 'Reply timeout in ms when waitForReply (default 120000).' },
    deliverMode: { type: 'string', required: false, enum: ['now', 'queue'], description: '"now" (default) runs the target immediately; "queue" persists the message for the target to pick up on its NEXT run (offline handoff).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const targetInput = typeof params['targetSessionId'] === 'string' ? params['targetSessionId'].trim() : '';
    const message = typeof params['message'] === 'string' ? params['message'] : '';
    const waitForReply = params['waitForReply'] === true;
    const timeoutMs = typeof params['timeoutMs'] === 'number' && params['timeoutMs'] > 0 ? params['timeoutMs'] : DEFAULT_WAIT_MS;

    // ACL: owner-tier sessions only. A KNOWN non-owner is refused; unknown
    // identity (internal/autonomous turns) is allowed (channel policy is the
    // authoritative per-caller gate, per Spec 3).
    if (ctx.isOwner === false) {
      auditSend({ event: 'blocked-acl', from: ctx.sessionId, target: targetInput });
      return { success: false, output: 'sessions.send: refused — only owner-tier sessions may message other sessions.' };
    }
    if (!targetInput || !message) {
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

    // Resolve target: a raw session id OR a friendly name (channel:peerId /
    // peerId of an active session). Unknown/ambiguous → tool error (acceptance 3).
    const resolved = await resolveTargetSession(sm, targetInput);
    if ('error' in resolved) {
      return { success: false, output: `sessions.send: ${resolved.error}` };
    }
    const targetSessionId = resolved.id;

    // Hop-depth + cycle (acceptance 4).
    const gate = checkAndAdvance(ctx.sessionId, targetSessionId);
    if (!gate.ok) {
      auditSend({ event: 'blocked-hop', from: ctx.sessionId, target: targetSessionId, reason: gate.reason });
      return { success: false, output: `sessions.send: ${gate.reason}` };
    }
    // Stamp the advanced chain on the target so ITS onward sends are gated too.
    setSendChain(targetSessionId, gate.next!);

    const envelope = buildEnvelope(ctx.sessionId, ctx.channel, message);

    // Offline handoff OR target already running: persist for the target's next
    // run instead of starting a CONCURRENT turn (which would corrupt its state).
    const targetBusy = isInflight(targetSessionId);
    if (params['deliverMode'] === 'queue' || targetBusy) {
      enqueueForTarget(targetSessionId, ctx.sessionId, envelope);
      auditSend({ event: 'queued', from: ctx.sessionId, target: targetSessionId, depth: gate.next!.depth, reason: targetBusy ? 'busy' : 'requested' });
      return {
        success: true,
        output: targetBusy
          ? `Session ${targetSessionId} is busy — queued; delivered on its next run.`
          : `Queued for session ${targetSessionId} — delivered on its next run.`,
        data: { targetSessionId, queued: true, busy: targetBusy, depth: gate.next!.depth },
      };
    }

    // The delivered turn inherits the origin's owner tier (same-owner pipeline).
    const runOpts = { race: true, caller: { isOwner: ctx.isOwner, channel: 'session', peerId: ctx.sessionId } };
    auditSend({ event: 'deliver', from: ctx.sessionId, target: targetSessionId, waitForReply, depth: gate.next!.depth });
    logger.info({ from: ctx.sessionId, target: targetSessionId, waitForReply, depth: gate.next!.depth }, 'sessions.send delivering');

    // The chain is stamped on the target ONLY for the duration of this delivery
    // (so its onward sends are gated), then cleared — never left to poison later.
    markInflight(targetSessionId);
    setSendChain(targetSessionId, gate.next!);
    const runP = loop.run(targetSessionId, envelope, undefined, runOpts)
      .finally(() => { clearInflight(targetSessionId); clearSendChain(targetSessionId); });

    if (!waitForReply) {
      void runP.catch((err) => logger.warn({ target: targetSessionId, err: String(err) }, 'sessions.send background turn failed'));
      return { success: true, output: `Delivered to session ${targetSessionId} (fire-and-forget).`, data: { targetSessionId, delivered: true, depth: gate.next!.depth } };
    }

    // waitForReply: race the target's turn against the timeout (acceptance 2).
    try {
      const raced = await Promise.race([
        runP,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('reply timeout')), timeoutMs)),
      ]);
      return { success: true, output: `Reply from ${targetSessionId}:\n${raced.text}`, data: { targetSessionId, reply: raced.text, depth: gate.next!.depth } };
    } catch (err) {
      const timedOut = err instanceof Error && err.message === 'reply timeout';
      if (!timedOut) void runP.catch(() => {}); // swallow late rejection (finally already cleared state)
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
