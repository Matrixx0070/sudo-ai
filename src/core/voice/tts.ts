/**
 * TextToSpeech — synthesises text to audio.
 *
 * Provider priority (first available wins unless overridden):
 *   ElevenLabs (ELEVENLABS_API_KEY) → xAI (XAI_VOICE_API_KEY) → OpenAI (OPENAI_API_KEY)
 *   → Kokoro (local ONNX, opt-in via SUDO_KOKORO_TTS=1)
 *
 * Cloud providers use raw fetch — no SDK dependencies. Kokoro runs on-device.
 */

import { createLogger } from '../shared/logger.js';
import { ElevenLabsTTS } from './elevenlabs.js';
import { KokoroLocalTTS } from './kokoro.js';
import type { TTSResult, TTSOptions } from './types.js';

const log = createLogger('voice:tts');

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

const XAI_TTS_URL = 'https://api.x.ai/v1/audio/speech';
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';

const DEFAULT_XAI_VOICE = 'rex';
const DEFAULT_OPENAI_VOICE = 'alloy';
const DEFAULT_OPENAI_MODEL = 'tts-1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough duration estimate: 150 words per minute → bytes per minute at 128 kbps. */
function estimateDurationMs(bufferBytes: number): number {
  const bitrateBytesPerSec = (128 * 1024) / 8; // 128 kbps mp3
  return Math.round((bufferBytes / bitrateBytesPerSec) * 1000);
}

/**
 * Duration of a canonical PCM/float WAV buffer, read from its header.
 *
 * Uses the byte-rate field (offset 28) so it is correct regardless of bit
 * depth (Kokoro emits 24 kHz 32-bit float). Falls back to a 48000 B/s estimate
 * for buffers too small or malformed to carry a header.
 */
function estimateWavDurationMs(buffer: Buffer): number {
  const FALLBACK_BYTES_PER_SEC = 48_000;
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    return Math.round((Math.max(0, buffer.length - 44) / FALLBACK_BYTES_PER_SEC) * 1000);
  }
  const byteRate = buffer.readUInt32LE(28) || FALLBACK_BYTES_PER_SEC;
  return Math.round(((buffer.length - 44) / byteRate) * 1000);
}

// ---------------------------------------------------------------------------
// TextToSpeech
// ---------------------------------------------------------------------------

export class TextToSpeech {
  private readonly xaiKey: string | undefined;
  private readonly openaiKey: string | undefined;
  private readonly elevenlabs: ElevenLabsTTS;
  private readonly kokoro: KokoroLocalTTS;

  constructor() {
    this.xaiKey = process.env['XAI_VOICE_API_KEY'];
    this.openaiKey = process.env['OPENAI_API_KEY'];
    this.elevenlabs = new ElevenLabsTTS();
    this.kokoro = new KokoroLocalTTS();

    if (this.elevenlabs.available) {
      log.info('TTS primary provider: ElevenLabs');
    } else if (this.xaiKey) {
      log.info('TTS primary provider: xAI');
    } else if (this.openaiKey) {
      log.info('TTS primary provider: OpenAI');
    } else if (this.kokoro.available) {
      log.info('TTS primary provider: Kokoro (local ONNX)');
    } else {
      log.warn('No TTS provider configured — synthesize() will fail');
    }
  }

  /**
   * Synthesise text to audio.
   *
   * Auto-selects available provider unless explicitly requested.
   *
   * @param text    - Text to synthesise (max ~4096 chars for most APIs).
   * @param options - Voice and provider overrides.
   * @returns Buffer with audio data and format metadata.
   */
  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    if (!text || typeof text !== 'string') {
      throw new TypeError('TextToSpeech.synthesize: text must be a non-empty string');
    }
    if (text.length > 4096) {
      log.warn({ textLen: text.length }, 'TTS text exceeds 4096 chars — truncating');
      text = text.slice(0, 4096);
    }

    const autoProvider = this.elevenlabs.available
      ? 'elevenlabs'
      : this.xaiKey
        ? 'xai'
        : this.openaiKey
          ? 'openai'
          : this.kokoro.available
            ? 'kokoro'
            : 'openai';
    const provider = options.provider ?? autoProvider;

