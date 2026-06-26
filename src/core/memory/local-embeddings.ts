/**
 * @file local-embeddings.ts
 * @description LocalEmbeddingProvider — on-device, offline, key-free text
 * embeddings for the memory subsystem's vector fallback.
 *
 * When OpenAI embeddings are unavailable (quota exhausted, circuit-open, or no
 * API key) the {@link EmbeddingService} returns null and hybrid-search degrades
 * to BM25-only. This provider restores *semantic* recall in that state by
 * embedding text locally through an ONNX feature-extraction model
 * (`Xenova/all-MiniLM-L6-v2` by default → 384-dim, normalised) run via
 * `@huggingface/transformers` — the same onnxruntime stack Whisper STT / Kokoro
 * TTS use. No API key and no network call at embed time; the only network use is
 * a one-time model-weight download on first embed (cached by transformers).
 *
 * Local vectors are NOT comparable to OpenAI's 1536-dim vectors, so they live in
 * their own `chunks_vec_local` (FLOAT[384]) table and are only ever queried
 * against a locally-embedded query — never mixed with the OpenAI space.
 *
 * `@huggingface/transformers` is imported lazily (mirroring whisper-local.ts /
 * kokoro.ts), so there is ZERO boot penalty: the model is fetched/initialised
 * only on the first embed call, never at process start.
 *
 * Env overrides:
 *   SUDO_LOCAL_EMBED=0           — disable local embeddings entirely (pure
 *                                  OpenAI/BM25 behaviour, as before this feature)
 *   SUDO_LOCAL_EMBED_MODEL=<repo> — model id (default Xenova/all-MiniLM-L6-v2)
 *   SUDO_LOCAL_EMBED_DEVICE=<dev> — cpu|cuda (default cpu)
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('memory:local-embeddings');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default local model — all-MiniLM-L6-v2 emits 384-dim normalised vectors. */
const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DEVICE = 'cpu';

/**
 * Embedding dimension of the default local model. The `chunks_vec_local` vec0
 * table is declared FLOAT[384] to match — a model whose output dimension is not
 * this value is rejected (returns null) rather than silently corrupting the
 * index. Changing the model dimension is a follow-up (needs a new table dim +
 * re-backfill), deliberately out of v1 scope.
 */
export const LOCAL_EMBED_DIM = 384;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of the tensor returned by the feature-extraction pipeline. */
interface FeatureTensorLike {
  /** e.g. [n, 384] after mean-pooling. */
  dims: number[];
  /** Flat Float32Array of length n * dim. */
  data: Float32Array;
}

/** Minimal shape of the feature-extraction pipeline. */
interface FeatureExtractorLike {
  (
    texts: string[],
    opts?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
  ): Promise<FeatureTensorLike>;
}

// ---------------------------------------------------------------------------
// Lazy pipeline singleton
//
// Loading the model is expensive (one-time weight download + ONNX session init),
// so it is shared across instances and only created on first embed. A failed
// load clears the cache so a later call can retry.
// ---------------------------------------------------------------------------

let _extractorPromise: Promise<FeatureExtractorLike> | null = null;

// ---------------------------------------------------------------------------
// LocalEmbeddingProvider
// ---------------------------------------------------------------------------

/**
 * Generates 384-dim normalised embeddings locally via an ONNX model.
 *
 * `embed`/`embedBatch` return null (or null entries) on load/inference failure
 * so callers degrade gracefully — never throw into the search/backfill path.
 * `isAvailable` mirrors {@link EmbeddingService} so this can stand in as a
 * `BackfillEmbedder`.
 */
export class LocalEmbeddingProvider {
  /** True when local embeddings should be used (SUDO_LOCAL_EMBED != 0). */
  readonly available: boolean;
  /** The vector dimension this provider emits. */
  readonly dim = LOCAL_EMBED_DIM;
  private readonly modelId: string;
  private readonly device: string;

  constructor() {
    // Local embedding is the default fallback; available unless explicitly
    // disabled with SUDO_LOCAL_EMBED=0.
    const flag = process.env['SUDO_LOCAL_EMBED'];
    this.available = flag !== '0' && flag !== 'false';
    this.modelId = process.env['SUDO_LOCAL_EMBED_MODEL'] ?? DEFAULT_MODEL_ID;
    this.device = process.env['SUDO_LOCAL_EMBED_DEVICE'] ?? DEFAULT_DEVICE;

    if (this.available) {
      log.info({ modelId: this.modelId, dim: this.dim }, 'Local embedding provider enabled (lazy load on first use)');
    } else {
      log.debug('Local embedding provider disabled (SUDO_LOCAL_EMBED=0)');
    }
  }

