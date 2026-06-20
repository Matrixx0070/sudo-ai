/**
 * Kokoro ONNX TTS provider — local, offline, key-free text-to-speech.
 *
 * Runs the Kokoro-82M model entirely on-device via `kokoro-js`
 * (which uses @huggingface/transformers + onnxruntime under the hood).
 * No API key and no network call at synthesis time — the only network
 * use is a one-time model-weight download on first run (cached by
 * @huggingface/transformers).
 *
 * Returns WAV audio (24 kHz, 16-bit, mono) as a Buffer.
 *
 * `kokoro-js` is an optionalDependency and is imported lazily, so the
 * voice subsystem still loads when it is absent. Kokoro is the default
 * (local-only) TTS provider; cloud providers are gated behind
 * SUDO_TTS_CLOUD=1 in TextToSpeech.
 *
 * Env overrides:
 *   SUDO_KOKORO_TTS=0           — disable Kokoro (otherwise on by default)
 *   SUDO_KOKORO_MODEL=<repo>     — model id (default onnx-community/Kokoro-82M-v1.0-ONNX)
 *   SUDO_KOKORO_DTYPE=<dtype>    — fp32|fp16|q8|q4|q4f16 (default q8)
 *   SUDO_KOKORO_DEVICE=<device>  — cpu|wasm|webgpu (default cpu)
 *   SUDO_KOKORO_VOICE=<voice>    — default voice (default af_heart)
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('voice:kokoro');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_DTYPE = 'q8';
const DEFAULT_DEVICE = 'cpu';
const DEFAULT_VOICE = 'af_heart';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KokoroSynthesizeOptions {
  /** Kokoro voice id (e.g. "af_heart", "am_adam", "bf_emma"). */
  voice?: string;
  /** Playback speed multiplier (0.5–2.0). Default 1.0. */
  speed?: number;
}

/** Minimal shape of the RawAudio returned by `kokoro-js`. */
interface RawAudioLike {
  toWav(): ArrayBuffer;
  sampling_rate?: number;
}

/** Minimal shape of the loaded `kokoro-js` model. */
interface KokoroModelLike {
  generate(text: string, opts: { voice?: string; speed?: number }): Promise<RawAudioLike>;
  voices?: Record<string, unknown>;
  list_voices?: () => string[];
}

// ---------------------------------------------------------------------------
// Lazy model singleton
//
// Loading the model is expensive (weight download + ONNX session init), so it
// is shared across instances and only created on first synthesis. A failed
// load clears the cache so a later call can retry.
// ---------------------------------------------------------------------------

let _modelPromise: Promise<KokoroModelLike> | null = null;

// ---------------------------------------------------------------------------
// KokoroLocalTTS
// ---------------------------------------------------------------------------

export class KokoroLocalTTS {
  /** True when Kokoro should participate in automatic provider selection. */
  readonly available: boolean;
  private readonly modelId: string;
  private readonly dtype: string;
  private readonly device: string;
  private readonly defaultVoice: string;

  constructor() {
    // Kokoro is the default (local-only) TTS provider; available unless
    // explicitly disabled with SUDO_KOKORO_TTS=0.
    const flag = process.env['SUDO_KOKORO_TTS'];
    this.available = flag !== '0' && flag !== 'false';
    this.modelId = process.env['SUDO_KOKORO_MODEL'] ?? DEFAULT_MODEL_ID;
    this.dtype = process.env['SUDO_KOKORO_DTYPE'] ?? DEFAULT_DTYPE;
    this.device = process.env['SUDO_KOKORO_DEVICE'] ?? DEFAULT_DEVICE;
    this.defaultVoice = process.env['SUDO_KOKORO_VOICE'] ?? DEFAULT_VOICE;

    if (this.available) {
      log.info({ modelId: this.modelId, dtype: this.dtype }, 'Kokoro local TTS provider enabled');
    } else {
      log.debug('Kokoro local TTS disabled (SUDO_KOKORO_TTS=0)');
    }
  }

  // -------------------------------------------------------------------------
  // Model loading
  // -------------------------------------------------------------------------

  private async getModel(): Promise<KokoroModelLike> {
    if (!_modelPromise) {
      _modelPromise = this.loadModel();
      // Allow a later retry if this load fails.
      _modelPromise.catch(() => {
        _modelPromise = null;
      });
    }
    return _modelPromise;
  }

