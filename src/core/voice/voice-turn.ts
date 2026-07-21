/**
 * VoiceTurn — one turn of a turn-based voice conversation:
 *
 *   audio in  →  STT  →  (injected) reply  →  TTS  →  audio out
 *
 * The "brain" is passed in as a `reply` callback so this module never imports
 * the agent/brain/LLM layers — preserving the voice↔brain separation (the
 * injected-callback seam, same posture as the channel adapters). STT and TTS
 * default to the local providers; pass `sttProvider`/`ttsProvider` = 'grok' to
 * route a turn through the owner's free Grok subscription voice lanes (requires
 * SUDO_GROK_WEBSESSION — owner-gated at the calling surface).
 *
 * This is the discrete turn primitive. Continuous-mic streaming (VAD +
 * barge-in) is a separate layer that sits ON TOP of this and needs live audio
 * I/O; it is intentionally not built here.
 */

import { createLogger } from '../shared/logger.js';
import { SpeechToText } from './stt.js';
import { TextToSpeech } from './tts.js';
import type { STTOptions, TTSOptions, TTSResult } from './types.js';

const log = createLogger('voice:turn');

/** Injected brain seam: transcript in → reply text out. */
export type VoiceReplyFn = (transcript: string) => Promise<string>;

/** Overridable STT/TTS seams (defaults use the real local/cloud providers). */
export interface VoiceTurnDeps {
  transcribe?: (audio: Buffer, opts: STTOptions) => Promise<{ text: string }>;
  synthesize?: (text: string, opts: TTSOptions) => Promise<TTSResult>;
}

export interface VoiceTurnOptions {
  sttProvider?: STTOptions['provider'];
  ttsProvider?: TTSOptions['provider'];
  /** TTS voice override (provider-specific). */
  voice?: string;
  /** STT language hint (BCP-47). */
  language?: string;
}

export interface VoiceTurnResult {
  /** What the user said (STT output). */
  transcript: string;
  /** What the agent replied (reply seam output). */
  replyText: string;
  /** Synthesised reply audio; absent when there was nothing to synthesise. */
  audio?: { buffer: Buffer; format: TTSResult['format']; durationMs: number };
  /** Set when the turn short-circuited (no speech / empty reply). */
  note?: string;
}

let _stt: SpeechToText | null = null;
let _tts: TextToSpeech | null = null;

/**
 * Run one voice turn. Transcribes the input audio, hands the transcript to the
 * injected `reply` seam, and synthesises the reply to audio. Short-circuits
 * (no TTS, no reply call) when the input has no speech, and skips synthesis
 * when the reply is empty — so a silent clip never spends a reply/TTS call.
 */
export async function runVoiceTurn(
  audio: Buffer,
  reply: VoiceReplyFn,
  opts: VoiceTurnOptions = {},
  deps: VoiceTurnDeps = {},
): Promise<VoiceTurnResult> {
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    throw new TypeError('runVoiceTurn: audio must be a non-empty Buffer');
  }

  const transcribe = deps.transcribe ?? ((a, o) => (_stt ??= new SpeechToText()).transcribe(a, o));
  const synthesize = deps.synthesize ?? ((t, o) => (_tts ??= new TextToSpeech()).synthesize(t, o));

  const sttOpts: STTOptions = {};
  if (opts.sttProvider) sttOpts.provider = opts.sttProvider;
  if (opts.language) sttOpts.language = opts.language;

  const { text } = await transcribe(audio, sttOpts);
  const transcript = text.trim();
  if (!transcript) {
    log.info('voice turn: no speech detected — skipping reply + TTS');
    return { transcript: '', replyText: '', note: 'no speech detected' };
  }

  const replyText = (await reply(transcript)).trim();
  if (!replyText) {
    log.info({ transcriptLen: transcript.length }, 'voice turn: empty reply — nothing to synthesise');
    return { transcript, replyText: '', note: 'empty reply' };
  }

  const ttsOpts: TTSOptions = {};
  if (opts.ttsProvider) ttsOpts.provider = opts.ttsProvider;
  if (opts.voice) ttsOpts.voice = opts.voice;

  const tts = await synthesize(replyText, ttsOpts);
  log.info(
    { transcriptLen: transcript.length, replyLen: replyText.length, audioBytes: tts.audioBuffer.length, format: tts.format },
    'voice turn complete',
  );
  return {
    transcript,
    replyText,
    audio: { buffer: tts.audioBuffer, format: tts.format, durationMs: tts.durationMs },
  };
}
