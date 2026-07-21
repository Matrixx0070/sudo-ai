/**
 * @file grok-voice.test.ts
 * @description Unit tests for the subscription-free Grok voice lanes (STT/TTS).
 * NO net/browser/disk: the manager + bridge are injected. Asserts the flag gate,
 * the request shapes handed to the bridge, and error surfacing. The live
 * grok.com round-trip is proven separately (never in CI).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => {
  process.env['SUDO_GROK_WEBSESSION'] = '1';
});
afterEach(() => {
  delete process.env['SUDO_GROK_WEBSESSION'];
  vi.resetModules();
});

const SESSION = { cookie: 'cf_clearance=X; sso=Y', userAgent: 'UA' };
function fakeManager(session = SESSION) {
  return {
    ensureHealthy: async () => session,
  } as unknown as import('../../src/llm/grok-web-session-manager.js').GrokWebSessionManager;
}

describe('transcribeGrokVoice', () => {
  it('sends a voice_stt op with base64 audio and returns the transcript', async () => {
    const { transcribeGrokVoice } = await import('../../src/llm/grok-voice.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('voice_stt');
      expect((req as unknown as { audioBase64: string }).audioBase64).toBe(Buffer.from('audio').toString('base64'));
      return { ok: true, text: 'hello there', words: [{ word: 'hello' }, { word: 'there' }] };
    });
    const r = await transcribeGrokVoice(Buffer.from('audio'), { deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r.text).toBe('hello there');
    expect(r.words).toHaveLength(2);
  });

  it('flag OFF → GrokWebDisabledError (never calls the bridge)', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { transcribeGrokVoice, GrokWebDisabledError } = await import('../../src/llm/grok-voice.js');
    let called = false;
    await expect(
      transcribeGrokVoice(Buffer.from('a'), {
        deps: { manager: fakeManager(), bridge: (async () => { called = true; return { ok: true }; }) as never },
      }),
    ).rejects.toBeInstanceOf(GrokWebDisabledError);
    expect(called).toBe(false);
  });

  it('empty buffer → throws before touching the network', async () => {
    const { transcribeGrokVoice } = await import('../../src/llm/grok-voice.js');
    await expect(
      transcribeGrokVoice(Buffer.alloc(0), { deps: { manager: fakeManager(), bridge: (async () => ({ ok: true })) as never } }),
    ).rejects.toThrow(/non-empty/);
  });

  it('bridge error → surfaces a clear message', async () => {
    const { transcribeGrokVoice } = await import('../../src/llm/grok-voice.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'relogin' as const, detail: 'sso dead' }));
    await expect(
      transcribeGrokVoice(Buffer.from('a'), { deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok STT failed: relogin/);
  });
});

describe('synthesizeGrokVoice', () => {
  it('sends a voice_tts op and returns a decoded WAV buffer', async () => {
    const { synthesizeGrokVoice } = await import('../../src/llm/grok-voice.js');
    const wavBytes = Buffer.from('RIFFxxxxWAVE');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('voice_tts');
      expect((req as unknown as { text: string }).text).toBe('speak this');
      return { ok: true, audioBase64: wavBytes.toString('base64'), audioFormat: 'wav', sampleRate: 24000, durationMs: 1200 };
    });
    const r = await synthesizeGrokVoice('speak this', { deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r.format).toBe('wav');
    expect(r.sampleRate).toBe(24000);
    expect(r.durationMs).toBe(1200);
    expect(r.audioBuffer.equals(wavBytes)).toBe(true);
  });

  it('passes the voice override through to the bridge', async () => {
    const { synthesizeGrokVoice } = await import('../../src/llm/grok-voice.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect((req as { voice?: string }).voice).toBe('Ara');
      return { ok: true, audioBase64: Buffer.from('RIFF').toString('base64'), sampleRate: 24000, durationMs: 1 };
    });
    await synthesizeGrokVoice('hi', { voice: 'Ara', deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('empty text → throws before touching the network', async () => {
    const { synthesizeGrokVoice } = await import('../../src/llm/grok-voice.js');
    await expect(
      synthesizeGrokVoice('   ', { deps: { manager: fakeManager(), bridge: (async () => ({ ok: true })) as never } }),
    ).rejects.toThrow(/non-empty/);
  });

  it('no audio from bridge → surfaces a clear message', async () => {
    const { synthesizeGrokVoice } = await import('../../src/llm/grok-voice.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'no_audio' as const }));
    await expect(
      synthesizeGrokVoice('hi', { deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok TTS failed: no_audio/);
  });
});
