/**
 * Whisper ONNX STT provider — local, offline, key-free speech-to-text.
 *
 * Runs an OpenAI Whisper model entirely on-device via `@huggingface/transformers`
 * (the same onnxruntime stack Kokoro TTS uses). No API key and no network call
 * at transcription time — the only network use is a one-time model-weight
 * download on first run (cached by @huggingface/transformers).
 *
 * Input audio of any container/codec (ogg/opus, mp3, wav, webm, m4a) is decoded
 * to the 16 kHz mono float PCM Whisper expects via a local `ffmpeg` subprocess.
 *
 * `@huggingface/transformers` is an optionalDependency and is imported lazily,
 * so the voice subsystem still loads when it (or ffmpeg) is absent. Whisper is
 * the default (local-only) STT provider; cloud providers (Groq/OpenAI/ElevenLabs)
 * are gated behind SUDO_STT_CLOUD=1 in SpeechToText.
 *
 * Env overrides:
 *   SUDO_WHISPER_STT=0           — disable local Whisper (otherwise on by default)
 *   SUDO_WHISPER_MODEL=<repo>     — model id (default onnx-community/whisper-base)
 *   SUDO_WHISPER_DTYPE=<dtype>    — fp32|fp16|q8|q4 (default q8)
 *   SUDO_WHISPER_DEVICE=<device>  — cpu|cuda (default cpu)
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { STTResult, STTOptions } from './types.js';

const log = createLogger('voice:whisper');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_ID = 'onnx-community/whisper-base';
const DEFAULT_DTYPE = 'q8';
const DEFAULT_DEVICE = 'cpu';
/** Whisper is trained on 16 kHz mono audio. */
const TARGET_SAMPLE_RATE = 16_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of a single ASR pipeline result. */
interface ASRChunk {
  text?: string;
}

/** Minimal shape of the ASR pipeline returned by `@huggingface/transformers`. */
interface ASRPipelineLike {
  (audio: Float32Array, opts?: Record<string, unknown>): Promise<ASRChunk | ASRChunk[]>;
}

// ---------------------------------------------------------------------------
// Audio decoding (ffmpeg → 16 kHz mono float PCM)
// ---------------------------------------------------------------------------

/** Run ffmpeg, decoding `inPath` to raw little-endian float32 PCM on stdout. */
function ffmpegToFloatPcm(inPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inPath,
      '-f', 'f32le',
      '-ac', '1',
      '-ar', String(TARGET_SAMPLE_RATE),
      '-loglevel', 'error',
      'pipe:1',
    ];
    let child;
    try {
      child = spawn('ffmpeg', args);
    } catch (err) {
      reject(new Error(`ffmpeg spawn failed (is ffmpeg installed?): ${String(err)}`));
      return;
    }

    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => errOut.push(d));
    child.on('error', (err) =>
      reject(new Error(`ffmpeg is required for local Whisper STT but could not run: ${String(err)}`)),
    );
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out));
      } else {
        reject(
          new Error(
            `ffmpeg audio decode failed (exit ${code}): ${Buffer.concat(errOut).toString('utf8').slice(0, 500)}`,
          ),
        );
      }
    });
  });
}

/**
 * Decode an arbitrary audio buffer to a 16 kHz mono Float32Array.
 *
 * The buffer is written to a temp file first (rather than piped to stdin) so
 * ffmpeg can seek — required by container formats like m4a/mp4.
 */
