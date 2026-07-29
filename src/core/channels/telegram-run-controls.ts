/**
 * @file telegram-run-controls.ts
 * @description TX1/TX2 — pure pieces for the Telegram run-control surface.
 *
 * TX1 (`SUDO_TG_STOP_BUTTON=1`, default OFF): the live working card carries a
 * single ⏹ Stop inline button. Tapping it (owner-only) resolves the active run
 * via the run-registry and calls its abort seam; the loop honors the abort at
 * the next safe ITERATION BOUNDARY (post-tool / pre-model-call — the steering
 * channel contract), so a stop mid-tool finishes that tool first. The card then
 * finalizes to `⏹ Stopped • 40s • 3 steps`.
 *
 * TX2 (`SUDO_TG_BAD_REGEN=1`, default OFF): tapping 👎 Bad swaps the feedback
 * keyboard for one-tap reasons (Wrong / Too long / Missed the point / Skip
 * reasons); a reason tap triggers exactly ONE bounded regeneration per
 * feedbackId (RegenGuard) through the injectable `onRegenerate` seam the cli
 * wires up (the adapter cannot reach the agent loop).
 *
 * Everything except `handleRunControlCallback` is pure (no I/O, no env reads);
 * the handler takes its collaborators via `RunControlDeps` so it unit-tests
 * without a grammy bot (house pattern: telegram-command-intercept.test.ts).
 */

import { InlineKeyboard } from 'grammy';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:tg-run-controls');

// ---------------------------------------------------------------------------
// TX1 — Stop button
// ---------------------------------------------------------------------------

/** Callback-data prefix for the working-card Stop button. */
export const STOP_CALLBACK_PREFIX = 'tx1:stop:';

/**
 * Inline keyboard for the working card: a single ⏹ Stop button whose callback
 * data carries the run-registry key (`channel:peerId` — colons allowed, the
 * parser treats everything after the prefix as the key).
 */
export function makeStopKeyboard(runKey: string): InlineKeyboard {
  return new InlineKeyboard().text('⏹ Stop', `${STOP_CALLBACK_PREFIX}${runKey}`);
}

/** `tx1:stop:<runKey>` → runKey, or null when the data is not a stop tap. */
export function parseStopCallback(data: string): string | null {
  if (typeof data !== 'string' || !data.startsWith(STOP_CALLBACK_PREFIX)) return null;
  const key = data.slice(STOP_CALLBACK_PREFIX.length);
  return key.length > 0 ? key : null;
}

/** "47s" under a minute, "1m 05s" past it (mirrors activity-timeline). */
function fmtElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

/**
 * Final text for a stopped working card: `⏹ Stopped • 40s • 3 steps`.
 * Mirrors ActivityTimeline.renderFinal (kept separate so the stopped card
 * renders even when the timeline was never constructed).
 */
export function renderStoppedCard(input: { elapsedMs: number; steps: number }): string {
  const secs = Math.max(0, Math.round((Number.isFinite(input.elapsedMs) ? input.elapsedMs : 0) / 1000));
  const parts = [`⏹ Stopped • ${fmtElapsed(secs)}`];
  if (input.steps > 0) parts.push(`${input.steps} step${input.steps === 1 ? '' : 's'}`);
  return parts.join(' • ');
}

// ---------------------------------------------------------------------------
// TX2 — 👎 reasons + regeneration
// ---------------------------------------------------------------------------

/** Callback-data prefix for the one-tap 👎 reason buttons. */
export const REASON_CALLBACK_PREFIX = 'tx2:reason:';

/** Reason codes on the wire (kept short — Telegram caps callback data at 64 bytes). */
export type RegenReasonCode = 'wrong' | 'long' | 'missed' | 'skip';

/** Human labels, reused for the buttons and the revision instruction. */
export const REGEN_REASON_LABELS: Readonly<Record<RegenReasonCode, string>> = {
  wrong: 'Wrong',
  long: 'Too long',
  missed: 'Missed the point',
  skip: 'Skip reasons',
};

const REASON_CODES: readonly RegenReasonCode[] = ['wrong', 'long', 'missed', 'skip'];

