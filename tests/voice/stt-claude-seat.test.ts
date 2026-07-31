/**
 * @file tests/voice/stt-claude-seat.test.ts
 * @description The Claude Max seat STT lane (2026-07-31). Covers the wire
 * contract (query params the endpoint requires — `channels` is mandatory and
 * undocumented), the flag/ffmpeg gating, and the never-throws contract that
 * lets SpeechToText fall through to its other providers.
 *
 * The real endpoint is a live-dictation WebSocket that must be fed at ~1x
 * real time; that behaviour is verified live (see PR), not mocked here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildVoiceStreamUrl,
  seatSttEnabled,
  transcribeOnClaudeSeat,
  hasFfmpeg,
  __resetFfmpegProbe,
} from '../../src/core/voice/stt-claude-seat.js';

const ENV = ['SUDO_STT_CLAUDE_SEAT', 'VOICE_STREAM_BASE_URL', 'SUDO_STT_SEAT_MAX_SEC'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  __resetFfmpegProbe();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  __resetFfmpegProbe();
  vi.restoreAllMocks();
});

describe('buildVoiceStreamUrl — endpoint contract', () => {
  it('carries every param the endpoint requires', () => {
    const u = new URL(buildVoiceStreamUrl());
    expect(u.protocol).toBe('wss:');
    expect(u.host).toBe('api.anthropic.com');
    expect(u.pathname).toBe('/api/ws/speech_to_text/voice_stream');
    expect(u.searchParams.get('encoding')).toBe('linear16');
    expect(u.searchParams.get('sample_rate')).toBe('16000');
    // `channels` is REQUIRED — omitting it returns
    // "query.channels: Field required" (live-probed).
    expect(u.searchParams.get('channels')).toBe('1');
    expect(u.searchParams.get('stt_provider')).toBe('deepgram-nova3');
    expect(u.searchParams.get('transcription_engine')).toBe('true');
    expect(u.searchParams.get('language')).toBe('en');
  });

  it('honours language and keyterm biasing', () => {
    const u = new URL(buildVoiceStreamUrl({ language: 'de', keyterms: ['sudo-ai', 'checkpoint'] }));
    expect(u.searchParams.get('language')).toBe('de');
    expect(u.searchParams.getAll('keyterms')).toEqual(['sudo-ai', 'checkpoint']);
  });

  it('respects the VOICE_STREAM_BASE_URL override', () => {
    process.env['VOICE_STREAM_BASE_URL'] = 'ws://localhost:9999';
    expect(buildVoiceStreamUrl().startsWith('ws://localhost:9999/api/ws/')).toBe(true);
  });
});

describe('gating', () => {
  it('seatSttEnabled is false when the flag is off, regardless of ffmpeg', () => {
    process.env['SUDO_STT_CLAUDE_SEAT'] = '0';
    expect(seatSttEnabled()).toBe(false);
  });

  it('seatSttEnabled tracks ffmpeg availability when the flag is on', () => {
    // hasFfmpeg() is environment-dependent; assert the two stay consistent.
    expect(seatSttEnabled()).toBe(hasFfmpeg());
  });

  it('transcribeOnClaudeSeat returns a reason (never throws) when disabled', async () => {
    process.env['SUDO_STT_CLAUDE_SEAT'] = '0';
    const r = await transcribeOnClaudeSeat(Buffer.from('not audio'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('disabled');
  });

  it('never throws on garbage input — it reports a reason so callers fall through', async () => {
    const r = await transcribeOnClaudeSeat(Buffer.from('definitely not audio'));
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
  });
});