async function decodeToPcm16k(audioBuffer: Buffer): Promise<Float32Array> {
  const dir = await mkdtemp(join(tmpdir(), 'sudo-whisper-'));
  const inPath = join(dir, 'input');
  try {
    await writeFile(inPath, audioBuffer);
    const pcm = await ffmpegToFloatPcm(inPath);
    // Copy into an aligned ArrayBuffer; a sliced Node Buffer is not guaranteed
    // to be 4-byte aligned for a Float32Array view.
    const usableBytes = pcm.length - (pcm.length % 4);
    const ab = new ArrayBuffer(usableBytes);
    new Uint8Array(ab).set(pcm.subarray(0, usableBytes));
    return new Float32Array(ab);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Lazy pipeline singleton
//
// Loading the model is expensive (weight download + ONNX session init), so it
// is shared across instances and only created on first transcription. A failed
// load clears the cache so a later call can retry.
// ---------------------------------------------------------------------------

let _pipelinePromise: Promise<ASRPipelineLike> | null = null;

// ---------------------------------------------------------------------------
// WhisperLocalSTT
// ---------------------------------------------------------------------------

export class WhisperLocalSTT {
  /** True when local Whisper should participate in automatic provider selection. */
  readonly available: boolean;
  private readonly modelId: string;
  private readonly dtype: string;
  private readonly device: string;

  constructor() {
    // Whisper is the default (local-only) STT provider; available unless
    // explicitly disabled with SUDO_WHISPER_STT=0.
    const flag = process.env['SUDO_WHISPER_STT'];
    this.available = flag !== '0' && flag !== 'false';
    this.modelId = process.env['SUDO_WHISPER_MODEL'] ?? DEFAULT_MODEL_ID;
    this.dtype = process.env['SUDO_WHISPER_DTYPE'] ?? DEFAULT_DTYPE;
    this.device = process.env['SUDO_WHISPER_DEVICE'] ?? DEFAULT_DEVICE;

    if (this.available) {
      log.info({ modelId: this.modelId, dtype: this.dtype }, 'Whisper local STT provider enabled');
    } else {
      log.debug('Whisper local STT disabled (SUDO_WHISPER_STT=0)');
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline loading
  // -------------------------------------------------------------------------

  private async getPipeline(): Promise<ASRPipelineLike> {
    if (!_pipelinePromise) {
      _pipelinePromise = this.loadPipeline();
      // Allow a later retry if this load fails.
      _pipelinePromise.catch(() => {
        _pipelinePromise = null;
      });
    }
    return _pipelinePromise;
  }

  /**
   * Load the Whisper ASR pipeline, falling back across execution-provider
   * devices so first-run transcription survives an unavailable backend.
   *
   * Under Node, @huggingface/transformers only supports the `cpu`
   * (onnxruntime-node) and `cuda` devices — there is no `wasm` device in the
   * Node runtime (it is browser-only). So when a non-cpu device (e.g. `cuda`
   * with no GPU) fails to load, this retries on `cpu`, which is universally
   * available. If `cpu` itself fails it is almost always a missing
   * onnxruntime-node native binary; the thrown error says how to fix that.
   */
  private async loadPipeline(): Promise<ASRPipelineLike> {
    let mod: { pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<unknown> };
    try {
      mod = (await import('@huggingface/transformers')) as unknown as typeof mod;
    } catch (err) {
      throw new Error(
        '@huggingface/transformers is not installed — run `pnpm add @huggingface/transformers` ' +
          `to enable local Whisper STT (${String(err)})`,
      );
    }

    // Configured device first, then cpu as a universal CPU fallback.
    const candidates = this.device === 'cpu' ? ['cpu'] : [this.device, 'cpu'];
    let lastErr: unknown;

    for (const device of candidates) {
      try {
        log.info(
          { modelId: this.modelId, dtype: this.dtype, device },
          'Loading Whisper ONNX model (first run downloads weights, then cached)',
        );
        return (await mod.pipeline('automatic-speech-recognition', this.modelId, {
          dtype: this.dtype,
          device,
        })) as ASRPipelineLike;
      } catch (err) {
        lastErr = err;
        log.warn({ device, err: String(err) }, 'Whisper model load failed on device');
      }
    }

    throw new Error(
      `Whisper model load failed (devices tried: ${candidates.join(', ')}). ` +
        'If this is a native onnxruntime-node binding error, run `pnpm approve-builds` ' +
        '(or reinstall) so the prebuilt binary is fetched. ' +
        `Last error: ${String(lastErr)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Transcribe audio to text locally via Whisper.
   *
   * @param audioBuffer - Encoded audio (mp3/wav/ogg/webm/m4a). Decoded to
   *                       16 kHz mono PCM via ffmpeg before inference.
   * @param options     - Optional language hint.
   * @returns Transcription result with text and detected/requested language.
   * @throws Error if `@huggingface/transformers` or ffmpeg is absent, or
   *         model load / decoding fails.
   */
  async transcribe(audioBuffer: Buffer, options: STTOptions = {}): Promise<STTResult> {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      throw new TypeError('WhisperLocalSTT.transcribe: audioBuffer must be a non-empty Buffer');
    }

    const startMs = Date.now();
    const samples = await decodeToPcm16k(audioBuffer);
    const audioMs = Math.round((samples.length / TARGET_SAMPLE_RATE) * 1000);

    log.info({ samples: samples.length, audioMs, language: options.language }, 'Calling Whisper local STT');

    const asr = await this.getPipeline();

    // chunk_length_s lets Whisper transcribe audio longer than its 30s window.
    // Language is only forwarded when supplied; otherwise Whisper auto-detects.
    const opts: Record<string, unknown> = { chunk_length_s: 30, stride_length_s: 5 };
    if (options.language) opts['language'] = options.language;

    const result = await asr(samples, opts);
    const text = (Array.isArray(result) ? result.map((r) => r.text ?? '').join(' ') : result.text ?? '').trim();
    const durationMs = Date.now() - startMs;

    log.info({ textLen: text.length, audioMs, durationMs }, 'Whisper local STT complete');

    return {
      text,
      language: options.language ?? 'en',
      confidence: 1.0,
      durationMs: audioMs,
    };
  }
}
