/**
 * ApprovalManager — manages human-in-the-loop confirmation for dangerous tool calls.
 *
 * Before executing any tool with requiresConfirmation=true, the agent loop
 * calls requestApproval(). The manager sends a formatted prompt to the user
 * via the appropriate channel and waits up to 60 seconds for a YES/NO reply.
 *
 * Channel strategies:
 *   - telegram: sends inline keyboard (Approve / Deny) via injected bot reference
 *   - headless:  auto-approves with a warning log
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import type { HookManager } from '../hooks/index.js';

const log = createLogger('agent:approval');

const APPROVAL_TIMEOUT_MS = 60_000 as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingApproval {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  /** Risk score 0-10 for this approval request (0=safe, 10=critical). */
  riskScore: number;
  channel: string;
  peerId: string;
  createdAt: number;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal interface for sending a message back to the user.
 * Implemented by TelegramAdapter and any other channel adapter.
 */
export interface ApprovalSender {
  send(peerId: string, text: string, options?: Record<string, unknown>): Promise<void>;
}

// ---------------------------------------------------------------------------
// ApprovalManager
// ---------------------------------------------------------------------------

export class ApprovalManager {
  private readonly pending: Map<string, PendingApproval> = new Map();
  private senders: Map<string, ApprovalSender> = new Map();
  /** Optional HookManager for emitting 'tool:approved' / 'tool:denied' events. */
  private hookManager: HookManager | null = null;

  /**
   * Register a channel sender so approval prompts can be delivered.
   * Call once at startup for each active channel adapter.
   */
  registerSender(channel: string, sender: ApprovalSender): void {
    if (!channel) throw new TypeError('registerSender: channel must be non-empty');
    if (!sender || typeof sender.send !== 'function') {
      throw new TypeError('registerSender: sender must have a send() method');
    }
    this.senders.set(channel, sender);
    log.info({ channel }, 'Approval sender registered');
  }

  /**
   * Attach a HookManager so approval decisions emit 'tool:approved' and
   * 'tool:denied' lifecycle events.
   *
   * @param hookManager - The application-wide HookManager instance.
   */
  setHookManager(hookManager: HookManager): void {
    if (!hookManager || typeof hookManager.emit !== 'function') {
      throw new TypeError('setHookManager: hookManager must have an emit() method');
    }
    this.hookManager = hookManager;
    log.info('ApprovalManager: HookManager attached');
  }

