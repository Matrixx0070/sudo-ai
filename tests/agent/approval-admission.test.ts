/**
 * @file tests/agent/approval-admission.test.ts
 * @description Two-guard inbound admission (gap #9) — tryConsumeApprovalReply.
 *
 * Regression context: parseApprovalReply/handleResponse had zero callers, so
 * every chat approval timed out to deny after 60 s. Worse, a user's "YES"
 * reply was enqueued as a normal turn behind the very turn awaiting the
 * approval — a deadlock until the timeout fired. The admission guard consumes
 * approval replies synchronously BEFORE the per-peer turn queue.
 */

import { describe, it, expect } from 'vitest';
import { ApprovalManager } from '../../src/core/agent/approval.js';
import type { ApprovalSender } from '../../src/core/agent/approval.js';
import { KeyedAsyncQueue } from '../../src/core/sessions/queue.js';

function makeSender(): { sender: ApprovalSender; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    sender: { send: async (_peerId, text) => { sent.push(text); } },
  };
}

function extractApprovalId(prompt: string): string {
  const m = /approval-id:\s*([A-Za-z0-9_-]+)/i.exec(prompt);
  if (!m?.[1]) throw new Error(`no approval-id in prompt: ${prompt}`);
  return m[1];
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ApprovalManager.tryConsumeApprovalReply', () => {
  it('returns false for empty text and for plain messages with nothing pending', () => {
    const mgr = new ApprovalManager();
    expect(mgr.tryConsumeApprovalReply(undefined)).toBe(false);
    expect(mgr.tryConsumeApprovalReply('')).toBe(false);
    expect(mgr.tryConsumeApprovalReply('hello, how are you?')).toBe(false);
    // Even an approval-shaped message passes through when nothing is pending.
    expect(mgr.tryConsumeApprovalReply('YES (approval-id: ghost-1)')).toBe(false);
  });

  it('consumes a YES reply and resolves the pending approval as approved', async () => {
    const mgr = new ApprovalManager();
    const { sender, sent } = makeSender();
    mgr.registerSender('telegram', sender);

    const decision = mgr.requestApproval('system.exec', { command: 'ls' }, 'telegram', 'peer-1');
    await until(() => sent.length === 1);
    const id = extractApprovalId(sent[0]!);

    expect(mgr.tryConsumeApprovalReply(`YES (approval-id: ${id})`)).toBe(true);
    await expect(decision).resolves.toBe(true);
    expect(mgr.pendingCount).toBe(0);
  });

  it('consumes a NO reply and resolves the pending approval as denied', async () => {
    const mgr = new ApprovalManager();
    const { sender, sent } = makeSender();
    mgr.registerSender('telegram', sender);

    const decision = mgr.requestApproval('coder.write-file', { path: '/etc/x' }, 'telegram', 'peer-1');
    await until(() => sent.length === 1);
    const id = extractApprovalId(sent[0]!);

    expect(mgr.tryConsumeApprovalReply(`no thanks (approval-id: ${id})`)).toBe(true);
    await expect(decision).resolves.toBe(false);
  });

  it('does not consume ambiguous or unknown-id replies while something is pending', async () => {
    const mgr = new ApprovalManager();
    const { sender, sent } = makeSender();
    mgr.registerSender('telegram', sender);

    const decision = mgr.requestApproval('system.exec', { command: 'ls' }, 'telegram', 'peer-1');
    await until(() => sent.length === 1);
    const id = extractApprovalId(sent[0]!);

    // Ambiguous: both YES and NO present → no decision, message passes through.
    expect(mgr.tryConsumeApprovalReply(`YES or NO? (approval-id: ${id})`)).toBe(false);
    // Unknown ID → passes through as a normal turn.
    expect(mgr.tryConsumeApprovalReply('YES (approval-id: not-a-real-id)')).toBe(false);
    expect(mgr.pendingCount).toBe(1);

    expect(mgr.tryConsumeApprovalReply(`YES (approval-id: ${id})`)).toBe(true);
    await expect(decision).resolves.toBe(true);
  });

  it('unblocks a turn awaiting approval inside the per-peer queue (deadlock regression)', async () => {
    const mgr = new ApprovalManager();
    const { sender, sent } = makeSender();
    mgr.registerSender('telegram', sender);
    const queue = new KeyedAsyncQueue();

    // Turn 1 holds the per-peer queue while awaiting approval — exactly the
    // state a real agent turn is in when a requiresConfirmation tool fires.
    const turn = queue.enqueue('peer-1', async () =>
      mgr.requestApproval('system.exec', { command: 'rm -rf /tmp/x' }, 'telegram', 'peer-1'),
    );
    await until(() => sent.length === 1);
    const id = extractApprovalId(sent[0]!);

    // The old wiring enqueued the reply as a turn: it would sit behind `turn`
    // forever (until the 60 s timeout denied). The admission guard consumes
    // it synchronously, outside the queue.
    expect(mgr.tryConsumeApprovalReply(`YES (approval-id: ${id})`)).toBe(true);
    await expect(turn).resolves.toBe(true);

    // The queue is healthy afterwards: the next turn for the peer runs.
    await expect(queue.enqueue('peer-1', async () => 'next-turn')).resolves.toBe('next-turn');
  });
});
