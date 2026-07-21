/**
 * @file grok-embeddings.ts
 * @description Subscription-free MANAGED-EMBEDDING RAG collections on the user's
 * Grok web session, distinct from the metered xAI API path.
 *
 * grok.com hosts a managed vector service: create a collection bound to a
 * grok embedding model, upload documents (grok chunks + embeds them
 * SERVER-SIDE), and poll indexing. All of these are seat-covered and
 * statsig-FREE (proven live 2026-07-21) — cookie auth only, no oracle:
 *   * models      -> GET  /rest/grok-for-teams/embedding-models
 *   * create      -> POST /rest/grok-for-teams/collections
 *   * list        -> GET  /rest/grok-for-teams/collections
 *   * delete      -> DELETE /rest/grok-for-teams/collections/{id}
 *   * metadata    -> GET  /rest/grok-for-teams/collections/{id}/metadata
 *   * addDocument -> POST /rest/grok-for-teams/collections/{id}/documents
 *   * listDocs    -> GET  /rest/grok-for-teams/collections/{id}/documents
 *
 * SCOPE LIMIT (verified live 2026-07-21): the semantic RETRIEVAL step
 * ("return relevant chunks for a query") is NOT statsig-free — it only exists
 * as the `collectionsSearch` tool inside `/rest/app-chat/conversations/new`,
 * which returns HTTP 403 "Request rejected by anti-bot rules" without a minted
 * x-statsig-id. So this capability wires the ingest + management half only.
 *
 * Reuses GW3 (session manager) + the embeddings bridge behind the shared
 * `SUDO_GROK_WEBSESSION` flag (default OFF). Secrets never logged; callers get
 * only ids / statuses back — never cookie material. No Playwright, no statsig.
 */

import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import {
  callGrokEmbeddingsBridge,
  type GrokEmbedCreds,
  type GrokEmbedCollection,
  type GrokEmbedDocument,
} from './grok-embeddings-bridge.js';
import { isGrokWebSessionEnabled, GrokWebDisabledError } from './grok-web-media.js';

const log = createLogger('llm:grok-embeddings');

export interface GrokEmbeddingsDeps {
  manager: GrokWebSessionManager;
  bridge: typeof callGrokEmbeddingsBridge;
}

export interface GrokCreatedCollection {
  collectionId: string;
  collectionName: string;
  modelName: string;
}

export interface GrokAddedDocument {
  fileId: string;
  docName: string;
  processingStatus: string;
  documentStatus: string;
}

export interface GrokCollectionMetadata {
  collectionId: string;
  collectionName: string;
  documentsCount: number;
  modelName: string;
}

function defaultDeps(): GrokEmbeddingsDeps {
  return { manager: getGrokWebSessionManager(), bridge: callGrokEmbeddingsBridge };
}

function credsOf(session: { cookie: string; userAgent: string }): GrokEmbedCreds {
  return { cookie: session.cookie, userAgent: session.userAgent };
}

/** Ensure the feature is on + the session is healthy (refreshing if needed). */
async function ready(deps: GrokEmbeddingsDeps): Promise<{ cookie: string; userAgent: string }> {
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
  return deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
}

function fail(op: string, r: { errorClass?: string; detail?: string }): never {
  throw new Error(`Grok embeddings ${op} failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`);
}

/** List the grok embedding models available to the seat. */
export async function listGrokEmbeddingModels(
  opts: { deps?: GrokEmbeddingsDeps } = {},
): Promise<string[]> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge({ op: 'models' }, credsOf(session));
  if (!r.ok) fail('models', r);
  log.info({ count: r.models?.length ?? 0 }, 'grok-embeddings models listed');
  return r.models ?? [];
}

/** Create a managed embedding collection bound to an embedding model. */
export async function createGrokCollection(
  name: string,
  opts: { model?: string; deps?: GrokEmbeddingsDeps } = {},
): Promise<GrokCreatedCollection> {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new TypeError('createGrokCollection: name must be a non-empty string');
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge(
    { op: 'create', name: trimmed, ...(opts.model ? { model: opts.model } : {}) },
    credsOf(session),
  );
  if (!r.ok || !r.collectionId) fail('create', r);
  log.info({ collectionId: r.collectionId }, 'grok-embeddings collection created');
  return {
    collectionId: r.collectionId,
    collectionName: r.collectionName ?? trimmed,
    modelName: r.modelName ?? '',
  };
}

/** List the seat's managed embedding collections. */
export async function listGrokCollections(
  opts: { deps?: GrokEmbeddingsDeps } = {},
): Promise<GrokEmbedCollection[]> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge({ op: 'list' }, credsOf(session));
  if (!r.ok) fail('list', r);
  return r.collections ?? [];
}

/** Delete a managed embedding collection (and its indexed documents). */
export async function deleteGrokCollection(
  collectionId: string,
  opts: { deps?: GrokEmbeddingsDeps } = {},
): Promise<void> {
  if (!collectionId?.trim()) throw new TypeError('deleteGrokCollection: collectionId required');
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge({ op: 'delete', collectionId }, credsOf(session));
  if (!r.ok) fail('delete', r);
  log.info({ collectionId }, 'grok-embeddings collection deleted');
}

/** Fetch metadata (documentsCount, model) for a collection. */
export async function getGrokCollectionMetadata(
  collectionId: string,
  opts: { deps?: GrokEmbeddingsDeps } = {},
): Promise<GrokCollectionMetadata> {
  if (!collectionId?.trim()) throw new TypeError('getGrokCollectionMetadata: collectionId required');
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge({ op: 'metadata', collectionId }, credsOf(session));
  if (!r.ok || !r.collectionId) fail('metadata', r);
  return {
    collectionId: r.collectionId,
    collectionName: r.collectionName ?? '',
    documentsCount: r.documentsCount ?? 0,
    modelName: r.modelName ?? '',
  };
}

/**
 * Add a document to a collection. grok chunks + embeds it server-side; indexing
 * is asynchronous — poll {@link listGrokDocuments} until status is PROCESSED.
 */
export async function addGrokDocument(
  collectionId: string,
  docName: string,
  content: Buffer,
  opts: { contentType?: string; deps?: GrokEmbeddingsDeps } = {},
): Promise<GrokAddedDocument> {
  if (!collectionId?.trim()) throw new TypeError('addGrokDocument: collectionId required');
  if (!docName?.trim()) throw new TypeError('addGrokDocument: docName required');
  if (!Buffer.isBuffer(content) || content.length === 0) {
    throw new TypeError('addGrokDocument: content must be a non-empty Buffer');
  }
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge(
    {
      op: 'add_doc',
      collectionId,
      docName,
      contentBase64: content.toString('base64'),
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
    },
    credsOf(session),
  );
  if (!r.ok || !r.fileId) fail('add_doc', r);
  log.info({ collectionId, fileId: r.fileId }, 'grok-embeddings document added');
  return {
    fileId: r.fileId,
    docName: r.docName ?? docName,
    processingStatus: r.processingStatus ?? 'Processing',
    documentStatus: r.documentStatus ?? '',
  };
}

/** List a collection's documents with their indexing status. */
export async function listGrokDocuments(
  collectionId: string,
  opts: { deps?: GrokEmbeddingsDeps } = {},
): Promise<GrokEmbedDocument[]> {
  if (!collectionId?.trim()) throw new TypeError('listGrokDocuments: collectionId required');
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge({ op: 'list_docs', collectionId }, credsOf(session));
  if (!r.ok) fail('list_docs', r);
  return r.documents ?? [];
}

export { GrokWebReloginRequiredError, GrokWebDisabledError, isGrokWebSessionEnabled };
