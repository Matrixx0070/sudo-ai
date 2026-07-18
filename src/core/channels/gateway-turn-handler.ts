/**
 * @file gateway-turn-handler.ts
 * @description ONE turn handler for every channel (Multi-Channel Gateway,
 * Feature 1 — Step 4 "extract the duplicated turn handler into ONE handler").
 *
 * The per-channel turn loop (approval-consume → slash-directive short-circuit →
 * per-peer serialize → run the agent → stale-drop → daily-log → journal → reply
 * → error-reply) was copy-pasted ~90 lines each into the Telegram, Discord,
 * Slack, WhatsApp and routed-channel wiring, and the copies had already drifted
 * (Discord gained approval+directive; the router gained mention-gating). This is
 * the single implementation; each channel supplies only what differs via config.
 *
 * BEHAVIOUR-PRESERVING: every optional step runs only when its dep is provided,
 * so wiring a channel with its current dep set reproduces its exact behaviour —
 * this is a dedup, not a feature change. `serialize` distinguishes the two
 * enqueue models: ad-hoc channels serialize here on the session peerQueue; the
 * MessageRouter already serializes before calling the handler, so it passes
 * serialize:false to avoid double-queueing.
 */

import { createLogger } from '../shared/logger.js';
import { getRunRegistry } from '../agent/run-registry.js';
import { getRunLanes, type RunLane } from '../agent/run-lanes.js';
import { getSteerBuffer } from '../agent/steer-buffer.js';
import { getQueueModeStore, decideQueueMode } from './queue-modes.js';
import type { MessageHandler, UnifiedMessage } from './types.js';
import type { JournalEvent } from '../sessions/journal-types.js';

const log = createLogger('channels:gateway-turn');

export interface GatewayTurnDeps {
  /** Resolve/append sessions + the per-peer queue. */
  sessionManager: {
    getOrCreate(channel: string, peerId: string): Promise<{ id: string | number }>;
    appendEvent(sessionId: string, event: JournalEvent): Promise<void>;
    peerQueue: { enqueue(key: string, fn: () => Promise<void>): Promise<void> };
  };
  /** The agent loop. */
  agentLoop: { run(sessionId: string, text: string, onEvent: undefined, opts: { race: boolean; caller?: { isOwner?: boolean; channel?: string; peerId?: string } }): Promise<{ text?: string } | null> };
  /** Run-generation guard so a reply after /reset is dropped. */
  runGenerations: { current(key: string): number; isStale(key: string, gen: number): boolean };
  /** Deliver the reply (and error text) to the channel. */
  send: (msg: UnifiedMessage, text: string) => Promise<void>;

  /** Serialize on the session peerQueue here. false when the router already did. */
  serialize?: boolean;
  /** Daily-log sink (optional). */
  dailyLog?: { append(line: string): Promise<void> };
  /** Skip daily-log for diagnostic/loopback peers (optional). */
  shouldSkipDailyLog?: (peerId: string, peerIp?: string) => boolean;
  /** Group mention gate — return false to ignore a non-addressed group message. */
  mentionGate?: (msg: UnifiedMessage) => boolean;
  /** Approval-reply consumer — return true if the text was an approval (short-circuit). */
  approvalConsume?: (text: string) => boolean;
  /** Slash-directive dispatch — return true if handled (short-circuit). */
  directiveDispatch?: (msg: UnifiedMessage, reply: (text: string) => Promise<void>) => Promise<boolean>;
  /** Append user+assistant events to the session journal (default true). */
  journal?: boolean;
  /** Reply text on turn failure. */
  errorText?: string;
}

const DEFAULT_ERROR = 'Something went wrong. Please try again.';

