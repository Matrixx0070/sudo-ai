/**
 * @file tests/channels/background-delivery.test.ts
 * @description ADR 0010 D1. Autonomous output used to be discarded by every
 * caller (cli.ts heartbeat/cron/goal/order), so anything the agent concluded on
 * its own was thrown away. These tests pin the replacement: a resolved target,
 * an actual delivery, and — when there is nowhere to send — a TYPED reason plus
 * a doctor warning, instead of a silent drop.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveDeliveryTarget,
  deliverBackgroundOutput,
  describeBackgroundDeliveryIssues,
  backgroundDeliveryEnabled,
} from '../../src/core/channels/background-delivery.js';

const sender = () => ({ send: vi.fn().mockResolvedValue(undefined) });

describe('resolveDeliveryTarget', () => {
  it('resolves the owner chat from TELEGRAM_CHAT_ID (first of a list)', () => {
    const t = resolveDeliveryTarget({ TELEGRAM_CHAT_ID: '123,456' } as NodeJS.ProcessEnv, true);
    expect(t).toEqual({ kind: 'telegram', chatId: '123' });
  });

  it('reports no-chat-id when unset or blank', () => {
    expect(resolveDeliveryTarget({} as NodeJS.ProcessEnv, true)).toEqual({ kind: 'none', reason: 'no-chat-id' });
    expect(resolveDeliveryTarget({ TELEGRAM_CHAT_ID: '  ' } as NodeJS.ProcessEnv, true))
      .toEqual({ kind: 'none', reason: 'no-chat-id' });
  });

  it('reports no-transport when the channel is not wired at boot', () => {
    expect(resolveDeliveryTarget({ TELEGRAM_CHAT_ID: '1' } as NodeJS.ProcessEnv, false))
      .toEqual({ kind: 'none', reason: 'no-transport' });
  });

  it('honours the kill-switch', () => {
    const env = { TELEGRAM_CHAT_ID: '1', SUDO_BACKGROUND_DELIVERY: '0' } as NodeJS.ProcessEnv;
    expect(backgroundDeliveryEnabled(env)).toBe(false);
    expect(resolveDeliveryTarget(env, true)).toEqual({ kind: 'none', reason: 'disabled' });
  });
});

describe('deliverBackgroundOutput', () => {
  const target = { kind: 'telegram' as const, chatId: '42' };

  it('delivers labelled output to the owner chat', async () => {
    const s = sender();
    const out = await deliverBackgroundOutput({ target, sender: s, label: 'Heartbeat', text: 'disk is filling up' });
    expect(out).toEqual({ delivered: true, chars: expect.any(Number) });
    expect(s.send).toHaveBeenCalledTimes(1);
    const [chatId, body] = s.send.mock.calls[0]!;
    expect(chatId).toBe('42');
    expect(body).toContain('Heartbeat');        // owner can tell WHAT spoke
    expect(body).toContain('disk is filling up');
  });

  it('sends nothing for empty/whitespace output', async () => {
    const s = sender();
    expect(await deliverBackgroundOutput({ target, sender: s, label: 'x', text: '   ' }))
      .toEqual({ delivered: false, reason: 'empty' });
    expect(await deliverBackgroundOutput({ target, sender: s, label: 'x', text: null }))
      .toEqual({ delivered: false, reason: 'empty' });
    expect(s.send).not.toHaveBeenCalled();
  });

  it('returns the TYPED reason when there is real content and nowhere to send it', async () => {
    const out = await deliverBackgroundOutput({
      target: { kind: 'none', reason: 'no-chat-id' },
      sender: sender(), label: 'Cron: nightly', text: 'found 3 failing jobs',
    });
    expect(out).toEqual({ delivered: false, reason: 'no-chat-id' });
  });

  it('truncates a runaway turn instead of spamming the chat', async () => {
    const s = sender();
    await deliverBackgroundOutput({ target, sender: s, label: 'x', text: 'y'.repeat(10_000) });
    const body = String(s.send.mock.calls[0]![1]);
    expect(body.length).toBeLessThan(4_000);
    expect(body).toContain('truncated');
  });

  it('never throws when the transport fails — a bad send must not fail the job', async () => {
    const s = { send: vi.fn().mockRejectedValue(new Error('telegram down')) };
    expect(await deliverBackgroundOutput({ target, sender: s, label: 'x', text: 'hi' }))
      .toEqual({ delivered: false, reason: 'send-failed' });
  });

  it('reports no-transport when no sender is wired', async () => {
    expect(await deliverBackgroundOutput({ target, sender: null, label: 'x', text: 'hi' }))
      .toEqual({ delivered: false, reason: 'no-transport' });
  });
});

describe('doctor: background work that can never reach anyone', () => {
  it('warns when jobs are armed but no target exists, naming the cause', () => {
    const issues = describeBackgroundDeliveryIssues({
      env: {} as NodeJS.ProcessEnv,
      hasTransport: true,
      activeBackgroundJobs: ['heartbeat', 'nightly-bench'],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('heartbeat, nightly-bench');
    expect(issues[0]).toContain('TELEGRAM_CHAT_ID');
    expect(issues[0]).toContain('spend budget'); // the cost of running mute
  });

  it('is silent when a target exists', () => {
    expect(describeBackgroundDeliveryIssues({
      env: { TELEGRAM_CHAT_ID: '1' } as NodeJS.ProcessEnv,
      hasTransport: true,
      activeBackgroundJobs: ['heartbeat'],
    })).toEqual([]);
  });

  it('is silent when nothing is armed (no jobs, nothing to drop)', () => {
    expect(describeBackgroundDeliveryIssues({
      env: {} as NodeJS.ProcessEnv, hasTransport: true, activeBackgroundJobs: [],
    })).toEqual([]);
  });

  it('explains the disabled and no-transport cases distinctly', () => {
    const disabled = describeBackgroundDeliveryIssues({
      env: { TELEGRAM_CHAT_ID: '1', SUDO_BACKGROUND_DELIVERY: '0' } as NodeJS.ProcessEnv,
      hasTransport: true, activeBackgroundJobs: ['heartbeat'],
    });
    expect(disabled[0]).toContain('SUDO_BACKGROUND_DELIVERY=0');

    const noTransport = describeBackgroundDeliveryIssues({
      env: { TELEGRAM_CHAT_ID: '1' } as NodeJS.ProcessEnv,
      hasTransport: false, activeBackgroundJobs: ['heartbeat'],
    });
    expect(noTransport[0]).toContain('no messaging transport');
  });
});
