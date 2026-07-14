/**
 * @file embeddings.ts
 * @description EmbeddingService — generates and caches OpenAI text embeddings.
 *
 * Design decisions:
 *  - Uses the src/llm client embed() choke point (one attempt per call) rather
 *    than the OpenAI SDK — this module still owns retry/backoff/circuit policy.
 *  - Embeddings are cached in embedding_cache by SHA-256 hash of the input
 *    text, so identical text never hits the API twice.
 *  - If OPENAI_API_KEY is not set, embed() returns null and callers degrade
 *    to BM25-only search gracefully.
 */

import { createHash } from 'node:crypto';
import { embed as llmEmbed, embeddingsAvailable } from '../../llm/client.js';
import type { MindDB } from './db.js';

/** Default model — 1536 dimensions, cheap and accurate */
const DEFAULT_MODEL = 'text-embedding-3-small';

/** Maximum texts per batch request (OpenAI allows up to 2048, we use a safe limit) */
const BATCH_SIZE = 100;

/**
 * Retry/backoff configuration for transient embedding-API failures.
 *
 * Behaviour-neutral on success (same result, just retried on a transient
 * 429 / 5xx / network error). The final-failure contract is UNCHANGED: once
 * the attempts are exhausted the same error throws as before. Disable with
 * SUDO_EMBED_BACKOFF=0 (then it makes exactly one attempt, as the old code did).
 */
const BACKOFF_MAX_ATTEMPTS = 4;
/** Base delay for exponential backoff; override (e.g. to 1) in tests for speed. */
const BACKOFF_DEFAULT_BASE_MS = 500;
/** Hard ceiling on any single backoff sleep. */
const BACKOFF_MAX_DELAY_MS = 30_000;

/**
 * Circuit-breaker for persistent provider quota exhaustion (B8.1).
 *
 * When the OpenAI embedding quota is exhausted, EVERY call 429s — even with the
 * backoff above each call still burns 4 API hits + sleeps, and the survey saw
 * ~31 such hits hammering a dead quota. After N consecutive terminal 429s the
 * circuit OPENS for a cooldown: callers fail fast (no network) and degrade to
 * BM25, instead of repeatedly hammering the exhausted API. On expiry one probe
 * call is allowed through; success closes the circuit, another 429 re-opens it.
 *
 * The circuit does NOT fix the quota (operator billing) — it makes the
 * degradation cheap and VISIBLE (one clear warn per outage). Disable with
 * SUDO_EMBED_CIRCUIT=0 (restores the pre-circuit always-attempt behaviour).
 */
const CIRCUIT_DEFAULT_THRESHOLD = 3;
/** Default cooldown once the circuit opens (10 min — inside the 5–15 min band). */
const CIRCUIT_DEFAULT_COOLDOWN_MS = 600_000;

/**
 * Shared circuit state. Module-level (NOT per-instance) because the OpenAI
 * quota is global to the API key — one exhausted quota should silence every
 * EmbeddingService in the process, not just the instance that first tripped.
 */
interface EmbedCircuitState {
  /** Consecutive terminal-429 calls without an intervening success. */
  consecutive429: number;
  /** Epoch ms until which the circuit is OPEN (0 = closed). */
  openUntil: number;
  /** True once the OPEN was logged — keeps the warn to one per outage episode. */
  loggedOpen: boolean;
}
const embedCircuit: EmbedCircuitState = { consecutive429: 0, openUntil: 0, loggedOpen: false };

/** Test-only: reset the shared circuit between cases. */
export function __resetEmbedCircuit(): void {
  embedCircuit.consecutive429 = 0;
  embedCircuit.openUntil = 0;
  embedCircuit.loggedOpen = false;
}

// ---------------------------------------------------------------------------
// EmbeddingService
// ---------------------------------------------------------------------------

/**
 * Generates vector embeddings via the OpenAI API with transparent local caching.
 *
 * When no API key is configured, all methods return null/nulls so callers
 * can degrade gracefully to text-only search.
 */
export class EmbeddingService {
  private readonly db: MindDB;
  private readonly model: string;
  /**
   * Snapshot of embeddings-route availability at construction time (was: the
   * raw OPENAI_API_KEY). The actual key/URL now lives behind the src/llm
   * choke point — this field only preserves the old "no key → degrade to
   * BM25" gating semantics.
   */
  private readonly apiAvailable: boolean;
  /** When false (SUDO_EMBED_BACKOFF=0), make a single attempt — the old behaviour. */
  private readonly backoffEnabled: boolean;
  /** Base backoff delay in ms (SUDO_EMBED_BACKOFF_BASE_MS overrides; tests use 1). */
  private readonly backoffBaseMs: number;
  /** When false (SUDO_EMBED_CIRCUIT=0), never open the quota circuit-breaker. */
  private readonly circuitEnabled: boolean;
  /** Consecutive terminal-429s that open the circuit (SUDO_EMBED_CIRCUIT_THRESHOLD). */
  private readonly circuitThreshold: number;
  /** How long the circuit stays open once tripped (SUDO_EMBED_CIRCUIT_COOLDOWN_MS). */
  private readonly circuitCooldownMs: number;

