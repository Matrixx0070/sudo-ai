/**
 * @file telegram-grok-voice.ts
 * @description Grok-voice wiring for the Telegram adapter, kept out of
 * telegram.ts (which is at the line-count ratchet). Two owner-gated modes:
 *
 *   - useGrokVoiceFor (SUDO_VOICE_GROK_DEFAULT): route Telegram voice STT/TTS
 *     through the owner's free Grok seat but keep sudo-ai's brain (#904).
 *   - grokRealtimeVoiceReply (SUDO_TELEGRAM_GROK_VOICE): route the voice note
 *     through grok's OWN realtime voice agent (grok-as-agent) and reply with its
 *     spoken answer — no sudo-ai brain, no STT/TTS.
 *
 * Both are owner-only (a stranger's note never spends the seat) and require
 * SUDO_GROK_WEBSESSION. Default OFF.
 */

import { spawn } from 'node:child_process';
import { createLogger } from '../shared/logger.js';

const log = createLogger('telegram:grok-voice');

/** True when this peer's voice STT/TTS should route through the free Grok seat. */
export function useGrokVoiceFor(ownerUsers: Set<string>, peerId: string | number): boolean {
  const flag = process.env['SUDO_VOICE_GROK_DEFAULT'];
  if ((flag !== '1' && flag !== 'true') || process.env['SUDO_GROK_WEBSESSION'] !== '1') return false;
  return ownerUsers.has(String(peerId));
}

/** True when this peer's voice note should go to grok's realtime voice agent. */
export function grokRealtimeEnabledFor(ownerUsers: Set<string>, peerId: string | number): boolean {
  const flag = process.env['SUDO_TELEGRAM_GROK_VOICE'];
  if ((flag !== '1' && flag !== 'true') || process.env['SUDO_GROK_WEBSESSION'] !== '1') return false;
  return ownerUsers.has(String(peerId));
}

/** Transcode a WAV buffer to an Ogg/Opus voice note (Telegram's native format). */
function wavToOggOpus(wav: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-nostdin', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', '-loglevel', 'error', 'pipe:1']);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on('data', (d: Buffer) => out.push(d));
    ff.stderr.on('data', (d: Buffer) => err.push(d));
    ff.on('error', (e) => reject(new Error(`ffmpeg opus encode failed: ${String(e)}`)));
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg opus encode exit ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 200)}`))));
    ff.stdin.write(wav);
    ff.stdin.end();
  });
}

/**
 * Run one grok realtime voice turn on the note's audio and return an Ogg/Opus
 * voice note of grok's spoken reply, or null if disabled/failed (caller falls
 * back to the normal STT→brain→TTS path). Never throws.
 */
export async function grokRealtimeVoiceReply(audio: Buffer): Promise<Buffer | null> {
  try {
    const { grokRealtimeVoiceTurn } = await import('../../llm/grok-realtime-voice.js');
    const r = await grokRealtimeVoiceTurn(audio);
    if (!r.replyWav || r.replyWav.length === 0) return null;
    const ogg = await wavToOggOpus(r.replyWav);
    log.info({ bytes: ogg.length, durationMs: r.durationMs }, 'grok realtime voice reply ready');
    return ogg;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'grok realtime voice failed — falling back to local pipeline');
    return null;
  }
}