    if (provider === 'kokoro') {
      // Explicit requests run even when SUDO_KOKORO_TTS is unset.
      const audioBuffer = await this.kokoro.synthesize(text, {
        voice: options.voice,
        speed: options.speed,
      });
      return { audioBuffer, format: 'wav', durationMs: estimateWavDurationMs(audioBuffer) };
    }

    if (provider === 'elevenlabs') {
      if (!this.elevenlabs.available) {
        log.warn('ElevenLabs requested but ELEVENLABS_API_KEY not set — falling back to xAI/OpenAI');
        return this._xaiOrOpenAISynthesize(text, options.voice);
      }
      const audioBuffer = await this.elevenlabs.synthesize(text, { voiceId: options.voice });
      const durationMs = estimateDurationMs(audioBuffer.length);
      return { audioBuffer, format: 'mp3', durationMs };
    }

    if (provider === 'xai') {
      if (!this.xaiKey) {
        log.warn('xAI provider requested but XAI_VOICE_API_KEY not set — falling back to OpenAI');
        return this._openaiSynthesize(text, options.voice);
      }
      return this._xaiSynthesize(text, options.voice ?? DEFAULT_XAI_VOICE);
    }

    return this._openaiSynthesize(text, options.voice);
  }

  // -------------------------------------------------------------------------
  // Provider implementations
  // -------------------------------------------------------------------------

  /** Try xAI first, fall back to OpenAI. */
  private async _xaiOrOpenAISynthesize(text: string, voice?: string): Promise<TTSResult> {
    if (this.xaiKey) {
      return this._xaiSynthesize(text, voice ?? DEFAULT_XAI_VOICE);
    }
    return this._openaiSynthesize(text, voice);
  }

  private async _xaiSynthesize(text: string, voice: string): Promise<TTSResult> {
    log.info({ voice, textLen: text.length }, 'Calling xAI TTS');

    const body = JSON.stringify({ model: 'tts-1', input: text, voice });

    let resp: Response;
    try {
      resp = await fetch(XAI_TTS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.xaiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      log.error({ err }, 'xAI TTS fetch failed — network error');
      throw new Error(`xAI TTS network error: ${String(err)}`);
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      log.error({ status: resp.status, body: errBody }, 'xAI TTS API returned error');
      // Attempt OpenAI fallback
      log.info('Falling back to OpenAI TTS after xAI failure');
      return this._openaiSynthesize(text, DEFAULT_OPENAI_VOICE);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    const durationMs = estimateDurationMs(audioBuffer.length);

    log.info({ bytes: audioBuffer.length, durationMs }, 'xAI TTS synthesis complete');
    return { audioBuffer, format: 'mp3', durationMs };
  }

  private async _openaiSynthesize(text: string, voice?: string): Promise<TTSResult> {
    if (!this.openaiKey) {
      throw new Error('TTS synthesis failed: no API keys configured (XAI_VOICE_API_KEY / OPENAI_API_KEY)');
    }

    const resolvedVoice = voice ?? DEFAULT_OPENAI_VOICE;
    log.info({ voice: resolvedVoice, textLen: text.length }, 'Calling OpenAI TTS');

    const body = JSON.stringify({
      model: DEFAULT_OPENAI_MODEL,
      input: text,
      voice: resolvedVoice,
      response_format: 'mp3',
    });

    let resp: Response;
    try {
      resp = await fetch(OPENAI_TTS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.openaiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      log.error({ err }, 'OpenAI TTS fetch failed — network error');
      throw new Error(`OpenAI TTS network error: ${String(err)}`);
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      log.error({ status: resp.status, body: errBody }, 'OpenAI TTS API returned error');
      throw new Error(`OpenAI TTS error ${resp.status}: ${errBody}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    const durationMs = estimateDurationMs(audioBuffer.length);

    log.info({ bytes: audioBuffer.length, durationMs }, 'OpenAI TTS synthesis complete');
    return { audioBuffer, format: 'mp3', durationMs };
  }
}