  /**
   * Request user approval before a dangerous tool executes.
   *
   * Emits 'tool:approved' or 'tool:denied' hook events when a HookManager
   * has been attached via `setHookManager()`.
   *
   * @param toolName  - Name of the tool requesting confirmation.
   * @param params    - Parameters the tool will be called with.
   * @param channel   - Originating channel (e.g. "telegram").
   * @param peerId    - User/peer ID to send the confirmation request to.
   * @param riskScore - Risk score 0-10 for this action (default: 5).
   * @returns true if the user approved, false if denied or timed out.
   */
  async requestApproval(
    toolName: string,
    params: Record<string, unknown>,
    channel: string,
    peerId: string,
    riskScore = 5,
  ): Promise<boolean> {
    if (!toolName) throw new TypeError('requestApproval: toolName must be non-empty');

    // Clamp riskScore to [0, 10].
    const clampedRisk = Math.max(0, Math.min(10, riskScore));

    const approvalId = genId();
    const sender = this.senders.get(channel);

    // Headless / no sender registered → auto-approve with a warning.
    if (!sender) {
      log.warn(
        { toolName, channel, params, riskScore: clampedRisk },
        'No approval sender for channel — auto-approving (headless mode)',
      );
      void this._emitHook('tool:approved', toolName, params, clampedRisk);
      return true;
    }

    const paramsStr = JSON.stringify(params, null, 2);
    const prompt =
      `SUDO-AI wants to execute a sensitive tool:\n\n` +
      `Tool: ${toolName}\n` +
      `Risk score: ${clampedRisk}/10\n` +
      `Params:\n${paramsStr}\n\n` +
      `Reply YES to approve or NO to deny.\n` +
      `(approval-id: ${approvalId} — expires in 60s)`;

    log.info({ approvalId, toolName, channel, peerId, riskScore: clampedRisk }, 'Sending approval request to user');

    try {
      await sender.send(peerId, prompt);
    } catch (err) {
      log.error({ approvalId, toolName, err }, 'Failed to send approval request — auto-denying');
      void this._emitHook('tool:denied', toolName, params, clampedRisk);
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(approvalId)) {
          this.pending.delete(approvalId);
          log.warn({ approvalId, toolName }, 'Approval request timed out — denying');
          void this._emitHook('tool:denied', toolName, params, clampedRisk);
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);

      this.pending.set(approvalId, {
        id: approvalId,
        toolName,
        params,
        riskScore: clampedRisk,
        channel,
        peerId,
        createdAt: Date.now(),
        resolve: (approved: boolean) => {
          void this._emitHook(
            approved ? 'tool:approved' : 'tool:denied',
            toolName,
            params,
            clampedRisk,
          );
          resolve(approved);
        },
        timer,
      });
    });
  }

  /**
   * Handle a user's approval response — resolves the pending promise.
   *
   * Call this from the channel message handler when the user replies to an
   * approval request. The response text is matched case-insensitively.
   *
   * @param approvalId - The approval ID extracted from the user's reply.
   * @param approved   - true = user said YES, false = user said NO.
   * @returns true if an active pending approval was found and resolved.
   */
  handleResponse(approvalId: string, approved: boolean): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      log.warn({ approvalId }, 'handleResponse: no pending approval found for this ID');
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(approvalId);

    log.info(
      { approvalId, toolName: pending.toolName, approved },
      'Approval response received',
    );

    pending.resolve(approved);
    return true;
  }

  /**
   * Parse a user message for an inline approval reply.
   *
   * Looks for pattern: (approval-id: <id>) with YES or NO in the message.
   * Returns null if no match found.
   */
  parseApprovalReply(text: string): { approvalId: string; approved: boolean } | null {
    if (!text) return null;

    const idMatch = text.match(/approval-id:\s*([A-Za-z0-9_-]+)/i);
    if (!idMatch?.[1]) return null;

    const approvalId = idMatch[1];
    const upper = text.toUpperCase();
    // Match whole-word YES/NO tokens so substrings like "YESTERDAY" or
    // "KNOW"/"NORTH" do not get misread as a decision.
    const approved = /\bYES\b/.test(upper);
    const denied = /\bNO\b/.test(upper);

    // Ambiguous (both or neither present) → no decision.
    if (approved === denied) return null;

    return { approvalId, approved };
  }

  /**
   * Inbound admission guard: consume a chat message when it is a decision on
   * a pending approval. Returns true if the message was consumed — callers
   * must NOT enqueue it as an agent turn, because the per-peer queue is
   * blocked by the very turn that is awaiting this approval (queueing the
   * reply behind it would deadlock until the 60 s timeout denies).
   *
   * Non-matching messages, ambiguous replies, and replies to unknown/expired
   * approval IDs all return false so the message proceeds as a normal turn.
   */
  tryConsumeApprovalReply(text: string | undefined | null): boolean {
    if (!text || this.pending.size === 0) return false;
    const parsed = this.parseApprovalReply(text);
    if (!parsed) return false;
    // Unknown/expired ID → not consumed (and no handleResponse warn noise:
    // a user quoting an old prompt is normal traffic, not an error).
    if (!this.pending.has(parsed.approvalId)) return false;
    return this.handleResponse(parsed.approvalId, parsed.approved);
  }

  /** Return the count of currently pending approvals. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Cancel all pending approvals (called on shutdown). */
  cancelAll(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(false);
      log.info({ approvalId: id }, 'Pending approval cancelled (shutdown)');
    }
    this.pending.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Emit a 'tool:approved' or 'tool:denied' hook event if a HookManager is
   * attached. Errors from hook handlers are swallowed to avoid crashing the
   * approval flow.
   */
  private async _emitHook(
    event: 'tool:approved' | 'tool:denied',
    toolName: string,
    args: Record<string, unknown>,
    riskScore: number,
  ): Promise<void> {
    if (!this.hookManager) return;
    try {
      await this.hookManager.emit(event, {
        event,
        toolName,
        args,
        meta: { riskScore },
      });
    } catch (err) {
      log.error({ event, toolName, err: String(err) }, 'Hook emission failed in ApprovalManager');
    }
  }
}

/** Module-level singleton for use across the application. */
export const approvalManager = new ApprovalManager();
