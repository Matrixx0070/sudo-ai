/**
 * @file grok-connector.ts
 * @description Single robust connector fronting ALL free grok.com web-seat
 * services (brain/chat, image, video) for sudo-ai. One seam so every grok
 * capability shares the same plumbing and robustness:
 *   - one durable web session (grok-web-session-manager)
 *   - one API-level statsig token pool (grok-statsig-pool) — pre-minted,
 *     oracle-backed, single-use tokens served instantly
 *   - one usage BUDGET (grok-budget) — per-run + per-day call ceilings that
 *     halt before draining the operator's shared SuperGrok weekly pool
 *   - uniform failover errors (429 rate-limit / budget exhausted) — never a
 *     metered-API fallback
 *
 * The connector is a thin FACADE: it budget-guards then delegates to the
 * existing per-service functions (grokWebComplete / generateGrokImage /
 * generateGrokVideo). It does not reimplement them. The IR brain provider
 * (grok-web-provider.callGrokWebIR) routes through `complete()` so agent turns
 * inherit the budget guard.
 */

import type { IRMessage, IRTool, IRContentBlock } from '../../shared-types/ir/v1.js';
import {
  grokWebComplete,
  generateGrokImage,
  generateGrokVideo,
  synthesizeGrokVoice,
  transcribeGrokVoice,
  type GrokImageResult,
  type GrokVideoResult,
  type GrokVoiceTtsResult,
  type GrokVoiceSttResult,
} from './grok-web-media.js';
import { grokRagQuery, type GrokRagInput, type GrokRagResult } from './grok-rag.js';
import {
  listGrokEmbeddingModels,
  createGrokCollection,
  addGrokDocument,
  listGrokCollections,
  listGrokDocuments,
  getGrokCollectionMetadata,
  deleteGrokCollection,
  searchGrokCollection,
  type GrokCreatedCollection,
  type GrokAddedDocument,
  type GrokCollectionSearchResult,
} from './grok-embeddings.js';
import type { GrokEmbedCollection, GrokEmbedDocument } from './grok-embeddings-bridge.js';
import { getGrokStatsigPool, type GrokStatsigPool } from './grok-statsig-pool.js';
import { GrokBudget, type GrokBudgetStatus } from './grok-budget.js';
import { createLogger } from '../core/shared/logger.js';

const log = createLogger('llm:grok-connector');

export interface GrokConnectorHealth {
  poolSize: number;
  budget: GrokBudgetStatus;
}

export class GrokConnector {
  private readonly budget: GrokBudget;
  private readonly pool: GrokStatsigPool;

  public constructor(deps: { budget?: GrokBudget; pool?: GrokStatsigPool } = {}) {
    this.budget = deps.budget ?? new GrokBudget();
    this.pool = deps.pool ?? getGrokStatsigPool();
  }

  /** Budget-guard + count a successful call. */
  private async run<T>(op: string, fn: () => Promise<T>): Promise<T> {
    this.budget.guard(); // throws GrokBudgetExhaustedError → caller fails over
    const r = await fn();
    this.budget.record();
    log.debug({ op, ...this.budget.status() }, 'grok connector call');
    return r;
  }

  /** Brain turn — IR blocks (tool_use or text). The agent-loop path. */
  public complete(
    messages: readonly IRMessage[],
    tools: readonly IRTool[],
    opts: { modelName?: string; system?: string; timeoutSec?: number } = {},
  ): Promise<IRContentBlock[]> {
    return this.run('complete', () => grokWebComplete(messages, tools, opts));
  }

  public image(
    prompt: string,
    opts: { aspectRatio?: string; numGenerations?: number; pro?: boolean } = {},
  ): Promise<GrokImageResult> {
    return this.run('image', () => generateGrokImage(prompt, opts));
  }

  public video(
    prompt: string,
    opts: { imageUrl?: string; aspectRatio?: string; videoLength?: number; resolutionName?: string } = {},
  ): Promise<GrokVideoResult> {
    return this.run('video', () => generateGrokVideo(prompt, opts));
  }

  /** Voice lane (statsig-free): text→speech and speech→text. */
  public readonly voice = {
    tts: (
      text: string,
      opts: { voice?: string; sanitize?: boolean; enableAlignment?: boolean } = {},
    ): Promise<GrokVoiceTtsResult> => this.run('voice.tts', () => synthesizeGrokVoice(text, opts)),
    stt: (
      audioBase64: string,
      opts: { audioFormat?: string; enhance?: boolean } = {},
    ): Promise<GrokVoiceSttResult> => this.run('voice.stt', () => transcribeGrokVoice(audioBase64, opts)),
  };

  /**
   * Grounded document Q&A (RAG): upload docs/texts to the seat, ask a question
   * grounded on them, get an answer. Statsig-gated (grounded query hits
   * app-chat), budget-guarded, free on the seat.
   */
  public rag(input: GrokRagInput): Promise<GrokRagResult> {
    return this.run('rag', () => grokRagQuery(input));
  }

  /**
   * Managed-embedding collections (statsig-free, server-side chunk+embed on the
   * seat). Consuming ops (create/add) are budget-guarded; reads are direct.
   */
  public readonly collections = {
    models: (): Promise<string[]> => listGrokEmbeddingModels(),
    create: (name: string, opts: { model?: string } = {}): Promise<GrokCreatedCollection> =>
      this.run('collections.create', () => createGrokCollection(name, opts)),
    add: (collectionId: string, docName: string, content: string | Buffer, opts: { contentType?: string } = {}): Promise<GrokAddedDocument> =>
      this.run('collections.add', () =>
        addGrokDocument(collectionId, docName, typeof content === 'string' ? Buffer.from(content, 'utf8') : content, opts),
      ),
    list: (): Promise<GrokEmbedCollection[]> => listGrokCollections(),
    listDocs: (collectionId: string): Promise<GrokEmbedDocument[]> => listGrokDocuments(collectionId),
    metadata: (collectionId: string) => getGrokCollectionMetadata(collectionId),
    delete: (collectionId: string): Promise<void> => deleteGrokCollection(collectionId),
    /** Search a collection → grounded answer (statsig-gated, budget-guarded). */
    search: (collectionId: string, query: string, opts: { modelName?: string } = {}): Promise<GrokCollectionSearchResult> =>
      this.run('collections.search', () => searchGrokCollection(collectionId, query, opts)),
  };

  /** Pre-warm the statsig pool so the first turn is instant. */
  public async prime(): Promise<void> {
    await this.pool.prime();
  }

  public health(): GrokConnectorHealth {
    return { poolSize: this.pool.size(), budget: this.budget.status() };
  }
}

// ---------------------------------------------------------------------------
// Process singleton.
// ---------------------------------------------------------------------------

let singleton: GrokConnector | null = null;

/** The shared grok connector — one session, one pool, one budget, all services. */
export function getGrokConnector(): GrokConnector {
  if (!singleton) singleton = new GrokConnector();
  return singleton;
}

/** Test hook. */
export function __resetGrokConnector(): void {
  singleton = null;
}
