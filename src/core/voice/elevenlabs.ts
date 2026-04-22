/**
 * ElevenLabs TTS provider.
 *
 * Uses the ElevenLabs REST API (v1) via raw fetch — no SDK dependency.
 * Reads ELEVENLABS_API_KEY from env. Gracefully unavailable when key is absent.
 *
 * Default voice: Rachel (21m00Tcm4TlvDq8ikWAM)
 * Returns MP3 audio as a Buffer.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('voice:elevenlabs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const DEFAULT_STABILITY = 0.5;
const DEFAULT_SIMILARITY_BOOST = 0.75;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ElevenLabsSynthesizeOptions {
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
}

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  labels: Record<string, string>;
}

interface ElevenLabsVoicesResponse {
  voices: Array<{
    voice_id: string;
    name: string;
    labels?: Record<string, string>;
  }>;
}

// ---------------------------------------------------------------------------
// ElevenLabsTTS
// ---------------------------------------------------------------------------

export class ElevenLabsTTS {
  private readonly apiKey: string | undefined;
  readonly available: boolean;

  constructor() {
    this.apiKey = process.env['ELEVENLABS_API_KEY'];
    this.available = Boolean(this.apiKey);

    if (this.available) {
      log.info('ElevenLabs TTS provider ready');
    } else {
      log.warn('ELEVENLABS_API_KEY not set — ElevenLabs TTS unavailable');
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Synthesize text to MP3 audio via ElevenLabs.
   *
   * @param text    - Text to speak (max 5000 chars).
   * @param options - Optional voice/model/param overrides.
   * @returns MP3 audio buffer.
   * @throws Error if API key is absent or request fails.
   */
  async synthesize(text: string, options: ElevenLabsSynthesizeOptions = {}): Promise<Buffer> {
    if (!this.apiKey) {
      throw new Error('ElevenLabs TTS unavailable — ELEVENLABS_API_KEY not set');
    }
    if (!text || typeof text !== 'string') {
      throw new TypeError('ElevenLabsTTS.synthesize: text must be a non-empty string');
    }

    const truncated = text.length > 5000 ? text.slice(0, 5000) : text;
    if (truncated.length < text.length) {
      log.warn({ originalLen: text.length }, 'ElevenLabs text truncated to 5000 chars');
    }

    const voiceId = options.voiceId ?? DEFAULT_VOICE_ID;
    const modelId = options.modelId ?? DEFAULT_MODEL_ID;
    const stability = options.stability ?? DEFAULT_STABILITY;
    const similarityBoost = options.similarityBoost ?? DEFAULT_SIMILARITY_BOOST;

    const url = `${BASE_URL}/text-to-speech/${encodeURIComponent(voiceId)}`;

    log.info({ voiceId, modelId, textLen: truncated.length }, 'Calling ElevenLabs TTS');

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: truncated,
          model_id: modelId,
          voice_settings: {
            stability,
            similarity_boost: similarityBoost,
          },
        }),
      });
    } catch (err) {
      log.error({ err }, 'ElevenLabs TTS network error');
      throw new Error(`ElevenLabs TTS network error: ${String(err)}`);
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      log.error({ status: resp.status, body: errBody }, 'ElevenLabs TTS API error');
      throw new Error(`ElevenLabs TTS error ${resp.status}: ${errBody}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    log.info({ bytes: audioBuffer.length, voiceId }, 'ElevenLabs TTS synthesis complete');
    return audioBuffer;
  }

  /**
   * List available voices from ElevenLabs.
   *
   * @returns Array of voice metadata objects.
   * @throws Error if API key absent or request fails.
   */
  async listVoices(): Promise<ElevenLabsVoice[]> {
    if (!this.apiKey) {
      throw new Error('ElevenLabs unavailable — ELEVENLABS_API_KEY not set');
    }

    let resp: Response;
    try {
      resp = await fetch(`${BASE_URL}/voices`, {
        headers: { 'xi-api-key': this.apiKey },
      });
    } catch (err) {
      log.error({ err }, 'ElevenLabs listVoices network error');
      throw new Error(`ElevenLabs listVoices network error: ${String(err)}`);
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      log.error({ status: resp.status, body: errBody }, 'ElevenLabs listVoices API error');
      throw new Error(`ElevenLabs listVoices error ${resp.status}: ${errBody}`);
    }

    const json = (await resp.json()) as ElevenLabsVoicesResponse;
    const voices: ElevenLabsVoice[] = (json.voices ?? []).map((v) => ({
      voiceId: v.voice_id,
      name: v.name,
      labels: v.labels ?? {},
    }));

    log.debug({ count: voices.length }, 'ElevenLabs voices listed');
    return voices;
  }
}