  /** Mirrors EmbeddingService.isAvailable so this can be a BackfillEmbedder. */
  get isAvailable(): boolean {
    return this.available;
  }

  // -------------------------------------------------------------------------
  // Pipeline loading
  // -------------------------------------------------------------------------

  private async getExtractor(): Promise<FeatureExtractorLike> {
    if (!_extractorPromise) {
      _extractorPromise = this.loadExtractor();
      // Allow a later retry if this load fails.
      _extractorPromise.catch(() => {
        _extractorPromise = null;
      });
    }
    return _extractorPromise;
  }

  /**
   * Load the feature-extraction pipeline, falling back across execution-provider
   * devices so the first embed survives an unavailable backend.
   *
   * Under Node, @huggingface/transformers only supports `cpu` (onnxruntime-node)
   * and `cuda` — there is no browser-only `wasm` device. So a non-cpu device
   * that fails to load retries on `cpu`, which is universally available. fp32 is
   * used (vs a quantised dtype) for embedding accuracy; the model is tiny (~23MB).
   */
  private async loadExtractor(): Promise<FeatureExtractorLike> {
    let mod: { pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<unknown> };
    try {
      mod = (await import('@huggingface/transformers')) as unknown as typeof mod;
    } catch (err) {
      throw new Error(
        '@huggingface/transformers is not installed — run `pnpm add @huggingface/transformers` ' +
          `to enable local embeddings (${String(err)})`,
      );
    }

    const candidates = this.device === 'cpu' ? ['cpu'] : [this.device, 'cpu'];
    let lastErr: unknown;

    for (const device of candidates) {
      try {
        log.info(
          { modelId: this.modelId, device },
          'Loading local embedding ONNX model (first run downloads weights, then cached)',
        );
        return (await mod.pipeline('feature-extraction', this.modelId, {
          dtype: 'fp32',
          device,
        })) as FeatureExtractorLike;
      } catch (err) {
        lastErr = err;
        log.warn({ device, err: String(err) }, 'Local embedding model load failed on device');
      }
    }

    throw new Error(
      `Local embedding model load failed (devices tried: ${candidates.join(', ')}). ` +
        'If this is a native onnxruntime-node binding error, run `pnpm approve-builds` ' +
        '(or reinstall) so the prebuilt binary is fetched. ' +
        `Last error: ${String(lastErr)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Embed a single string locally.
   *
   * @param text - Input text to embed.
   * @returns A {@link LOCAL_EMBED_DIM}-dimension normalised Float32Array, or null
   *          if disabled / model load / inference failed (caller degrades).
   */
  async embed(text: string): Promise<Float32Array | null> {
    const [vec] = await this.embedBatch([text]);
    return vec ?? null;
  }

  /**
   * Embed multiple texts in a single pooled inference call.
   *
   * @param texts - Array of input strings.
   * @returns Array of normalised Float32Array (same order). The whole array is
   *          null-filled if the provider is disabled or inference fails — a
   *          local-embed failure is never fatal to the caller.
   */
  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    if (!this.available) return texts.map(() => null);
    if (texts.length === 0) return [];

    let tensor: FeatureTensorLike;
    try {
      const extractor = await this.getExtractor();
      // mean-pool token embeddings + L2-normalise → one unit vector per input.
      tensor = await extractor(texts, { pooling: 'mean', normalize: true });
    } catch (err) {
      log.warn({ err: String(err), count: texts.length }, 'Local embedding inference failed — degrading');
      return texts.map(() => null);
    }

    const dim = tensor.dims[tensor.dims.length - 1] ?? 0;
    if (dim !== LOCAL_EMBED_DIM) {
      // A model whose dimension does not match the vec0 table would corrupt the
      // index — refuse rather than write a wrong-width vector.
      log.warn({ dim, expected: LOCAL_EMBED_DIM }, 'Local embedding dimension mismatch — skipping (model change needs a new table)');
      return texts.map(() => null);
    }

    // The flat Float32Array holds texts.length consecutive `dim`-length rows.
    const out: (Float32Array | null)[] = new Array(texts.length).fill(null);
    for (let i = 0; i < texts.length; i++) {
      const start = i * dim;
      // .slice copies the bytes into a standalone, 4-byte-aligned typed array.
      out[i] = tensor.data.slice(start, start + dim);
    }
    return out;
  }
}

/** Test-only: reset the shared lazy pipeline between cases. */
export function __resetLocalEmbedder(): void {
  _extractorPromise = null;
}
