/**
 * Quicksilver Voice Pipeline Skeleton.
 *
 * Skeleton for the real-time voice pipeline based on xAI's Quicksilver,
 * Fathom (speech-to-text), and Marin (text-to-speech) models.
 *
 * Transcription and synthesis methods are placeholders and will be wired
 * to the model APIs once credentials are available.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('voice:quicksilver');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Voice model identifiers supported by the Quicksilver pipeline. */
export type QuicksilverModel = 'quicksilver' | 'fathom' | 'marin';

/** Voice Activity Detection mode. */
export type VadMode = 'server_vad' | 'near_field';

/** Audio encoding format. */
export type AudioEncoding = 'pcm' | 'opus';

/**
 * Configuration for a Quicksilver voice session.
 * Named QuicksilverConfig to distinguish from the existing VoiceConfig
 * used by VoiceEngine (which covers TTS/STT providers and persistence).
 */
export interface QuicksilverConfig {
  /** Primary voice model to use. */
  model: QuicksilverModel;
  /** Audio sample rate in Hz. ElevenLabs and most models expect 16 000. */
  sampleRate: number;
  /** Number of audio channels. 1 = mono, 2 = stereo. */
  channels: number;
  /** Raw audio encoding format for I/O buffers. */
  encoding: AudioEncoding;
  /** Voice Activity Detection mode. */
  vadMode: VadMode;
}

/** An active or ended Quicksilver voice session. */
export interface QuicksilverSession {
  /** Unique session identifier, e.g. "voice-1712345678901". */
  id: string;
  /** Session configuration snapshot. */
  config: QuicksilverConfig;
  /** Whether the session is currently active. */
  active: boolean;
  /** ISO-8601 timestamp when the session was created. */
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: QuicksilverConfig = {
  model: 'quicksilver',
  sampleRate: 16_000,
  channels: 1,
  encoding: 'pcm',
  vadMode: 'server_vad',
};

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a new Quicksilver voice session.
 *
 * @param config - Optional partial config override merged with defaults.
 * @returns An active QuicksilverSession.
 */
export function createVoiceSession(config?: Partial<QuicksilverConfig>): QuicksilverSession {
  const session: QuicksilverSession = {
    id: `voice-${Date.now()}`,
    config: { ...DEFAULT_CONFIG, ...config },
    active: true,
    startedAt: new Date().toISOString(),
  };
  log.info({ id: session.id, model: session.config.model }, 'Voice session created');
  return session;
}

/**
 * End an active voice session.
 *
 * @param session - Session to terminate.
 */
export function endVoiceSession(session: QuicksilverSession): void {
  if (!session.active) {
    log.warn({ id: session.id }, 'endVoiceSession: session already ended');
    return;
  }
  session.active = false;
  log.info({ id: session.id }, 'Voice session ended');
}

// ---------------------------------------------------------------------------
// Transcription (Fathom model placeholder)
// ---------------------------------------------------------------------------

/**
 * Transcribe audio to text using the Fathom speech model.
 *
 * PLACEHOLDER: returns an empty string until Fathom model integration is wired.
 *
 * @param _audioBuffer - Raw PCM or Opus audio data.
 * @returns Transcribed text string, or empty string when not yet implemented.
 */
export async function transcribe(_audioBuffer: Buffer): Promise<string> {
  log.warn('transcribe: Fathom model integration not yet implemented — returning empty string');
  return '';
}

// ---------------------------------------------------------------------------
// Synthesis (Marin model placeholder)
// ---------------------------------------------------------------------------

/**
 * Synthesize text to speech audio using the Marin voice model.
 *
 * PLACEHOLDER: returns an empty Buffer until Marin model integration is wired.
 *
 * @param _text - Text to synthesize.
 * @returns Raw audio buffer, or empty buffer when not yet implemented.
 */
export async function synthesize(_text: string): Promise<Buffer> {
  log.warn('synthesize: Marin model integration not yet implemented — returning empty buffer');
  return Buffer.alloc(0);
}
