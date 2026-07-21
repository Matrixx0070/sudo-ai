/**
 * @file grok-voice.ts
 * @description Subscription-free speech-to-text and text-to-speech on the user's
 * Grok web session, exposed as free voice providers distinct from the metered
 * xAI API path.
 *
 * Both lanes are seat-covered and statsig-FREE (proven live 2026-07-20), unlike
 * the video lane:
 *   * STT  -> POST grok.com/rest/voice/speech-to-text  (JSON audioBase64 in,
 *             {text, words} out)
 *   * TTS  -> POST grok.com/rest/app-chat/tts          (streams audio/l16 PCM
 *             frames, reassembled to a 24 kHz mono WAV by the python bridge)
 *
 * Reuses GW3 (session manager) + GW2 (replay bridge) behind the shared
 * `SUDO_GROK_WEBSESSION` flag (default OFF). Secrets never logged; callers get
 * only text / audio bytes back — never cookie material. No Playwright, no
 * statsig oracle: the voice lanes need neither.
 */

import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import { callGrokWebBridge, type GrokWebCreds } from './grok-web-bridge.js';
import { isGrokWebSessionEnabled, GrokWebDisabledError } from './grok-web-media.js';

const log = createLogger('llm:grok-voice');

export interface GrokVoiceDeps {
  manager: GrokWebSessionManager;
  bridge: typeof callGrokWebBridge;
}

export interface GrokSttResult {
  text: string;
  words: Array<{ word: string; startMs?: number; endMs?: number; alignScore?: number }>;
}

export interface GrokTtsResult {
  /** 24 kHz mono 16-bit PCM WAV bytes. */
  audioBuffer: Buffer;
  format: 'wav';
  sampleRate: number;
  durationMs: number;
}

function defaultDeps(): GrokVoiceDeps {
  return { manager: getGrokWebSessionManager(), bridge: callGrokWebBridge };
}

function credsOf(session: { cookie: string; userAgent: string }): GrokWebCreds {
  return { cookie: session.cookie, userAgent: session.userAgent };
}

/** Ensure the feature is on + the session is healthy (refreshing if needed). */
async function ready(deps: GrokVoiceDeps): Promise<{ cookie: string; userAgent: string }> {
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
  return deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
}

/**
 * Transcribe audio on the Grok subscription voice lane (free, browserless,
 * statsig-free). Returns the transcript plus per-word timing.
 */
export async function transcribeGrokVoice(
  audio: Buffer,
  opts: { audioFormat?: string; deps?: GrokVoiceDeps } = {},
): Promise<GrokSttResult> {
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    throw new TypeError('transcribeGrokVoice: audio must be a non-empty Buffer');
  }
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);

  const r = await deps.bridge(
    {
      op: 'voice_stt',
      audioBase64: audio.toString('base64'),
      audioFormat: opts.audioFormat ?? 'wav',
    },
    credsOf(session),
  );
  if (!r.ok) {
    throw new Error(
      `Grok STT failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`,
    );
  }
  log.info({ textLen: (r.text ?? '').length, words: r.words?.length ?? 0 }, 'grok-voice STT complete');
  return { text: r.text ?? '', words: r.words ?? [] };
}

/**
 * Synthesise speech on the Grok subscription voice lane (free, browserless,
 * statsig-free). Returns a 24 kHz mono WAV buffer.
 */
export async function synthesizeGrokVoice(
  text: string,
  opts: { voice?: string; deps?: GrokVoiceDeps } = {},
): Promise<GrokTtsResult> {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new TypeError('synthesizeGrokVoice: text must be a non-empty string');
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);

  const r = await deps.bridge(
    { op: 'voice_tts', text: trimmed, ...(opts.voice ? { voice: opts.voice } : {}) },
    credsOf(session),
  );
  if (!r.ok || !r.audioBase64) {
    throw new Error(
      `Grok TTS failed: ${r.errorClass ?? 'no audio'}${r.detail ? ` (${r.detail})` : ''}`,
    );
  }
  const audioBuffer = Buffer.from(r.audioBase64, 'base64');
  const sampleRate = r.sampleRate ?? 24000;
  const durationMs = r.durationMs ?? 0;
  log.info({ bytes: audioBuffer.length, sampleRate, durationMs }, 'grok-voice TTS complete');
  return { audioBuffer, format: 'wav', sampleRate, durationMs };
}

export { GrokWebReloginRequiredError, GrokWebDisabledError, isGrokWebSessionEnabled };