/** One-tap reason keyboard swapped in after 👎 Bad. Every tap regenerates; "Skip reasons" regenerates without a stated reason. */
export function makeReasonKeyboard(feedbackId: string): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(REGEN_REASON_LABELS.wrong, `${REASON_CALLBACK_PREFIX}${feedbackId}:wrong`)
    .text(REGEN_REASON_LABELS.long, `${REASON_CALLBACK_PREFIX}${feedbackId}:long`)
    .row()
    .text(REGEN_REASON_LABELS.missed, `${REASON_CALLBACK_PREFIX}${feedbackId}:missed`)
    .text(REGEN_REASON_LABELS.skip, `${REASON_CALLBACK_PREFIX}${feedbackId}:skip`);
  return kb;
}

/** `tx2:reason:<feedbackId>:<code>` → parts, or null. Rejects unknown codes and empty ids. */
export function parseReasonCallback(data: string): { feedbackId: string; code: RegenReasonCode } | null {
  if (typeof data !== 'string' || !data.startsWith(REASON_CALLBACK_PREFIX)) return null;
  const rest = data.slice(REASON_CALLBACK_PREFIX.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0) return null;
  const feedbackId = rest.slice(0, sep);
  const code = rest.slice(sep + 1) as RegenReasonCode;
  if (!feedbackId || !(REASON_CODES as readonly string[]).includes(code)) return null;
  return { feedbackId, code };
}

/**
 * At-most-one regeneration per feedbackId (no regen-of-regen loops: the fresh
 * keyboard on a v2 reply carries a NEW feedbackId, so the owner can 👎 again —
 * each rejected reply regenerates at most once). Bounded so a long-lived
 * process never grows without limit.
 */
export class RegenGuard {
  private readonly used = new Set<string>();
  private readonly cap: number;

  constructor(cap = 500) { this.cap = cap; }

  /** True exactly once per id; false on every later call. */
  tryAcquire(feedbackId: string): boolean {
    if (!feedbackId || this.used.has(feedbackId)) return false;
    if (this.used.size >= this.cap) {
      // Drop the oldest half — insertion order is tap order.
      let drop = Math.ceil(this.cap / 2);
      for (const id of this.used) {
        this.used.delete(id);
        if (--drop <= 0) break;
      }
    }
    this.used.add(feedbackId);
    return true;
  }
}

/** Payload the injectable regeneration seam receives (adapter → cli wiring). */
export interface RegenerateRequest {
  /** Sender's user id — the session/queue key on the bespoke Telegram path. */
  peerId: string;
  /** Chat the rejected reply lives in (group id in groups). */
  chatId: string;
  /** Telegram message_id of the rejected reply — edited in place with v2. */
  messageId: number;
  feedbackId: string;
  /** Human-readable reason label ('' when the owner skipped reasons). */
  reason: string;
  /** Text of the rejected reply as Telegram reported it ('' if unavailable). */
  originalText: string;
}

/**
 * The bounded revision instruction for the regeneration turn. A normal
 * loop.run input: system-style, carries the rejected reply + the reason,
 * asks for a revised answer only.
 */
