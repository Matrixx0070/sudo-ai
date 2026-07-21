/**
 * SpeechToText — Whisper transcription, local-first.
 *
 * Default is the local Whisper ONNX provider (offline, key-free, on-device).
 * Cloud providers are opt-in and only reachable when SUDO_STT_CLOUD=1:
 *   1. Groq      (GROQ_API_KEY)       — FREE 28,800 sec/day, fastest
 *   2. ElevenLabs (ELEVENLABS_API_KEY) — scribe_v1
 *   3. OpenAI    (OPENAI_API_KEY)      — paid, fallback
 *
 * Cloud providers use the same OpenAI-compatible multipart/form-data API.
 * Supported formats: mp3, wav, ogg, webm, m4a
 */

import { createLogger } from '../shared/logger.js';
import { getProviderApiKey, llmFetch } from '../../llm/client.js';
import { GROQ_STT_URL, OPENAI_STT_URL } from '../../llm/endpoints.js';
import { WhisperLocalSTT } from './whisper-local.js';
import type { STTResult, STTOptions } from './types.js';

const log = createLogger('voice:stt');

const GROQ_URL        = GROQ_STT_URL;
const OPENAI_URL      = OPENAI_STT_URL;
const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const DEFAULT_MODEL      = 'whisper-1';
const GROQ_DEFAULT_MODEL = 'whisper-large-v3-turbo'; // Groq's fastest free model

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a multipart/form-data body from a Buffer without external libraries.
 * Returns { body: Buffer, contentType: string }.
 */
