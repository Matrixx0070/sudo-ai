/**
 * Auto voice-reply marker logic on TelegramAdapter.
 *
 * When a peer sends a voice/audio note, the adapter marks them as owed a voice
 * reply; the next text reply (in send()) is consumed once, within a TTL, and
 * gated by SUDO_TELEGRAM_VOICE_REPLY. These tests exercise that pure logic
 * without the grammy bot (the send()→sendVoice path is covered live).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TelegramAdapter } from '../../src/core/channels/telegram.js';
import { useGrokVoiceFor, grokRealtimeEnabledFor } from '../../src/core/channels/telegram-grok-voice.js';

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
