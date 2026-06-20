/**
 * Type definitions for Voice (STT / TTS) subsystem.
 */

// ---------------------------------------------------------------------------
// Speech-to-Text
// ---------------------------------------------------------------------------

/** Result of a speech-to-text transcription. */
export interface STTResult {
  /** Transcribed text. */
  text: string;
  /** Detected or requested language code (e.g. "en"). */
  language: string;
  /** Confidence score 0..1 (Whisper does not expose this natively; set to 1.0). */
  confidence: number;
  /** Audio duration in milliseconds. */
  durationMs: number;
}

/** Options for STT transcription requests. */
export interface STTOptions {
  /** BCP-47 language code hint (e.g. "en", "hi"). Auto-detect when omitted. */
  language?: string;
  /** Whisper model variant to use. Default: "whisper-1". */
  model?: string;
}

// ---------------------------------------------------------------------------
// Text-to-Speech
// ---------------------------------------------------------------------------

/** Result of a TTS synthesis call. */
export interface TTSResult {
  /** Raw audio data. */
  audioBuffer: Buffer;
  /** Audio encoding format. */
  format: 'mp3' | 'opus' | 'wav';
  /** Approximate audio duration in milliseconds. */
  durationMs: number;
}

/** Options for TTS synthesis requests. */
export interface TTSOptions {
  /** Voice identifier (provider-specific). */
  voice?: string;
  /**
   * Provider to use. Priority when omitted: elevenlabs → xai → openai → kokoro.
   * 'kokoro' runs the Kokoro-82M ONNX model locally (offline, key-free).
   */
  provider?: 'elevenlabs' | 'xai' | 'openai' | 'kokoro';
  /** Playback speed multiplier (0.5–2.0). Currently honoured by the kokoro provider. */
  speed?: number;
}

// ---------------------------------------------------------------------------
// Supported audio MIME types
// ---------------------------------------------------------------------------

/** Set of MIME types accepted by the STT implementation. */
export const SUPPORTED_STT_MIMES: ReadonlySet<string> = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/x-m4a',
  'audio/mp4',
]);
