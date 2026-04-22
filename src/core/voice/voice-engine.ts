/**
 * VoiceEngine — TTS/STT orchestration with persistent message history.
 *
 * Persists every synthesized or transcribed voice message to the
 * voice_messages SQLite table via VoiceDB.
 * Delegates synthesis to TextToSpeech and transcription to SpeechToText;
 * phone calling delegates to PhoneCallManager.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { createLogger } from '../shared/logger.js';
import { VoiceDB } from './voice-db.js';
import type { VoiceMessage } from './voice-db.js';

const log = createLogger('voice:engine');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { VoiceMessage } from './voice-db.js';

export interface VoiceConfig {
  /** Voice ID or name used when no override is supplied. */
  defaultVoice: string;
  /** Playback speed multiplier, 0.5–2.0. */
  speed: number;
  /** Pitch multiplier, 0.5–2.0. */
  pitch: number;
  /** BCP-47 language code, e.g. 'en-US'. */
  language: string;
}

// ---------------------------------------------------------------------------
// Known voice names per provider
// ---------------------------------------------------------------------------

const KNOWN_VOICES: string[] = [
  // ElevenLabs
  'Rachel', 'Adam', 'Antoni', 'Bella', 'Callum', 'Charlie', 'Clyde', 'Dave', 'Dorothy', 'Elli',
  // xAI
  'rex', 'nova', 'aria', 'sage', 'echo', 'onyx',
  // OpenAI
  'alloy', 'fable', 'shimmer',
  // system
  'default',
];

// ---------------------------------------------------------------------------
// VoiceEngine
// ---------------------------------------------------------------------------

export class VoiceEngine {
  private readonly vdb: VoiceDB;
  private config: VoiceConfig;

  /**
   * @param config  - Default voice settings.
   * @param dbPath  - Absolute path to the SQLite database file.
   */
  constructor(config: VoiceConfig, dbPath: string) {
    if (!config || typeof config !== 'object') {
      throw new TypeError('VoiceEngine: config must be an object');
    }
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('VoiceEngine: dbPath must be a non-empty string');
    }

    this.config = { ...config };
    this.vdb    = new VoiceDB(dbPath);

    log.info({ defaultVoice: config.defaultVoice, language: config.language }, 'VoiceEngine initialised');
  }

  // -------------------------------------------------------------------------
  // Text-to-Speech
  // -------------------------------------------------------------------------

  /**
   * Synthesize `text` to an audio file and persist the message record.
   *
   * @param text    - Text to speak (max 4096 chars).
   * @param voice   - Voice override; falls back to config.defaultVoice.
   * @param outPath - Optional explicit output file path.
   */
  async synthesize(text: string, voice?: string, outPath?: string): Promise<VoiceMessage> {
    if (!text || typeof text !== 'string' || !text.trim()) {
      throw new TypeError('VoiceEngine.synthesize: text must be a non-empty string');
    }
    const truncated     = text.length > 4096 ? text.slice(0, 4096) : text;
    const resolvedVoice = voice ?? this.config.defaultVoice;
    const { randomUUID } = await import('node:crypto');
    const id            = randomUUID();
    const audioPath     = outPath ?? join('/tmp', `sudo-ai-voice-${id}.mp3`);

    log.info({ id, textLen: truncated.length, voice: resolvedVoice }, 'Synthesizing speech');

    let durationMs: number | undefined;

    try {
      const { TextToSpeech } = await import('./tts.js');
      const tts    = new TextToSpeech();
      const result = await tts.synthesize(truncated, { voice: resolvedVoice });
      await writeFile(audioPath, result.audioBuffer);
      durationMs = result.durationMs;
      log.info({ id, audioPath, durationMs }, 'TTS synthesis complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ id, err: msg }, 'TTS synthesis failed — persisting text-only message');
      // Still persist the intent even when audio generation fails
      return this.vdb.save(truncated, resolvedVoice, undefined, undefined);
    }

    return this.vdb.save(truncated, resolvedVoice, audioPath, durationMs);
  }

  // -------------------------------------------------------------------------
  // Speech-to-Text
  // -------------------------------------------------------------------------

  /**
   * Transcribe an audio file and return the text.
   *
   * @param audioPath - Absolute path to the audio file (mp3/wav/ogg/webm/m4a).
   */
  async transcribe(audioPath: string): Promise<string> {
    if (!audioPath || typeof audioPath !== 'string') {
      throw new TypeError('VoiceEngine.transcribe: audioPath must be a non-empty string');
    }
    if (!existsSync(audioPath)) {
      throw new Error(`VoiceEngine.transcribe: file not found: ${audioPath}`);
    }

    log.info({ audioPath }, 'Transcribing audio');

    let buffer: Buffer;
    try {
      buffer = await readFile(audioPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`VoiceEngine.transcribe: cannot read file: ${msg}`);
    }

    if (buffer.length === 0) throw new Error('VoiceEngine.transcribe: audio file is empty');

    try {
      const { SpeechToText } = await import('./stt.js');
      const stt    = new SpeechToText();
      const result = await stt.transcribe(buffer, { language: this.config.language });
      log.info({ audioPath, textLen: result.text.length }, 'STT transcription complete');
      return result.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ audioPath, err: msg }, 'STT transcription failed');
      throw new Error(`VoiceEngine.transcribe: STT error: ${msg}`);
    }
  }

  // -------------------------------------------------------------------------
  // Voice library
  // -------------------------------------------------------------------------

  /** Return all known voice names across configured providers. */
  listVoices(): string[] {
    return [...KNOWN_VOICES];
  }

  /**
   * Update the default voice.
   *
   * @param voice - Voice name or ID to use by default.
   */
  setDefaultVoice(voice: string): void {
    if (!voice || typeof voice !== 'string' || !voice.trim()) {
      throw new TypeError('VoiceEngine.setDefaultVoice: voice must be a non-empty string');
    }
    this.config.defaultVoice = voice.trim();
    log.info({ voice }, 'Default voice updated');
  }

  // -------------------------------------------------------------------------
  // Phone capability
  // -------------------------------------------------------------------------

  /**
   * Initiate an outbound phone call via Twilio.
   *
   * @param number  - Destination in E.164 format, e.g. '+14155552671'.
   * @param message - Text to speak when the call is answered.
   */
  async callPhone(number: string, message: string): Promise<{ success: boolean; callId?: string }> {
    if (!number?.trim()) throw new TypeError('VoiceEngine.callPhone: number required');
    if (!message?.trim()) throw new TypeError('VoiceEngine.callPhone: message required');

    log.warn({ number, messageLen: message.length }, 'Phone call requested');

    try {
      const { PhoneCallManager } = await import('./phone-call.js');
      const mgr = new PhoneCallManager();
      if (!mgr.available) {
        log.warn({ number }, 'Twilio credentials not configured — call not placed');
        return { success: false };
      }
      const record = await mgr.makeCall(number, message);
      log.info({ number, sid: record.sid }, 'Outbound call initiated');
      return { success: true, callId: record.sid };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ number, err: msg }, 'Phone call failed');
      return { success: false };
    }
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /**
   * Return recent voice messages, newest first.
   *
   * @param limit - Maximum number of records (default 20).
   */
  getRecentMessages(limit = 20): VoiceMessage[] {
    return this.vdb.recent(Math.max(1, limit));
  }
}
