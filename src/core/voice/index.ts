/**
 * Barrel export for the voice module.
 */

export { SpeechToText } from './stt.js';
export { TextToSpeech } from './tts.js';
export { VoiceEngine } from './voice-engine.js';
export type { VoiceConfig, VoiceMessage } from './voice-engine.js';
export { attachVoiceHandler } from './telegram-voice-handler.js';
export type { TranscribedHandler } from './telegram-voice-handler.js';
export type {
  STTResult,
  STTOptions,
  TTSResult,
  TTSOptions,
  SUPPORTED_STT_MIMES,
} from './types.js';