export function buildRegenInstruction(input: { originalText: string; reason: string }): string {
  const original = (input.originalText ?? '').trim().slice(0, 3000);
  const reason = (input.reason ?? '').trim();
  const withReason = reason && reason !== REGEN_REASON_LABELS.skip ? ` Reason: ${reason}.` : '';
  return [
    // Phrased as a plain owner instruction: a `[system]`-style prefix here trips
    // our OWN prompt-injection detector (fake_system_tag, severity high, seen
    // live 2026-07-29) and pollutes security telemetry with false positives.
    `I'm rejecting your previous reply (👎).${withReason}`,
    'Rejected reply:',
    '"""',
    original || '(original text unavailable)',
    '"""',
    'Write a revised answer that fixes the problem. Respond with the revised answer only — no apology, no meta-commentary about this instruction, and no tool calls unless strictly necessary.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Callback dispatch (thin, dependency-injected — grammy-free for tests)
// ---------------------------------------------------------------------------

/** The slice of a grammy callback_query ctx the dispatcher needs. */
export interface RunControlCtx {
  data: string;
  fromId: string;
  chatId?: string;
  messageId?: number;
  /** Text of the message carrying the tapped keyboard (Telegram omits it for old messages). */
  messageText?: string;
  answer(text?: string): Promise<void>;
  /** Replace (or with undefined: remove) the tapped message's inline keyboard. */
  editReplyMarkup(kb: InlineKeyboard | undefined): Promise<void>;
}

export interface RunControlDeps {
  env?: NodeJS.ProcessEnv;
  isOwner(userId: string): boolean;
  /** Run-registry lookup by `channel:peerId` key. */
  getActiveRun(runKey: string): { abort?: (reason: string) => void } | undefined;
  guard: RegenGuard;
  onRegenerate: ((req: RegenerateRequest) => void | Promise<void>) | null;
  /** Persist the reason marker row (feedback-store convention). Best-effort. */
  recordReason?: (feedbackId: string, code: RegenReasonCode) => void;
}

/**
 * Handle a TX1/TX2 callback tap. Returns true when the callback data belonged
 * to this surface (consumed — even if refused), false → caller falls through
 * to the next handler (fb: feedback taps etc.). Never throws.
 */
export async function handleRunControlCallback(ctx: RunControlCtx, deps: RunControlDeps): Promise<boolean> {
  const env = deps.env ?? process.env;

  // ---- TX1: ⏹ Stop ----
  const runKey = parseStopCallback(ctx.data);
  if (runKey !== null) {
    try {
      if (env['SUDO_TG_STOP_BUTTON'] !== '1') { await ctx.answer('Stop is not enabled.'); return true; }
      if (!deps.isOwner(ctx.fromId)) { await ctx.answer('Only the owner can stop this run.'); return true; }
      const active = deps.getActiveRun(runKey);
      if (!active?.abort) { await ctx.answer('No active run to stop.'); return true; }
      active.abort('stopped by owner (⏹ working-card button)');
      // Boundary semantics: the loop acts on the abort at its next iteration
      // boundary — a long tool call finishes first. The card says "Stopping…".
      await ctx.answer('⏹ Stopping…');
    } catch (err) {
      log.warn({ err: String(err), runKey }, 'TX1 stop callback failed');
      try { await ctx.answer('Could not stop the run.'); } catch { /* best effort */ }
    }
    return true;
  }

  // ---- TX2: 👎 reason tap → regenerate ----
  const reason = parseReasonCallback(ctx.data);
  if (reason !== null) {
    try {
      if (env['SUDO_TG_BAD_REGEN'] !== '1' || !deps.isOwner(ctx.fromId)) {
        await ctx.answer('Not available.');
        return true;
      }
      // Remove the reason keyboard first — double taps then hit the guard.
      try { await ctx.editReplyMarkup(undefined); } catch { /* old message — non-fatal */ }
      if (!deps.guard.tryAcquire(reason.feedbackId)) {
        await ctx.answer('Already regenerated this reply once.');
        return true;
      }
      try { deps.recordReason?.(reason.feedbackId, reason.code); } catch { /* marker row is best-effort */ }
      if (!deps.onRegenerate || ctx.messageId === undefined) {
        await ctx.answer('Regeneration unavailable.');
        return true;
      }
      await ctx.answer('↻ Regenerating…');
      const req: RegenerateRequest = {
        peerId: ctx.fromId,
        chatId: ctx.chatId ?? ctx.fromId,
        messageId: ctx.messageId,
        feedbackId: reason.feedbackId,
        reason: reason.code === 'skip' ? '' : REGEN_REASON_LABELS[reason.code],
        originalText: ctx.messageText ?? '',
      };
      // Fire-and-forget: the revision turn serializes on the peer queue in the
      // cli wiring; the callback ack must not wait a full agent turn.
      void Promise.resolve(deps.onRegenerate(req)).catch((err) => {
        log.warn({ err: String(err), feedbackId: reason.feedbackId }, 'TX2 regeneration failed');
      });
    } catch (err) {
      log.warn({ err: String(err), feedbackId: reason.feedbackId }, 'TX2 reason callback failed');
      try { await ctx.answer('Could not start regeneration.'); } catch { /* best effort */ }
    }
    return true;
  }

  return false;
}

/**
 * Should a 👎 Bad tap swap in the one-tap reason keyboard (instead of the
 * legacy remove-keyboard + "reply with details" prompt)? Pure decision.
 */
export function wantsReasonKeyboard(input: {
  env?: NodeJS.ProcessEnv;
  rating: string;
  isOwnerUser: boolean;
  hasRegenHandler: boolean;
}): boolean {
  const env = input.env ?? process.env;
  return env['SUDO_TG_BAD_REGEN'] === '1' && input.rating === 'bad' && input.isOwnerUser && input.hasRegenHandler;
}
