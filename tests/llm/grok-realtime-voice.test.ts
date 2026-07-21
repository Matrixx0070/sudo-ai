/**
 * @file grok-realtime-voice.test.ts
 * @description Unit tests for the Path A realtime voice turn (grok-as-agent over
 * LiveKit). NO net/livekit: the manager + bridge are injected; the bridge writes
 * the reply WAV that the orchestration reads back. Asserts the flag gate, the
 * request shape, reply passthrough, and error surfacing. The live LiveKit turn is
 * proven by scripts/grok_livekit_spike.py (not in CI).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'grok-rt-'));
  process.env['DATA_DIR'] = dir;
  process.env['SUDO_GROK_WEBSESSION'] = '1';
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['DATA_DIR'];
  delete process.env['SUDO_GROK_WEBSESSION'];
  vi.resetModules();
});

const SESSION = { cookie: 'cf=1; sso=2', userAgent: 'UA' };
function fakeManager(session = SESSION) {
  return { ensureHealthy: async () => session } as unknown as import('../../src/llm/grok-web-session-manager.js').GrokWebSessionManager;
}
const WAV = Buffer.from('RIFFxxxxWAVEdata....');

describe('grokRealtimeVoiceTurn', () => {
  it('speaks input + returns the agent reply WAV', async () => {
    const { grokRealtimeVoiceTurn } = await import('../../src/llm/grok-realtime-voice.js');
    const replyBytes = Buffer.from('RIFFyyyyWAVEreply');
    const bridge = vi.fn(async (req: { inputWav: string; outputPath: string; captureSeconds?: number }) => {
      expect(req.inputWav).toMatch(/in-\d+\.wav$/);
      expect(req.captureSeconds).toBe(6);
      writeFileSync(req.outputPath, replyBytes); // the python bridge writes the reply
      return { ok: true, path: req.outputPath, durationMs: 4200, agentIdentity: 'agent-AJ_x' };
    });
    const r = await grokRealtimeVoiceTurn(WAV, { captureSeconds: 6, deps: { manager: fakeManager(), bridge: bridge as never, now: () => 111 } });
    expect(r.replyWav.equals(replyBytes)).toBe(true);
    expect(r.durationMs).toBe(4200);
    expect(r.agentIdentity).toBe('agent-AJ_x');
  });

  it('flag OFF → GrokWebDisabledError (never calls the bridge)', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { grokRealtimeVoiceTurn, GrokWebDisabledError } = await import('../../src/llm/grok-realtime-voice.js');
    let called = false;
    await expect(
      grokRealtimeVoiceTurn(WAV, { deps: { manager: fakeManager(), bridge: (async () => { called = true; return { ok: true }; }) as never, now: () => 1 } }),
    ).rejects.toBeInstanceOf(GrokWebDisabledError);
    expect(called).toBe(false);
  });

  it('empty buffer → throws before touching the session', async () => {
    const { grokRealtimeVoiceTurn } = await import('../../src/llm/grok-realtime-voice.js');
    await expect(
      grokRealtimeVoiceTurn(Buffer.alloc(0), { deps: { manager: fakeManager(), bridge: (async () => ({ ok: true })) as never, now: () => 1 } }),
    ).rejects.toThrow(/non-empty/);
  });

  it('bridge error (no agent) → surfaces a clear message', async () => {
    const { grokRealtimeVoiceTurn } = await import('../../src/llm/grok-realtime-voice.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'no_agent' as const, detail: 'agent did not join' }));
    await expect(
      grokRealtimeVoiceTurn(WAV, { deps: { manager: fakeManager(), bridge: bridge as never, now: () => 1 } }),
    ).rejects.toThrow(/Grok realtime voice failed: no_agent/);
  });
});
