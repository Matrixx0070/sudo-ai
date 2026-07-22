/**
 * Auto voice-reply marker logic on TelegramAdapter.
 *
 * When a peer sends a voice/audio note, the adapter marks them as owed a voice
 * reply; the next text reply (in send()) is consumed once, within a TTL, and
 * gated by SUDO_TELEGRAM_VOICE_REPLY. These tests exercise that pure logic
 * without the grammy bot (the send()→sendVoice path is covered live).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { TelegramAdapter } from '../../src/core/channels/telegram.js';
import { useGrokVoiceFor, grokRealtimeEnabledFor, grokRealtimeVoiceReply } from '../../src/core/channels/telegram-grok-voice.js';

vi.mock('../../src/llm/grok-realtime-voice.js', () => ({
  grokRealtimeVoiceTurn: vi.fn(),
}));

interface VoiceReplyInternals {
  _markVoiceReply(peerId: string): void;
  _consumeVoiceReply(peerId: string): boolean;
  _voiceReplyPending: Map<string, number>;
}

function internals(a: TelegramAdapter): VoiceReplyInternals {
  return a as unknown as VoiceReplyInternals;
}

describe('TelegramAdapter auto voice-reply marker', () => {
  beforeEach(() => {
    delete process.env['SUDO_TELEGRAM_VOICE_REPLY'];
  });
  afterEach(() => {
    delete process.env['SUDO_TELEGRAM_VOICE_REPLY'];
  });

  it('marks a peer and consumes the marker exactly once', () => {
    const a = internals(new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['1']));
    a._markVoiceReply('peer-1');
    expect(a._consumeVoiceReply('peer-1')).toBe(true);  // first reply → voice
    expect(a._consumeVoiceReply('peer-1')).toBe(false); // subsequent → text
  });

  it('does not affect other peers', () => {
    const a = internals(new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['1']));
    a._markVoiceReply('peer-1');
    expect(a._consumeVoiceReply('peer-2')).toBe(false);
  });

  it('is a no-op when SUDO_TELEGRAM_VOICE_REPLY=0', () => {
    process.env['SUDO_TELEGRAM_VOICE_REPLY'] = '0';
    const a = internals(new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['1']));
    a._markVoiceReply('peer-1');
    expect(a._consumeVoiceReply('peer-1')).toBe(false);
  });

  it('treats an expired marker as not pending', () => {
    const a = internals(new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['1']));
    a._voiceReplyPending.set('peer-1', Date.now() - 1_000); // already expired
    expect(a._consumeVoiceReply('peer-1')).toBe(false);
  });
});

describe('telegram grok voice gating (owner-only, flag-gated)', () => {
  const OWNERS = new Set(['1']);
  beforeEach(() => {
    for (const k of ['SUDO_VOICE_GROK_DEFAULT', 'SUDO_TELEGRAM_GROK_VOICE', 'SUDO_GROK_WEBSESSION']) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ['SUDO_VOICE_GROK_DEFAULT', 'SUDO_TELEGRAM_GROK_VOICE', 'SUDO_GROK_WEBSESSION']) delete process.env[k];
  });

  // SUDO_VOICE_GROK_DEFAULT: STT/TTS through the seat, sudo-ai brain (#904).
  it('useGrokVoiceFor defaults OFF; routes an owner when both flags on; never a stranger', () => {
    expect(useGrokVoiceFor(OWNERS, '1')).toBe(false);
    process.env['SUDO_VOICE_GROK_DEFAULT'] = '1';
    process.env['SUDO_GROK_WEBSESSION'] = '1';
    expect(useGrokVoiceFor(OWNERS, '1')).toBe(true);
    expect(useGrokVoiceFor(OWNERS, 1)).toBe(true); // numeric chat id
    expect(useGrokVoiceFor(OWNERS, '999')).toBe(false); // non-owner
    delete process.env['SUDO_GROK_WEBSESSION'];
    expect(useGrokVoiceFor(OWNERS, '1')).toBe(false); // needs SUDO_GROK_WEBSESSION
  });

  // SUDO_TELEGRAM_GROK_VOICE: route the note to grok's OWN realtime voice agent.
  it('grokRealtimeEnabledFor defaults OFF; owner-only; needs both flags', () => {
    expect(grokRealtimeEnabledFor(OWNERS, '1')).toBe(false);
    process.env['SUDO_TELEGRAM_GROK_VOICE'] = '1';
    expect(grokRealtimeEnabledFor(OWNERS, '1')).toBe(false); // still needs SUDO_GROK_WEBSESSION
    process.env['SUDO_GROK_WEBSESSION'] = '1';
    expect(grokRealtimeEnabledFor(OWNERS, '1')).toBe(true);
    expect(grokRealtimeEnabledFor(OWNERS, '999')).toBe(false); // non-owner never spends the seat
  });
});

describe('grokRealtimeVoiceReply silence trim (real ffmpeg)', () => {
  const RATE = 16000;

  /** Mono 16-bit PCM WAV: `leadS` silence + `toneS` 440Hz tone + `tailS` silence. */
  function buildWav(leadS: number, toneS: number, tailS: number): Buffer {
    const n = Math.round((leadS + toneS + tailS) * RATE);
    const pcm = Buffer.alloc(n * 2);
    const toneStart = Math.round(leadS * RATE);
    const toneEnd = Math.round((leadS + toneS) * RATE);
    for (let i = toneStart; i < toneEnd; i++) {
      pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 12000), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }

  async function oggDuration(ogg: Buffer): Promise<number> {
    const p = path.join(tmpdir(), `grok-trim-test-${process.pid}.ogg`);
    await writeFile(p, ogg);
    try {
      const { stdout } = await promisify(execFile)('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p,
      ]);
      return parseFloat(stdout.trim());
    } finally {
      await rm(p, { force: true });
    }
  }

  it('trims the capture-window silence around the speech (7s lead + 1s tone + 2s tail → ~1s note)', async () => {
    const { grokRealtimeVoiceTurn } = await import('../../src/llm/grok-realtime-voice.js');
    vi.mocked(grokRealtimeVoiceTurn).mockResolvedValue({
      replyWav: buildWav(7, 1, 2),
      durationMs: 10_000,
    } as Awaited<ReturnType<typeof grokRealtimeVoiceTurn>>);
    const ogg = await grokRealtimeVoiceReply(Buffer.from('input'));
    expect(ogg).not.toBeNull();
    const dur = await oggDuration(ogg as Buffer);
    expect(dur).toBeGreaterThan(0.8);  // tone kept
    expect(dur).toBeLessThan(2.5);     // 9s of silence gone (was ~10s untrimmed)
  }, 30_000);
});
