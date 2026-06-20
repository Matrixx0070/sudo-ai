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
