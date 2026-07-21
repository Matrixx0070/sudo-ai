/**
 * TextToSpeech — synthesises text to audio.
 *
 * Default is the local Kokoro ONNX provider (offline, key-free, on-device).
 * Cloud providers are opt-in and only reachable when SUDO_TTS_CLOUD=1, in
 * priority order: ElevenLabs (ELEVENLABS_API_KEY) → xAI (XAI_VOICE_API_KEY)
 * → OpenAI (OPENAI_API_KEY). Local Kokoro can be disabled with SUDO_KOKORO_TTS=0.
 *
 * Cloud providers use raw fetch — no SDK dependencies. Kokoro runs on-device.
 */

import { createLogger } from '../shared/logger.js';
import { getProviderApiKey, llmFetch } from '../../llm/client.js';
import { XAI_TTS_URL, OPENAI_TTS_URL } from '../../llm/endpoints.js';
import { ElevenLabsTTS } from './elevenlabs.js';
import { KokoroLocalTTS } from './kokoro.js';
import type { TTSResult, TTSOptions } from './types.js';

const log = createLogger('voice:tts');

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

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
  /** Cloud TTS (ElevenLabs/xAI/OpenAI) is opt-in; default is local-only. */
  private readonly cloudEnabled: boolean;

  constructor() {
    this.xaiKey = getProviderApiKey('xai-voice') ?? undefined;
    this.openaiKey = getProviderApiKey('openai') ?? undefined;
    this.elevenlabs = new ElevenLabsTTS();
    this.kokoro = new KokoroLocalTTS();

    const cloudFlag = process.env['SUDO_TTS_CLOUD'];
    this.cloudEnabled = cloudFlag === '1' || cloudFlag === 'true';

    if (!this.cloudEnabled) {
      log.info('TTS: local-only mode (Kokoro ONNX). Set SUDO_TTS_CLOUD=1 to re-enable ElevenLabs/xAI/OpenAI.');
    } else if (this.elevenlabs.available) {
      log.info('TTS primary provider: ElevenLabs (cloud enabled)');
    } else if (this.xaiKey) {
      log.info('TTS primary provider: xAI (cloud enabled)');
    } else if (this.openaiKey) {
      log.info('TTS primary provider: OpenAI (cloud enabled)');
    } else {
      log.info('TTS: cloud enabled but no cloud key set — using local Kokoro');
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

    // Grok subscription voice lane (FREE, browserless) — gated by its OWN flag
    // (SUDO_GROK_WEBSESSION), independent of the SUDO_TTS_CLOUD paid-cloud flag.
    // When the flag is off, fall through to the normal local/cloud resolution.
    if (options.provider === 'grok') {
      const grok = await import('../../llm/grok-voice.js');
      if (grok.isGrokWebSessionEnabled()) {
        const r = await grok.synthesizeGrokVoice(text, options.voice ? { voice: options.voice } : {});
        return { audioBuffer: r.audioBuffer, format: 'wav', durationMs: r.durationMs };
      }
      log.warn('Grok TTS requested but SUDO_GROK_WEBSESSION is off — using local/cloud resolution');
      options = { ...options, provider: undefined };
    }

    // Provider resolution. Default is local-only (Kokoro); the paid cloud
    // providers are kept in the code but only reachable when SUDO_TTS_CLOUD=1.
    let provider = options.provider;
    if (!this.cloudEnabled && provider && provider !== 'kokoro') {
      log.warn(
        { requested: provider },
        'Cloud TTS provider requested but cloud TTS is disabled (set SUDO_TTS_CLOUD=1) — using local Kokoro',
      );
      provider = 'kokoro';
    }
    if (!provider) {
      provider = this.cloudEnabled
        ? this.elevenlabs.available
          ? 'elevenlabs'
          : this.xaiKey
            ? 'xai'
            : this.openaiKey
              ? 'openai'
              : 'kokoro'
        : 'kokoro';
    }

    if (provider === 'kokoro') {
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
      resp = await llmFetch(XAI_TTS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.xaiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      }, { caller: 'voice:tts', purpose: 'cloud TTS' });
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
      resp = await llmFetch(OPENAI_TTS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.openaiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      }, { caller: 'voice:tts', purpose: 'cloud TTS' });
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