  /**
   * Load the Kokoro model, falling back across execution-provider devices so
   * first-run synthesis survives an unavailable backend.
   *
   * Under Node, kokoro-js / @huggingface/transformers only support the `cpu`
   * (onnxruntime-node) and `cuda` devices — there is no `wasm` device in the
   * Node runtime (it is browser-only). So when a non-cpu device (e.g. `cuda`
   * with no GPU) fails to load, this retries on `cpu`, which is universally
   * available. If `cpu` itself fails it is almost always a missing
   * onnxruntime-node native binary; the thrown error says how to fix that.
   */
  private async loadModel(): Promise<KokoroModelLike> {
    let mod: { KokoroTTS: { from_pretrained: (id: string, opts: Record<string, unknown>) => Promise<KokoroModelLike> } };
    try {
      mod = (await import('kokoro-js')) as unknown as typeof mod;
    } catch (err) {
      throw new Error(
        `kokoro-js is not installed — run \`pnpm add kokoro-js\` to enable local Kokoro TTS (${String(err)})`,
      );
    }

    // Configured device first, then cpu as a universal CPU fallback.
    const candidates = this.device === 'cpu' ? ['cpu'] : [this.device, 'cpu'];
    let lastErr: unknown;

    for (const device of candidates) {
      try {
        log.info(
          { modelId: this.modelId, dtype: this.dtype, device },
          'Loading Kokoro ONNX model (first run downloads weights, then cached)',
        );
        return await mod.KokoroTTS.from_pretrained(this.modelId, { dtype: this.dtype, device });
      } catch (err) {
        lastErr = err;
        log.warn({ device, err: String(err) }, 'Kokoro model load failed on device');
      }
    }

    throw new Error(
      `Kokoro model load failed (devices tried: ${candidates.join(', ')}). ` +
        'If this is a native onnxruntime-node binding error, run `pnpm approve-builds` ' +
        '(or reinstall) so the prebuilt binary is fetched. ' +
        `Last error: ${String(lastErr)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Synthesize text to WAV audio locally via Kokoro.
   *
   * @param text    - Text to speak.
   * @param options - Voice and speed overrides.
   * @returns WAV audio buffer (24 kHz, 16-bit, mono).
   * @throws Error if `kokoro-js` is absent or model load/generation fails.
   */
  async synthesize(text: string, options: KokoroSynthesizeOptions = {}): Promise<Buffer> {
    if (!text || typeof text !== 'string') {
      throw new TypeError('KokoroLocalTTS.synthesize: text must be a non-empty string');
    }

    const model = await this.getModel();
    const voice = this.resolveVoice(model, options.voice);
    const speed = clampSpeed(options.speed);

    log.info({ voice, speed, textLen: text.length }, 'Calling Kokoro local TTS');

    const audio = await model.generate(text, { voice, speed });
    const wav = audio.toWav();
    const buffer = Buffer.from(wav);

    log.info({ bytes: buffer.length, voice }, 'Kokoro TTS synthesis complete');
    return buffer;
  }

  /**
   * List available Kokoro voice ids.
   *
   * @returns Sorted array of voice ids (loads the model on first call).
   */
  async listVoices(): Promise<string[]> {
    const model = await this.getModel();
    return kokoroVoiceIds(model).sort();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Resolve a usable Kokoro voice. Kokoro rejects unknown voice ids, so a
   * caller-supplied voice from another provider (e.g. "alloy") falls back to
   * the configured default rather than throwing.
   */
  private resolveVoice(model: KokoroModelLike, requested?: string): string {
    if (!requested) return this.defaultVoice;
    const ids = kokoroVoiceIds(model);
    if (ids.length === 0 || ids.includes(requested)) return requested;
    log.warn({ requested, fallback: this.defaultVoice }, 'Unknown Kokoro voice — using default');
    return this.defaultVoice;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kokoroVoiceIds(model: KokoroModelLike): string[] {
  if (model.voices && typeof model.voices === 'object') return Object.keys(model.voices);
  if (typeof model.list_voices === 'function') return model.list_voices();
  return [];
}

function clampSpeed(speed?: number): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return 1.0;
  return Math.max(0.5, Math.min(2.0, speed));
}
