/**
 * @file voice-turn.test.ts
 * @description Unit tests for the turn-based voice engine (runVoiceTurn). STT,
 * TTS, and the brain reply are all injected — no net/model/disk. Asserts the
 * compose order, the short-circuits (no speech / empty reply spend nothing),
 * provider/voice passthrough, and the empty-buffer guard.
 */
import { describe, it, expect, vi } from 'vitest';
import { runVoiceTurn } from '../../src/core/voice/voice-turn.js';

const WAV = Buffer.from('RIFFxxxxWAVEdata');

function ttsResult(bytes = 10) {
  return { audioBuffer: Buffer.alloc(bytes, 1), format: 'wav' as const, durationMs: 500 };
}

describe('runVoiceTurn', () => {
  it('composes STT → reply → TTS and returns transcript, reply, and audio', async () => {
    const transcribe = vi.fn(async () => ({ text: '  what time is it  ' }));
    const reply = vi.fn(async (t: string) => `you said: ${t.trim()}`);
    const synthesize = vi.fn(async () => ttsResult(42));

    const r = await runVoiceTurn(WAV, reply, {}, { transcribe, synthesize });

    expect(transcribe).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith('what time is it'); // trimmed transcript
    expect(synthesize).toHaveBeenCalledOnce();
    expect(r.transcript).toBe('what time is it');
    expect(r.replyText).toBe('you said: what time is it');
    expect(r.audio?.buffer.length).toBe(42);
    expect(r.audio?.format).toBe('wav');
    expect(r.note).toBeUndefined();
  });

  it('no speech → short-circuits before reply and TTS', async () => {
    const transcribe = vi.fn(async () => ({ text: '   ' }));
    const reply = vi.fn(async () => 'should not run');
    const synthesize = vi.fn(async () => ttsResult());

    const r = await runVoiceTurn(WAV, reply, {}, { transcribe, synthesize });

    expect(reply).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
    expect(r.note).toBe('no speech detected');
    expect(r.audio).toBeUndefined();
  });

  it('empty reply → transcribes and replies but skips TTS', async () => {
    const transcribe = vi.fn(async () => ({ text: 'hello' }));
    const reply = vi.fn(async () => '   ');
    const synthesize = vi.fn(async () => ttsResult());

    const r = await runVoiceTurn(WAV, reply, {}, { transcribe, synthesize });

    expect(reply).toHaveBeenCalledOnce();
    expect(synthesize).not.toHaveBeenCalled();
    expect(r.transcript).toBe('hello');
    expect(r.note).toBe('empty reply');
  });

  it('passes provider/voice/language options through to STT and TTS', async () => {
    const transcribe = vi.fn(async (_a: Buffer, o: { provider?: string; language?: string }) => {
      expect(o.provider).toBe('grok');
      expect(o.language).toBe('en');
      return { text: 'hi' };
    });
    const synthesize = vi.fn(async (_t: string, o: { provider?: string; voice?: string }) => {
      expect(o.provider).toBe('grok');
      expect(o.voice).toBe('Ara');
      return ttsResult();
    });
    await runVoiceTurn(WAV, async () => 'ok', { sttProvider: 'grok', ttsProvider: 'grok', voice: 'Ara', language: 'en' }, { transcribe, synthesize });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(synthesize).toHaveBeenCalledOnce();
  });

  it('empty audio buffer → throws before any provider call', async () => {
    const transcribe = vi.fn(async () => ({ text: 'x' }));
    await expect(
      runVoiceTurn(Buffer.alloc(0), async () => 'x', {}, { transcribe }),
    ).rejects.toThrow(/non-empty/);
    expect(transcribe).not.toHaveBeenCalled();
  });
});
