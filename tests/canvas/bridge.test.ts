/**
 * Canvas bridge (Spec 2) — push-to-web + event-injection, with mocked deps.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  registerCanvasBridge, pushCanvasToSession, deliverCanvasEvent, buildCanvasFrame,
  __resetCanvasBridgeForTests, isCanvasBridgeReady,
} from '../../src/core/canvas/canvas-bridge.js';
import type { CanvasPayload } from '../../src/core/canvas/schema.js';

const payload: CanvasPayload = { version: 1, title: 'T', components: [{ type: 'text', text: 'hi' }] };

afterEach(() => __resetCanvasBridgeForTests());

describe('buildCanvasFrame', () => {
  it('produces a {type:canvas} frame with version + components', () => {
    const f = buildCanvasFrame(payload);
    expect(f).toMatchObject({ type: 'canvas', version: 1, title: 'T' });
    expect(f.components).toHaveLength(1);
  });
});

describe('pushCanvasToSession', () => {
  it('fails clearly when the bridge is not wired', async () => {
    expect(isCanvasBridgeReady()).toBe(false);
    expect(await pushCanvasToSession('s1', payload)).toMatchObject({ ok: false, reason: /not wired/ });
  });

  it('pushes to the web peer + persists for a web session', async () => {
    const push = vi.fn(); const persist = vi.fn();
    registerCanvasBridge({
      resolveSessionPeer: async () => ({ channel: 'web', peerId: 'web-123' }),
      resolveWebSession: async () => 's1',
      push, inject: vi.fn(), persist,
    });
    const r = await pushCanvasToSession('s1', payload);
    expect(r.ok).toBe(true);
    expect(persist).toHaveBeenCalledWith('s1', payload);
    expect(push).toHaveBeenCalledWith('web', 'web-123', expect.stringContaining('"type":"canvas"'));
  });

  it('refuses non-web channels with a fall-back-to-text reason', async () => {
    registerCanvasBridge({
      resolveSessionPeer: async () => ({ channel: 'telegram', peerId: '555' }),
      resolveWebSession: async () => 's1', push: vi.fn(), inject: vi.fn(),
    });
    expect(await pushCanvasToSession('s1', payload)).toMatchObject({ ok: false, reason: /web only/ });
  });

  it('fails when the session is unknown', async () => {
    registerCanvasBridge({ resolveSessionPeer: async () => null, resolveWebSession: async () => 's', push: vi.fn(), inject: vi.fn() });
    expect(await pushCanvasToSession('nope', payload)).toMatchObject({ ok: false, reason: /not found/ });
  });
});

describe('deliverCanvasEvent', () => {
  it('resolves the web session and injects a TYPED event (not free text)', async () => {
    const inject = vi.fn();
    registerCanvasBridge({
      resolveSessionPeer: async () => ({ channel: 'web', peerId: 'web-1' }),
      resolveWebSession: async (peerId) => `sess-for-${peerId}`,
      push: vi.fn(), inject,
    });
    const r = await deliverCanvasEvent('web-1', { kind: 'form', actionId: 'save', values: { email: 'a@b.c' } });
    expect(r).toMatchObject({ ok: true, sessionId: 'sess-for-web-1' });
    const injected = inject.mock.calls[0]![1] as string;
    expect(injected).toContain('[CANVAS EVENT]');
    expect(injected).toContain('"actionId":"save"');
    expect(injected).toContain('a@b.c');
  });
});