export function createGatewayTurnHandler(deps: GatewayTurnDeps): MessageHandler {
  const serialize = deps.serialize !== false;
  const journal = deps.journal !== false;
  const errorText = deps.errorText ?? DEFAULT_ERROR;

  const runTurn = async (msg: UnifiedMessage): Promise<void> => {
    const convKey = `${msg.channel}:${msg.peerId}`;
    let laneRelease: (() => void) | null = null;
    try {
      const runGen = deps.runGenerations.current(convKey);
      const session = await deps.sessionManager.getOrCreate(msg.channel, msg.peerId);
      // GW-5/GW-11: register this run so mid-run arrivals can be steered and so
      // one-run-per-session accounting has a source of truth. Unregistered in the
      // finally below.
      getRunRegistry().beginRun({
        key: convKey,
        sessionId: String(session.id),
        tier: msg.isOwner === true ? 'owner' : 'untrusted',
      });
      // GW-11: acquire a global run-lane slot (opt-in SUDO_RUN_LANES_ENABLED=1).
      // Channel turns run in the 'user' lane (default cap 4). The user lane never
      // drops — it queues. Released in the finally below.
      if (process.env['SUDO_RUN_LANES_ENABLED'] === '1') {
        const lane: RunLane = 'user';
        laneRelease = await getRunLanes().acquireRunSlot(convKey, lane);
      }
      // Bind the Feature 1 caller identity to THIS turn so ToolContext carries
      // isOwner for owner-only tool gating — covers every router channel
      // (telegram/signal/slack/…), not just web. Turn-scoped (no shared registry).
      const result = await deps.agentLoop.run(String(session.id), msg.text ?? '', undefined, {
        race: true,
        caller: { isOwner: msg.isOwner === true, channel: msg.channel, peerId: msg.peerId },
      });
      if (deps.runGenerations.isStale(convKey, runGen)) {
        log.info({ channel: msg.channel, peerId: msg.peerId }, 'Run generation changed mid-turn (e.g. /reset) — discarding stale reply');
        return;
      }
      const replyText = result?.text ?? 'No response generated.';

      if (deps.dailyLog) {
        const skip = deps.shouldSkipDailyLog?.(msg.peerId, msg.peerIp) ?? false;
        if (!skip) {
          try {
            await deps.dailyLog.append(`**User (${msg.channel}):** ${(msg.text ?? '').slice(0, 200)}\n**Agent:** ${replyText.slice(0, 500)}`);
          } catch { /* daily log is non-fatal */ }
        }
      }

      if (journal) {
        try {
          const ts = new Date().toISOString();
          await deps.sessionManager.appendEvent(String(session.id), { ts, sessionId: String(session.id), type: 'message', role: 'user', content: msg.text ?? '' });
          await deps.sessionManager.appendEvent(String(session.id), { ts, sessionId: String(session.id), type: 'message', role: 'assistant', content: replyText });
        } catch { /* journal is non-fatal */ }
      }

      await deps.send(msg, replyText);
      log.info({ channel: msg.channel, peerId: msg.peerId }, 'Reply sent');
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), channel: msg.channel, peerId: msg.peerId }, 'Agent turn failed');
      try { await deps.send(msg, errorText); } catch { /* best effort */ }
    } finally {
      if (laneRelease) laneRelease();
      getRunRegistry().endRun(convKey);
    }
  };

  return async (msg: UnifiedMessage): Promise<void> => {
    // 1. Group mention gate.
    if (deps.mentionGate && !deps.mentionGate(msg)) {
      log.debug({ channel: msg.channel, peerId: msg.peerId }, 'Group message not addressed to bot — ignored');
      return;
    }
    // 2. Approval reply — must bypass the turn queue (a reply queued behind the
    //    turn awaiting it would deadlock).
    if (deps.approvalConsume && deps.approvalConsume(msg.text ?? '')) {
      log.info({ channel: msg.channel, peerId: msg.peerId }, 'Approval reply consumed — not queued as a turn');
      return;
    }
    // 3. Slash directive — short-circuits the agent turn.
    if (deps.directiveDispatch && await deps.directiveDispatch(msg, (text) => deps.send(msg, text))) {
      return;
    }
    // 3b. GW-5 mid-run steering. If a run is already active for this session and
    //     steering is enabled, decide steer/followup/collect/interrupt instead of
    //     blindly queueing a full new turn behind it. Registered commands and
    //     directives already short-circuited above; media is excluded here.
    if (process.env['SUDO_MIDRUN_STEER'] === '1') {
      const convKey = `${msg.channel}:${msg.peerId}`;
      const active = getRunRegistry().get(convKey);
      if (active) {
        const decision = decideQueueMode({
          mode: getQueueModeStore().resolve(msg.channel, msg.peerId),
          activeRun: true,
          isMedia: (msg.media?.length ?? 0) > 0,
          isCommand: false,
          runTier: active.tier,
          msgTier: msg.isOwner === true ? 'owner' : 'untrusted',
        });
        if (decision.action === 'steer') {
          getSteerBuffer().push(active.sessionId, msg.text ?? '', decision.tier);
          log.info(
            { channel: msg.channel, peerId: msg.peerId, tier: decision.tier },
            'GW-5: message steered into the active run (not queued as a new turn)',
          );
          return;
        }
        if (decision.action === 'interrupt' && active.abort) {
          active.abort('interrupted by a newer message');
          // fall through to enqueue the replacement turn.
        }
        // followup / collect / normal → fall through to the normal enqueue path.
      }
    }

    // 4. Run the turn (optionally serialized per peer).
    if (serialize) {
      await deps.sessionManager.peerQueue.enqueue(msg.peerId, () => runTurn(msg)).catch((err) => {
        log.error({ err: String(err), channel: msg.channel, peerId: msg.peerId }, 'Queued agent turn failed');
      });
    } else {
      await runTurn(msg);
    }
  };
}