  /**
   * @param db    - MindDB instance used for embedding_cache persistence.
   * @param model - Embedding model identifier (default: text-embedding-3-small).
   */
  constructor(db: MindDB, model = DEFAULT_MODEL) {
    this.db    = db;
    this.model = model;
    this.apiAvailable = embeddingsAvailable();
    this.backoffEnabled = process.env['SUDO_EMBED_BACKOFF'] !== '0';
    const baseMs = Number(process.env['SUDO_EMBED_BACKOFF_BASE_MS']);
    this.backoffBaseMs = Number.isFinite(baseMs) && baseMs >= 0 ? baseMs : BACKOFF_DEFAULT_BASE_MS;
    this.circuitEnabled = process.env['SUDO_EMBED_CIRCUIT'] !== '0';
    const thr = Number(process.env['SUDO_EMBED_CIRCUIT_THRESHOLD']);
    this.circuitThreshold = Number.isFinite(thr) && thr >= 1 ? Math.floor(thr) : CIRCUIT_DEFAULT_THRESHOLD;
    const cd = Number(process.env['SUDO_EMBED_CIRCUIT_COOLDOWN_MS']);
    this.circuitCooldownMs = Number.isFinite(cd) && cd >= 0 ? cd : CIRCUIT_DEFAULT_COOLDOWN_MS;

    if (!this.apiAvailable) {
      console.warn('[EmbeddingService] OPENAI_API_KEY not set — running in BM25-only mode');
    }
  }

  /** True when an API key is available and embedding calls can succeed */
  get isAvailable(): boolean {
    // Also honor the quota circuit: while it's OPEN (after 429s) every embed call
    // throws immediately, so callers gating on isAvailable would otherwise pay one
    // wasted exception per query for the whole cooldown window (RAG-7).
    if (!this.apiAvailable) return false;
    return !this.circuitEnabled || embedCircuit.openUntil <= Date.now();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generate (or retrieve from cache) the embedding for a single string.
   *
   * @param text - Input text to embed.
   * @returns A 1536-dimension Float32Array, or null if no API key is set.
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (!this.apiAvailable) return null;

    const hash = this._cacheKey(text);

    // Check cache first (synchronous — cheaper than any async path)
    const cached = this._getCached(hash);
    if (cached) return cached;

    // Fetch from API
    const vectors = await this._fetchEmbeddings([text]);
    if (vectors.length === 0) return null;

    const embedding = vectors[0]!;
    this._putCached(hash, embedding);
    return embedding;
  }

  /**
   * Generate embeddings for multiple texts in a single batched API call.
   * Results are cached individually so subsequent single-text calls are free.
   *
   * @param texts - Array of input strings.
   * @returns Array of Float32Array (same order as input). null entries mean
   *          the text was skipped due to an API failure.
   */
  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    if (!this.apiAvailable) return texts.map(() => null);
    if (texts.length === 0) return [];

    const results: (Float32Array | null)[] = new Array(texts.length).fill(null);
    const toFetch: Array<{ idx: number; text: string; hash: string }> = [];

    // Populate from cache where possible
    for (let i = 0; i < texts.length; i++) {
      const hash = this._cacheKey(texts[i]!);
      const cached = this._getCached(hash);
      if (cached) {
        results[i] = cached;
      } else {
        toFetch.push({ idx: i, text: texts[i]!, hash });
      }
    }

    if (toFetch.length === 0) return results;

