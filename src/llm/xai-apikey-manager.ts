/**
 * @file xai-apikey-manager.ts
 * @description GP3 — the `xai` (metered API-key) provider's OWN credential
 * store, kept fully independent of the OAuth token store (data/xai-oauth.json).
 * Setting/clearing one method never touches the other (core GP requirement).
 *
 * Persists to <DATA_DIR>/xai-apikey.json (0600, atomic tmp+rename):
 *   { apiKey, defaultModel?, models?, modelsFetchedAt? }
 * The API key is NEVER logged (length/booleans only). Mirrors the picker-state
 * shape of claude-oauth-manager so the CLI + web surfaces treat both methods
 * uniformly.
 *
 * Back-compat: getApiKey() falls back to the XAI_API_KEY env var when the store
 * is empty, so an operator who set the env before this store existed keeps
 * working. `xai apikey set` writes the store (the forward path).
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../core/shared/paths.js';
import { writeFileAtomic } from '../core/shared/atomic-write.js';
import { createLogger } from '../core/shared/logger.js';
import type { XaiModelEntry } from './xai-models.js';

const log = createLogger('llm:xai-apikey');

const DEFAULT_STORE_PATH = path.join(DATA_DIR, 'xai-apikey.json');

/** On-disk shape. Unknown keys from older writers are dropped on next persist. */
export interface XaiApiKeyStore {
  apiKey: string;
  /** User-picked default model id for the `xai` method. */
  defaultModel?: string;
  /** Cached live model list (from XaiModelDiscovery.refresh('apikey')). */
  models?: XaiModelEntry[];
  /** ms epoch when `models` was cached. */
  modelsFetchedAt?: number;
}

export interface XaiApiKeyStatus {
  /** True when a key is resolvable (store or XAI_API_KEY env). */
  connected: boolean;
  /** Where the active key came from — for status display, never the value. */
  source: 'store' | 'env' | null;
  defaultModel: string | null;
  modelsCount: number;
}

export class XaiApiKeyManager {
  private readonly storePath: string;
  private readonly now: () => number;

  constructor(storePath: string = DEFAULT_STORE_PATH, now: () => number = () => Date.now()) {
    this.storePath = storePath;
    this.now = now;
  }

  private loadStore(): XaiApiKeyStore | null {
    try {
      if (!existsSync(this.storePath)) return null;
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8')) as Record<string, unknown>;
      const apiKey = raw['apiKey'];
      if (typeof apiKey !== 'string' || apiKey === '') return null;
      const store: XaiApiKeyStore = { apiKey };
      if (typeof raw['defaultModel'] === 'string') store.defaultModel = raw['defaultModel'];
      if (Array.isArray(raw['models'])) store.models = raw['models'] as XaiModelEntry[];
      if (typeof raw['modelsFetchedAt'] === 'number') store.modelsFetchedAt = raw['modelsFetchedAt'];
      return store;
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to load xAI API-key store');
      return null;
    }
  }

  private saveStore(store: XaiApiKeyStore): void {
    writeFileAtomic(this.storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
    log.debug({ path: this.storePath, keyLen: store.apiKey.length }, 'xAI API-key store persisted');
  }

  /** Persist a new API key (creates/overwrites the store, preserving picker state). */
  setApiKey(apiKey: string): void {
    const key = apiKey.trim();
    if (key === '') throw new Error('xAI API key must be a non-empty string');
    const prev = this.loadStore();
    this.saveStore({
      apiKey: key,
      defaultModel: prev?.defaultModel,
      models: prev?.models,
      modelsFetchedAt: prev?.modelsFetchedAt,
    });
    log.info({ keyLen: key.length }, 'xAI API key stored');
  }

  /** Resolve the active key: store first, then XAI_API_KEY env. Null when neither. */
  getApiKey(): string | null {
    const stored = this.loadStore()?.apiKey;
    if (stored) return stored;
    return process.env['XAI_API_KEY']?.trim() || null;
  }

  /** Wipe the store file (env key, if any, is untouched — that's operator-owned). */
  disconnect(): void {
    try {
      unlinkSync(this.storePath);
      log.info('xAI API-key store wiped');
    } catch {
      /* already gone */
    }
  }

  status(): XaiApiKeyStatus {
    const store = this.loadStore();
    const source: 'store' | 'env' | null = store
      ? 'store'
      : process.env['XAI_API_KEY']?.trim()
        ? 'env'
        : null;
    return {
      connected: source !== null,
      source,
      defaultModel: this.getDefaultModel(),
      modelsCount: store?.models?.length ?? 0,
    };
  }

  // --- model cache + default (mirror the oauth manager) ---------------------

  listModels(): XaiModelEntry[] {
    return this.loadStore()?.models ?? [];
  }

  getDefaultModel(): string | null {
    const store = this.loadStore();
    if (!store) return null;
    const cached = store.models ?? [];
    const picked = store.defaultModel;
    if (picked && (cached.length === 0 || cached.some((m) => m.id === picked))) return picked;
    return cached[0]?.id ?? null;
  }

  setDefaultModel(id: string): boolean {
    const store = this.loadStore();
    if (!store) return false;
    const cached = store.models ?? [];
    if (cached.length > 0 && !cached.some((m) => m.id === id)) {
      log.warn({ id }, 'xai apikey setDefaultModel: id not in cached model list');
      return false;
    }
    this.saveStore({ ...store, defaultModel: id });
    log.info({ id }, 'xai apikey default model set');
    return true;
  }

  setModels(models: XaiModelEntry[]): void {
    const store = this.loadStore();
    if (!store) return;
    this.saveStore({ ...store, models, modelsFetchedAt: this.now() });
  }
}

let singleton: XaiApiKeyManager | null = null;

/** Process-wide manager over <DATA_DIR>/xai-apikey.json, created lazily. */
export function getXaiApiKeyManager(): XaiApiKeyManager {
  if (!singleton) singleton = new XaiApiKeyManager();
  return singleton;
}

/** Reset the singleton — for tests only. */
export function __resetXaiApiKeyManager(): void {
  singleton = null;
}
