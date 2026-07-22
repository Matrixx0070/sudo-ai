/**
 * @file voice-session.test.ts
 * @description Unit tests for the streaming voice session state machine: VAD
 * endpointing, the full utterance→turn→reply→speaking cycle, playback-finished
 * return-to-listening, and barge-in (both the event and the abandoned-turn
 * suppression). All frames are synthetic; the `turn` is injected.
 */
import { describe, it, expect, vi } from 'vitest';
import { VoiceSession, type VoiceSessionEvent } from '../../src/core/voice/voice-session.js';
import type { VoiceTurnResult } from '../../src/core/voice/voice-turn.js';

const FRAME = 640; // 20ms @ 16kHz
const silence = (): Buffer => Buffer.alloc(FRAME, 0);
const loud = (): Buffer => {
  const b = Buffer.alloc(FRAME);
  for (let i = 0; i < FRAME / 2; i++) b.writeInt16LE(8000, i * 2);
  return b;
};
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function collect(s: VoiceSession): VoiceSessionEvent[] {
  const evts: VoiceSessionEvent[] = [];
  s.on((e) => evts.push(e));
  return evts;
}
function feed(s: VoiceSession, frame: Buffer, n: number): void {
  for (let i = 0; i < n; i++) s.pushFrame(frame);
}

const replyResult: VoiceTurnResult = {
  transcript: 'what time is it',
  replyText: 'it is noon',
  audio: { buffer: Buffer.alloc(8, 1), format: 'wav', durationMs: 700 },
};

describe('VoiceSession', () => {
  it('segments one utterance and runs the full turn → speaking, then returns to listening', async () => {
    const turn = vi.fn(async () => replyResult);
    const s = new VoiceSession({ turn }, { silenceHangoverFrames: 5, speechOnsetFrames: 3, preRollFrames: 4 });
    const evts = collect(s);

    feed(s, silence(), 4); // pre-roll silence
    feed(s, loud(), 10); // speech
    expect(s.getState()).toBe('capturing');
    feed(s, silence(), 5); // trailing silence ≥ hangover → endpoint

    expect(evts.some((e) => e.type === 'speech-start')).toBe(true);
    const utt = evts.find((e) => e.type === 'utterance');
    expect(utt).toBeTruthy();
    expect(s.getState()).toBe('thinking');

    await flush();
    expect(turn).toHaveBeenCalledOnce();
    expect(evts.some((e) => e.type === 'transcript' && e.text === 'what time is it')).toBe(true);
    const reply = evts.find((e) => e.type === 'reply');
    expect(reply && reply.type === 'reply' && reply.audio.buffer.length).toBe(8);
    expect(s.getState()).toBe('speaking');

    s.notifyPlaybackFinished();
    expect(s.getState()).toBe('listening');
  });

  it('does not endpoint until trailing silence reaches the hangover', () => {
    const turn = vi.fn(async () => replyResult);
    const s = new VoiceSession({ turn }, { silenceHangoverFrames: 10, speechOnsetFrames: 3 });
    feed(s, loud(), 8);
    feed(s, silence(), 9); // one short of hangover
    expect(s.getState()).toBe('capturing');
    expect(turn).not.toHaveBeenCalled();
    feed(s, silence(), 1); // reaches hangover
    expect(s.getState()).toBe('thinking');
  });

  it('pre-roll frames are included so the onset is not clipped', async () => {
    const turn = vi.fn(async () => replyResult);
    const s = new VoiceSession({ turn }, { silenceHangoverFrames: 3, speechOnsetFrames: 3, preRollFrames: 6 });
    const evts = collect(s);
    feed(s, silence(), 6); // fills pre-roll
    feed(s, loud(), 5);
    feed(s, silence(), 3);
    const utt = evts.find((e) => e.type === 'utterance');
    // wav = 44-byte header + PCM; PCM covers pre-roll(6) + speech(5) + trailing(3) frames ≈ 14*640
    expect(utt && utt.type === 'utterance' && utt.wav.length).toBeGreaterThan(6 * FRAME);
  });

  it('barge-in during speaking emits barge-in and returns to capturing', async () => {
    const turn = vi.fn(async () => replyResult);
    const s = new VoiceSession({ turn }, { silenceHangoverFrames: 4, speechOnsetFrames: 3, bargeInOnsetFrames: 4 });
    const evts = collect(s);
    // first utterance → speaking
    feed(s, loud(), 6);
    feed(s, silence(), 4);
    await flush();
    expect(s.getState()).toBe('speaking');
    // user talks over the reply
    feed(s, loud(), 4);
    expect(evts.some((e) => e.type === 'barge-in')).toBe(true);
    expect(s.getState()).toBe('capturing');
  });

  it('barge-in during thinking suppresses the abandoned turn reply', async () => {
    let resolveTurn: (r: VoiceTurnResult) => void = () => {};
    const turn = vi.fn(() => new Promise<VoiceTurnResult>((res) => { resolveTurn = res; }));
    const s = new VoiceSession({ turn }, { silenceHangoverFrames: 4, speechOnsetFrames: 3, bargeInOnsetFrames: 4 });
    const evts = collect(s);

    feed(s, loud(), 6);
    feed(s, silence(), 4); // → thinking, turn pending
    expect(s.getState()).toBe('thinking');

    feed(s, loud(), 4); // barge-in while thinking
    expect(evts.some((e) => e.type === 'barge-in')).toBe(true);
    expect(s.getState()).toBe('capturing');

    resolveTurn(replyResult); // the abandoned turn resolves late
    await flush();
    // its reply must NOT be emitted (superseded)
    expect(evts.some((e) => e.type === 'reply')).toBe(false);
  });

  it('a turn with no audio (no speech / empty reply) returns to listening', async () => {
    const turn = vi.fn(async (): Promise<VoiceTurnResult> => ({ transcript: '', replyText: '', note: 'no speech detected' }));
    const s = new VoiceSession({ turn }, { silenceHangoverFrames: 3, speechOnsetFrames: 3 });
    feed(s, loud(), 5);
    feed(s, silence(), 3);
    await flush();
    expect(s.getState()).toBe('listening');
  });
});