function buildMultipart(
  audioBuffer: Buffer,
  filename: string,
  model: string,
  language?: string,
): { body: Buffer; contentType: string } {
  const boundary = `----SudoAIBoundary${Date.now().toString(36)}`;
  const crlf = '\r\n';

  const parts: Buffer[] = [];

  const appendField = (name: string, value: string): void => {
    parts.push(Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="${name}"${crlf}${crlf}` +
      `${value}${crlf}`,
      'utf8',
    ));
  };

  appendField('model', model);
  appendField('response_format', 'verbose_json');
  if (language) appendField('language', language);

  // Audio file part
  parts.push(Buffer.from(
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}` +
    `Content-Type: application/octet-stream${crlf}${crlf}`,
    'utf8',
  ));
  parts.push(audioBuffer);
  parts.push(Buffer.from(crlf, 'utf8'));

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--${crlf}`, 'utf8'));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Infer a safe filename extension from the audio buffer header bytes. */
function inferFilename(buffer: Buffer): string {
  // OGG: OggS magic
  if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return 'audio.ogg';
  }
  // WAV: RIFF....WAVE
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    return 'audio.wav';
  }
  // WEBM: \x1a\x45\xdf\xa3
  if (buffer[0] === 0x1a && buffer[1] === 0x45) {
    return 'audio.webm';
  }
  // MP4/M4A: ftyp box
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    return 'audio.m4a';
  }
  // Default to mp3
  return 'audio.mp3';
}

// ---------------------------------------------------------------------------
// SpeechToText
// ---------------------------------------------------------------------------

interface WhisperVerboseResponse {
  text: string;
  language?: string;
  duration?: number;
}

export class SpeechToText {
  private readonly groqKey:        string | undefined;
  private readonly elevenLabsKey:  string | undefined;
  private readonly openaiKey:      string | undefined;
  private readonly whisper:        WhisperLocalSTT;
  /** Cloud STT (Groq/ElevenLabs/OpenAI) is opt-in; default is local-only. */
  private readonly cloudEnabled:   boolean;

  constructor() {
    this.groqKey       = getProviderApiKey('groq') ?? undefined;
    this.elevenLabsKey = process.env['ELEVENLABS_API_KEY'];
    this.openaiKey     = getProviderApiKey('openai') ?? undefined;
    this.whisper       = new WhisperLocalSTT();

    const cloudFlag = process.env['SUDO_STT_CLOUD'];
    this.cloudEnabled = cloudFlag === '1' || cloudFlag === 'true';

    if (!this.cloudEnabled) {
      log.info('STT: local-only mode (Whisper ONNX). Set SUDO_STT_CLOUD=1 to re-enable Groq/ElevenLabs/OpenAI.');
    } else if (this.groqKey) {
      log.info('STT primary provider: Groq (free Whisper, cloud enabled)');
    } else if (this.elevenLabsKey) {
      log.info('STT primary provider: ElevenLabs (cloud enabled)');
    } else if (this.openaiKey) {
      log.info('STT primary provider: OpenAI Whisper (cloud enabled)');
    } else {
      log.info('STT: cloud enabled but no cloud key set — using local Whisper');
    }
  }

  get available(): boolean {
    return this.whisper.available || !!(this.cloudEnabled && (this.groqKey || this.elevenLabsKey || this.openaiKey));
  }

  /** True when at least one cloud STT key is configured. */
  private get hasCloudKey(): boolean {
    return !!(this.groqKey || this.elevenLabsKey || this.openaiKey);
  }

  /**
   * Transcribe audio. Default is local Whisper (offline); cloud providers
   * (Groq → ElevenLabs → OpenAI) are used only when SUDO_STT_CLOUD=1.
   */
  async transcribe(audioBuffer: Buffer, options: STTOptions = {}): Promise<STTResult> {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      throw new TypeError('SpeechToText.transcribe: audioBuffer must be a non-empty Buffer');
    }

    // Grok subscription voice lane (FREE, browserless) — gated by its OWN flag
    // (SUDO_GROK_WEBSESSION), independent of the SUDO_STT_CLOUD paid-cloud flag.
    // When the flag is off, fall through to the normal local/cloud resolution.
    if (options.provider === 'grok') {
      const grok = await import('../../llm/grok-voice.js');
      if (grok.isGrokWebSessionEnabled()) {
        const startMs = Date.now();
        const r = await grok.transcribeGrokVoice(audioBuffer, {
          audioFormat: inferFilename(audioBuffer).split('.').pop() ?? 'wav',
        });
        return { text: r.text, language: options.language ?? 'en', confidence: 1.0, durationMs: Date.now() - startMs };
      }
      log.warn('Grok STT requested but SUDO_GROK_WEBSESSION is off — using local/cloud resolution');
      options = { ...options, provider: undefined };
    }

    if (!this.available) {
      log.warn('Skipping transcription — local Whisper disabled and no cloud STT provider configured');
      return { text: '', language: 'en', confidence: 0, durationMs: 0 };
    }

    // Provider resolution. Default is local-only (Whisper); the cloud providers
    // are kept in the code but only reachable when SUDO_STT_CLOUD=1.
    let provider = options.provider;
    if (!this.cloudEnabled && provider && provider !== 'whisper-local') {
      log.warn(
        { requested: provider },
        'Cloud STT provider requested but cloud STT is disabled (set SUDO_STT_CLOUD=1) — using local Whisper',
      );
      provider = 'whisper-local';
    }
    if (!provider) {
      provider = this.cloudEnabled && this.hasCloudKey ? 'groq' : 'whisper-local';
    }

    // Local Whisper path (default).
    if (provider === 'whisper-local') {
      if (this.whisper.available) {
        try {
          return await this.whisper.transcribe(audioBuffer, options);
        } catch (err) {
          if (this.cloudEnabled && this.hasCloudKey) {
            log.warn({ err: String(err) }, 'Local Whisper failed — falling back to cloud STT');
          } else {
            throw err;
          }
        }
      } else if (!(this.cloudEnabled && this.hasCloudKey)) {
        throw new Error('Local Whisper STT is disabled (SUDO_WHISPER_STT=0) and cloud STT is not configured');
      }
    }

    const filename = inferFilename(audioBuffer);

    // Try Groq first (free, faster)
    if (this.groqKey) {
      try {
        return await this._transcribeWith(
          audioBuffer, filename, GROQ_URL, this.groqKey,
          options.model ?? GROQ_DEFAULT_MODEL, options.language,
        );
      } catch (err) {
        log.warn({ err: String(err) }, 'Groq STT failed — trying ElevenLabs fallback');
      }
    }

    // ElevenLabs STT (uses xi-api-key header, different endpoint format)
    if (this.elevenLabsKey) {
      try {
        return await this._transcribeElevenLabs(audioBuffer, filename, options.language);
      } catch (err) {
        log.warn({ err: String(err) }, 'ElevenLabs STT failed — trying OpenAI fallback');
      }
    }

    // Fallback: OpenAI
    if (this.openaiKey) {
      return await this._transcribeWith(
        audioBuffer, filename, OPENAI_URL, this.openaiKey,
        options.model ?? DEFAULT_MODEL, options.language,
      );
    }

    // Last resort: local Whisper, even if it was not the first choice.
    if (this.whisper.available) {
      return await this.whisper.transcribe(audioBuffer, options);
    }

    throw new Error('All STT providers failed or unconfigured');
  }

  private async _transcribeElevenLabs(
    audioBuffer: Buffer,
    filename: string,
    language?: string,
  ): Promise<STTResult> {
    const startMs = Date.now();
    log.info({ filename, bufferBytes: audioBuffer.length }, 'Starting ElevenLabs STT transcription');

    const boundary = `----SudoAIBoundary${Date.now().toString(36)}`;
    const crlf = '\r\n';
    const parts: Buffer[] = [];

    // model_id is required
    parts.push(Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="model_id"${crlf}${crlf}` +
      `scribe_v1${crlf}`,
      'utf8',
    ));
    // ElevenLabs uses 'file' field name
    parts.push(Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}` +
      `Content-Type: application/octet-stream${crlf}${crlf}`,
      'utf8',
    ));
    parts.push(audioBuffer);
    parts.push(Buffer.from(crlf, 'utf8'));
    if (language) {
      parts.push(Buffer.from(
        `--${boundary}${crlf}` +
        `Content-Disposition: form-data; name="language_code"${crlf}${crlf}` +
        `${language}${crlf}`,
        'utf8',
      ));
    }
    parts.push(Buffer.from(`--${boundary}--${crlf}`, 'utf8'));

    const body = Buffer.concat(parts);

    let resp: Response;
    try {
      resp = await fetch(ELEVENLABS_STT_URL, {
        method: 'POST',
        headers: {
          'xi-api-key': this.elevenLabsKey!,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      });
    } catch (err) {
      throw new Error(`ElevenLabs STT network error: ${String(err)}`);
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`ElevenLabs STT error ${resp.status}: ${errBody}`);
    }

    const json = (await resp.json()) as { text?: string; language_code?: string };
    const durationMs = Date.now() - startMs;

    const result: STTResult = {
      text: json.text?.trim() ?? '',
      language: json.language_code ?? 'en',
      confidence: 1.0,
      durationMs,
    };

    log.info({ textLen: result.text.length, language: result.language, durationMs }, 'ElevenLabs STT complete');
    return result;
  }

  private async _transcribeWith(
    audioBuffer: Buffer,
    filename: string,
    url: string,
    apiKey: string,
    model: string,
    language?: string,
  ): Promise<STTResult> {
    const startMs = Date.now();
    const providerName = url.includes('groq') ? 'Groq' : 'OpenAI';

    log.info({ provider: providerName, model, filename, bufferBytes: audioBuffer.length }, 'Starting STT transcription');

    const { body, contentType } = buildMultipart(audioBuffer, filename, model, language);

    let resp: Response;
    try {
      resp = await llmFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': contentType,
        },
        body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      }, { caller: 'voice:stt', purpose: 'cloud STT' });
    } catch (err) {
      log.error({ provider: providerName, err }, 'STT fetch failed — network error');
      throw new Error(`STT network error (${providerName}): ${String(err)}`);
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      log.error({ provider: providerName, status: resp.status, body: errBody }, 'STT API returned error');
      throw new Error(`STT error ${resp.status} (${providerName}): ${errBody}`);
    }

    const json = (await resp.json()) as WhisperVerboseResponse;
    const durationMs = Date.now() - startMs;

    const result: STTResult = {
      text: json.text?.trim() ?? '',
      language: json.language ?? 'en',
      confidence: 1.0,
      durationMs,
    };

    log.info({ provider: providerName, textLen: result.text.length, language: result.language, durationMs }, 'STT transcription complete');
    return result;
  }
}