    // Chunk into safe batch sizes
    for (let offset = 0; offset < toFetch.length; offset += BATCH_SIZE) {
      const chunk = toFetch.slice(offset, offset + BATCH_SIZE);
      const vectors = await this._fetchEmbeddings(chunk.map((c) => c.text));

      for (let j = 0; j < chunk.length; j++) {
        const item = chunk[j]!;
        const vec  = vectors[j] ?? null;
        results[item.idx] = vec;
        if (vec) {
          this._putCached(item.hash, vec);
        }
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Private: OpenAI API
  // -------------------------------------------------------------------------

  /**
   * Call the OpenAI embeddings endpoint for a batch of texts.
   * Returns vectors in the same order as the input array.
   *
   * Transient failures (HTTP 429, 5xx, or a network-level fetch throw) are
   * retried with exponential backoff + jitter, up to BACKOFF_MAX_ATTEMPTS,
   * when backoff is enabled (default). A successful response returns exactly
   * as before; once retries are exhausted the same error throws as the
   * pre-backoff code did (final-failure contract unchanged).
   */
  private async _fetchEmbeddings(texts: string[]): Promise<Float32Array[]> {
    // Circuit OPEN — skip the API entirely so we don't hammer an exhausted
    // quota. The OPEN was already logged once; throw fast so callers degrade to
    // BM25 exactly as they do for any other terminal embedding failure.
    if (this.circuitEnabled && embedCircuit.openUntil > Date.now()) {
      throw new Error('[EmbeddingService] embedding circuit OPEN — provider quota/429, degrading');
    }

    const maxAttempts = this.backoffEnabled ? BACKOFF_MAX_ATTEMPTS : 1;
    let lastNetworkError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // One attempt through the src/llm choke point (llm client embed() makes
        // no retries of its own — this loop owns the retry/circuit policy).
        const result = await llmEmbed(
          texts,
          { caller: 'rag', purpose: 'hybrid-RAG dense embeddings' },
          { model: this.model },
        );

        // A success closes the circuit / resets the consecutive-429 counter.
        this._recordEmbedSuccess();

        // embed() already returns vectors sorted by input index.
        return result.embeddings.map((embedding) => new Float32Array(embedding));
      } catch (err) {
        const status = (err as Error & { status?: number }).status;

        if (typeof status === 'number') {
          // Non-2xx HTTP response — same classification as the old response.ok branch.
          const retryable = status === 429 || status >= 500;
          if (retryable && attempt < maxAttempts) {
            await this._sleep(this._backoffDelayMs(attempt));
            continue;
          }
          // Terminal failure. A terminal 429 is a quota/rate signal — feed it to
          // the circuit-breaker so sustained exhaustion opens the circuit and
          // callers stop hammering the dead API.
          if (status === 429) this._recordQuota429();
          // Preserve the historical error shape ("API error <status>: <body>").
          const body = (err as Error).message.replace(/^\[llm-client\] embed failed: \d+ ?/, '');
          throw new Error(`[EmbeddingService] API error ${status}: ${body}`);
        }

        // Network-level failure (DNS, connection reset, etc.) — retryable.
        lastNetworkError = err;
        if (attempt < maxAttempts) {
          await this._sleep(this._backoffDelayMs(attempt));
          continue;
        }
        throw err;
      }
    }

    // Unreachable in practice: the loop either returns, or throws on the final
    // attempt. Kept so the function is total if maxAttempts were ever 0.
    throw lastNetworkError instanceof Error
      ? lastNetworkError
      : new Error('[EmbeddingService] embedding fetch failed');
  }

  /**
   * Record a terminal 429 toward the shared quota circuit-breaker. Once the
   * consecutive count reaches the threshold the circuit OPENS for the cooldown
   * window and logs ONCE per outage episode (loggedOpen stays set until a
   * success resets it — sustained outages do not spam the log).
   */
  private _recordQuota429(): void {
    if (!this.circuitEnabled) return;
    embedCircuit.consecutive429++;
    if (embedCircuit.consecutive429 >= this.circuitThreshold) {
      embedCircuit.openUntil = Date.now() + this.circuitCooldownMs;
      if (!embedCircuit.loggedOpen) {
        embedCircuit.loggedOpen = true;
        // VISIBLE, not silent — one clear warn so the degradation is obvious.
        console.warn(
          `[EmbeddingService] embedding circuit OPEN: provider quota/429 — degrading to BM25; restore billing ` +
          `(threshold=${this.circuitThreshold}, cooldown=${Math.round(this.circuitCooldownMs / 1000)}s, ` +
          `disable with SUDO_EMBED_CIRCUIT=0)`,
        );
      }
    }
  }

  /** A successful embedding closes the circuit and resets the 429 counter. */
  private _recordEmbedSuccess(): void {
    if (embedCircuit.consecutive429 !== 0 || embedCircuit.openUntil !== 0 || embedCircuit.loggedOpen) {
      embedCircuit.consecutive429 = 0;
      embedCircuit.openUntil = 0;
      embedCircuit.loggedOpen = false;
    }
  }

  /** Exponential backoff with full jitter, capped at BACKOFF_MAX_DELAY_MS. */
  private _backoffDelayMs(attempt: number): number {
    const exp = this.backoffBaseMs * 2 ** (attempt - 1);
    const jitter = Math.random() * exp * 0.5;
    return Math.min(exp + jitter, BACKOFF_MAX_DELAY_MS);
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // -------------------------------------------------------------------------
  // Private: Cache (synchronous — better-sqlite3)
  // -------------------------------------------------------------------------

  private _getCached(hash: string): Float32Array | null {
    const row = this.db.db
      .prepare<{ hash: string; model: string }, { embedding: Buffer }>(
        'SELECT embedding FROM embedding_cache WHERE hash = :hash AND model = :model',
      )
      .get({ hash, model: this.model });

    if (!row) return null;

    // Stored as raw IEEE-754 float32 bytes in a BLOB
    return new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
  }

  private _putCached(hash: string, embedding: Float32Array): void {
    const blob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache (hash, embedding, model)
      VALUES (:hash, :embedding, :model)
    `).run({ hash, embedding: blob, model: this.model });
  }

  // -------------------------------------------------------------------------
  // Private: utilities
  // -------------------------------------------------------------------------

  private _sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }

  /**
   * Cache key = SHA-256 of (model + text). embedding_cache has `hash` as its
   * sole PRIMARY KEY, so keying on the text alone let a second model's write
   * REPLACE the first model's row for the same text — causing cross-model
   * cache thrashing (each model evicting the other). Folding the model into
   * the hash gives distinct models distinct keys so their rows coexist, with
   * no schema/PK migration required.
   */
  private _cacheKey(text: string): string {
    return this._sha256(`${this.model}\x00${text}`);
  }
}
