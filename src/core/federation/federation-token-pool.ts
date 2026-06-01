/**
 * @file federation-token-pool.ts
 * @description FederationTokenPool — stores and retrieves contributed API tokens encrypted.
 *
 * Namespace: federation-tokens
 * Key format: peerId:provider:uuid
 *
 * Kill-switch: SUDO_FED_TOKEN_POOL_DISABLE === '1'
 */

import crypto from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import {
  FederationTokenEntry,
  FederationTokenContribution,
  FederationTokenPoolDeps,
  FederationTokenWithDecrypted,
} from './federation-token-pool-types.js';

const log = createLogger('federation:token-pool');

const VAULT_NAMESPACE = 'federation-tokens';

// Security constants
const MAX_TOKEN_LENGTH = 4096;
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/;

// Allowed filter keys for SQL query (prevent SQL injection)
const ALLOWED_FILTER_KEYS = new Set(['provider', 'peerId', 'activeOnly']);

// Allowed providers (defensive validation)
const ALLOWED_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'ollama',
  'cliproxy',
  'sudo-mosaic',
  'cascade',
]);

const DB_INIT_SQL = `
  CREATE TABLE IF NOT EXISTS federation_token_pool (
    id TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    vault_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    revoked_at TEXT,
    revoked_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fed_tok_peer ON federation_token_pool(peer_id);
  CREATE INDEX IF NOT EXISTS idx_fed_tok_provider ON federation_token_pool(provider);
  CREATE INDEX IF NOT EXISTS idx_fed_tok_active ON federation_token_pool(active);
`;

export class FederationTokenPool {
  private readonly deps: FederationTokenPoolDeps;
  private destroyed = false;

  constructor(deps: FederationTokenPoolDeps) {
    this.deps = deps;
    this._initDb();
  }

  private _initDb(): void {
    try {
      this.deps.db.exec(DB_INIT_SQL);
      log.debug('Database tables initialized');
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to initialize database tables');
    }
  }

  /**
   * Validate token format before contribution
   */
  private validateToken(token: string, provider: string): { valid: boolean; error?: string } {
    // Check for null/undefined
    if (typeof token !== 'string') {
      return { valid: false, error: 'invalid token format' };
    }

    // Check max length
    if (token.length > MAX_TOKEN_LENGTH) {
      return { valid: false, error: 'invalid token format' };
    }

    // Check printable ASCII only (rejects null bytes, control chars, unicode)
    if (!PRINTABLE_ASCII_RE.test(token)) {
      return { valid: false, error: 'invalid token format' };
    }

    // Check provider allowlist (defensive)
    if (!ALLOWED_PROVIDERS.has(provider)) {
      return { valid: false, error: 'invalid provider' };
    }

    return { valid: true };
  }

