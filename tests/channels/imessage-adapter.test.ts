/**
 * IMessageAdapter (Feature 1) — Apple-epoch conversion + Linux-safety.
 * The chat.db poll and osascript send are macOS-only (verified on the Mac); here
 * we prove the adapter registers and no-ops cleanly on a non-macOS host so it can
 * live in the gateway everywhere without crashing.
 */
import { describe, it, expect, vi } from 'vitest';
import { IMessageAdapter, appleToDate } from '../../src/core/channels/imessage-adapter.js';

describe('appleToDate', () => {
  it('converts Apple SECONDS (older schema) to the right wall clock', () => {
    // 0 apple-seconds = 2001-01-01T00:00:00Z
    expect(appleToDate(0).toISOString()).toBe('2001-01-01T00:00:00.000Z');
  });
  it('converts Apple NANOSECONDS (newer schema)', () => {
    // 1 year in ns after 2001 epoch → 2002-01-01
    const oneYearNs = 365 * 24 * 3600 * 1e9;
    expect(appleToDate(oneYearNs).getUTCFullYear()).toBe(2002);
  });
});

describe('IMessageAdapter — non-macOS safety', () => {
  const isMac = process.platform === 'darwin';

  it.skipIf(isMac)('start() no-ops without throwing off-macOS (connected, no poll)', async () => {
    const a = new IMessageAdapter();
    await expect(a.start()).resolves.toBeUndefined();
    expect(a.isConnected).toBe(true);
    await a.stop();
    expect(a.isConnected).toBe(false);
  });

  it.skipIf(isMac)('send() no-ops without throwing off-macOS', async () => {
    const a = new IMessageAdapter();
    await a.start();
    await expect(a.send('+15551234567', 'hello')).resolves.toBeUndefined();
  });

  it('rejects an empty peerId', async () => {
    const a = new IMessageAdapter();
    await expect(a.send('', 'x')).rejects.toThrow();
  });

  it('conforms to ChannelAdapter (channel key + handler wiring)', () => {
    const a = new IMessageAdapter();
    expect(a.channel).toBe('imessage');
    expect(() => a.onMessage(vi.fn())).not.toThrow();
  });
});