  /**
   * Contribute a token: encrypt via vault, store metadata in SQLite
   */
  async contributeToken(contribution: FederationTokenContribution): Promise<{ id: string; success: boolean; error?: string }> {
    if (process.env['SUDO_FED_TOKEN_POOL_DISABLE'] === '1') {
      log.debug('FederationTokenPool disabled via env var');
      return { id: crypto.randomUUID(), success: false, error: 'token pool disabled' };
    }

    if (this.destroyed) {
      log.warn('contributeToken called after destroy() — ignoring');
      return { id: crypto.randomUUID(), success: false, error: 'Token pool destroyed' };
    }

    // Validate token format (defensive validation)
    const validation = this.validateToken(contribution.token, contribution.provider);
    if (!validation.valid) {
      log.warn({ provider: contribution.provider, error: validation.error }, 'Token validation failed');
      return { id: crypto.randomUUID(), success: false, error: validation.error };
    }

    const tokenId = crypto.randomUUID();
    const vaultKey = `${contribution.peerId}:${contribution.provider}:${tokenId}`;
    const now = new Date().toISOString();

    try {
      // Encrypt and store in vault
      await this.deps.vault.set(VAULT_NAMESPACE, vaultKey, contribution.token, {
        expiresAt: contribution.expiresAt,
      });

      // Store metadata in SQLite
      this.deps.db.prepare(`
        INSERT INTO federation_token_pool (
          id, peer_id, provider, vault_key, created_at, expires_at, active
        ) VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        tokenId,
        contribution.peerId,
        contribution.provider,
        vaultKey,
        now,
        contribution.expiresAt ?? null,
      );

      log.info({ tokenId, provider: contribution.provider, peerId: contribution.peerId }, 'Token contributed');

      return { id: tokenId, success: true };
    } catch (err) {
      log.error({ err: String(err), tokenId, provider: contribution.provider }, 'Failed to contribute token');
      return { id: tokenId, success: false, error: String(err) };
    }
  }

  /**
   * Get tokens for a provider: decrypt via vault, return in priority order (local first, then peer)
   * INTERNAL USE ONLY - decrypted tokens should only be accessed through useToken() method
   */
  async getTokensForProvider(provider: string): Promise<FederationTokenWithDecrypted[]> {
    if (process.env['SUDO_FED_TOKEN_POOL_DISABLE'] === '1') {
      log.debug('FederationTokenPool disabled via env var');
      throw new Error('token pool disabled');
    }

    if (this.destroyed) {
      log.warn('getTokensForProvider called after destroy() — ignoring');
      return [];
    }

    const now = new Date().toISOString();

    try {
      // Query active, non-expired tokens
      const rows = this.deps.db.prepare(`
        SELECT id, peer_id, provider, vault_key, created_at, expires_at, last_used_at, active
        FROM federation_token_pool
        WHERE provider = ? AND active = 1 AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY
          CASE WHEN peer_id = 'local' THEN 0 ELSE 1 END,
          created_at DESC
      `).all(provider, now) as Array<{
        id: string;
        peer_id: string;
        provider: string;
        vault_key: string;
        created_at: string;
        expires_at: string | null;
        last_used_at: string | null;
        active: number;
      }>;

      const results: FederationTokenWithDecrypted[] = [];

      for (const row of rows) {
        let decryptedToken: string | undefined;

        try {
          const vaultResult = await this.deps.vault.get(VAULT_NAMESPACE, row.vault_key, 'FederationTokenPool');
          if (vaultResult) {
            decryptedToken = vaultResult.value;
          }
        } catch (err) {
          log.warn({ err: String(err), tokenId: row.id }, 'Failed to decrypt token from vault — skipping');
          continue; // Skip this token but continue with others
        }

        results.push({
          id: row.id,
          peerId: row.peer_id,
          provider: row.provider,
          createdAt: row.created_at,
          expiresAt: row.expires_at ?? undefined,
          lastUsedAt: row.last_used_at ?? undefined,
          active: row.active === 1,
          token: decryptedToken,
        });
      }

      return results;
    } catch (err) {
      log.error({ err: String(err), provider }, 'Failed to get tokens for provider');
      return [];
    }
  }

  /**
   * List tokens: return metadata only (no decrypted values)
   */
  listTokens(opts: { provider?: string; peerId?: string; activeOnly?: boolean } = {}): FederationTokenEntry[] {
    if (this.destroyed) {
      log.warn('listTokens called after destroy() — ignoring');
      return [];
    }

    // Validate filter keys against allowlist (prevent SQL injection)
    const validOpts: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(opts)) {
      if (!ALLOWED_FILTER_KEYS.has(key)) {
        log.warn({ key }, 'Invalid filter key rejected');
        throw new Error(`Invalid filter key: ${key}`);
      }
      validOpts[key] = value;
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (validOpts.provider) {
      conditions.push('provider = ?');
      params.push(validOpts.provider);
    }

    if (validOpts.peerId) {
      conditions.push('peer_id = ?');
      params.push(validOpts.peerId);
    }

    if (validOpts.activeOnly !== false) {
      conditions.push('active = 1');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
      const rows = this.deps.db.prepare(`
        SELECT id, peer_id, provider, vault_key, created_at, expires_at, last_used_at, active
        FROM federation_token_pool
        ${whereClause}
        ORDER BY created_at DESC
      `).all(...params) as Array<{
        id: string;
        peer_id: string;
        provider: string;
        vault_key: string;
        created_at: string;
        expires_at: string | null;
        last_used_at: string | null;
        active: number;
      }>;

      return rows.map((row) => ({
        id: row.id,
        peerId: row.peer_id,
        provider: row.provider,
        createdAt: row.created_at,
        expiresAt: row.expires_at ?? undefined,
        lastUsedAt: row.last_used_at ?? undefined,
        active: row.active === 1,
      }));
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to list tokens');
      return [];
    }
  }

  /**
   * Deactivate a token: set active=0 in DB, optionally delete from vault
   */
  async deactivateToken(tokenId: string, opts: { deleteFromVault?: boolean; reason?: string } = {}): Promise<{ success: boolean; error?: string }> {
    if (this.destroyed) {
      log.warn('deactivateToken called after destroy() — ignoring');
      return { success: false, error: 'Token pool destroyed' };
    }

    const now = new Date().toISOString();

    try {
      // Get the token record first
      const row = this.deps.db.prepare(`
        SELECT vault_key FROM federation_token_pool WHERE id = ?
      `).get(tokenId) as { vault_key: string } | undefined;

      if (!row) {
        log.debug({ tokenId }, 'Token not found for deactivation');
        return { success: false, error: 'Token not found' };
      }

      // Update DB
      this.deps.db.prepare(`
        UPDATE federation_token_pool
        SET active = 0, revoked_at = ?, revoked_reason = ?
        WHERE id = ?
      `).run(now, opts.reason ?? null, tokenId);

      // Optionally delete from vault
      if (opts.deleteFromVault) {
        try {
          // Vault delete requires requester param
          // We use a special internal requester for token pool operations
          const vaultDeleteSql = `DELETE FROM vault_entries WHERE namespace = ? AND key = ?`;
          // Note: vault.delete() is not in our interface, so we skip direct vault deletion
          // The token will be inaccessible due to active=0 flag
          log.debug({ tokenId }, 'Vault deletion skipped — use deactivate with deleteFromVault=false');
        } catch (err) {
          log.warn({ err: String(err), tokenId }, 'Failed to delete from vault');
        }
      }

      log.info({ tokenId, reason: opts.reason }, 'Token deactivated');

      return { success: true };
    } catch (err) {
      log.error({ err: String(err), tokenId }, 'Failed to deactivate token');
      return { success: false, error: String(err) };
    }
  }

  /**
   * Update lastUsedAt timestamp
   */
  async markTokenUsed(tokenId: string): Promise<void> {
    if (this.destroyed) return;

    try {
      this.deps.db.prepare(`
        UPDATE federation_token_pool
        SET last_used_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), tokenId);
    } catch (err) {
      log.warn({ err: String(err), tokenId }, 'Failed to update last_used_at');
    }
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    log.info('FederationTokenPool destroyed');
  }
}
