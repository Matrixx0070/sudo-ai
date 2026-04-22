/**
 * @file tests/security/vault-credentials.test.ts
 * @description Unit tests for MCP-URL-bound credential vault.
 *
 * Coverage:
 *   - add: happy path (mcp_oauth + static_bearer)
 *   - add: URL uniqueness — second active cred on same URL rejected with 409
 *   - add: validation errors (missing access_token, bad URL, missing token)
 *   - list: returns metadata only — no secret fields
 *   - getMeta: returns metadata only — no secret fields
 *   - getMeta: throws 404 for unknown id
 *   - getCredential: returns decrypted secrets in-memory (by mcp_server_url)
 *   - getCredential: returns null for archived credential
 *   - getCredential: returns null for unknown URL
 *   - rotate: replaces secret payload, updates last_rotated_at
 *   - rotate: throws 409 for archived credential
 *   - archive: purges secret, marks archived
 *   - archive then re-add: same URL accepted after archive
 *   - OAuth daemon: skips non-near-expiry credentials
 *   - OAuth daemon: refreshes near-expiry credentials and swaps token atomically
 *   - OAuth daemon: handles token endpoint errors gracefully
 *   - static_bearer: getCredential returns token field
 *   - invalid namespace: rejected immediately
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mock vault.ts so we don't need disk I/O for encrypted storage.
// We replace vault.set/get/delete with an in-memory Map keyed by ns:key.
// ---------------------------------------------------------------------------

const vaultStore = new Map<string, string>();

vi.mock('../../src/core/security/vault.js', () => ({
  vault: {
    set: vi.fn(async (ns: string, key: string, value: string) => {
      vaultStore.set(`${ns}:${key}`, value);
    }),
    get: vi.fn(async (ns: string, key: string, _requester: string) => {
      const v = vaultStore.get(`${ns}:${key}`);
      if (v === undefined) return null;
      return { value: v, entry: { createdAt: new Date().toISOString() } };
    }),
    delete: vi.fn(async (ns: string, key: string, _requester: string) => {
      vaultStore.delete(`${ns}:${key}`);
    }),
  },
  VaultError: class VaultError extends Error {
    constructor(message: string, public readonly code: string) {
      super(message);
      this.name = 'VaultError';
    }
  },
}));

// ---------------------------------------------------------------------------
// Test environment setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-creds-test-'));
  // Point credential metadata files to an isolated temp dir per test
  process.env['SUDO_CRED_VAULT_DIR'] = tmpDir;
  process.env['NODE_ENV'] = 'test';
  vaultStore.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  delete process.env['SUDO_CRED_VAULT_DIR'];
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Import after mock registration (vi.mock is hoisted automatically)
// ---------------------------------------------------------------------------

import {
  CredentialStore,
  CredentialError,
  OAuthRefreshDaemon,
} from '../../src/core/security/vault-credentials.js';
import type { CredentialAuth } from '../../src/core/security/vault-credentials.js';

const MOCK_URL = 'https://mcp.example.com/mcp';
const MOCK_URL_2 = 'https://mcp.other.com/mcp';

// ---------------------------------------------------------------------------
// 1. add — mcp_oauth happy path
// ---------------------------------------------------------------------------

describe('add — mcp_oauth', () => {
  it('creates a credential and returns metadata without secrets', async () => {
    const store = new CredentialStore('testns');
    const meta = await store.add({
      type: 'mcp_oauth',
      mcp_server_url: MOCK_URL,
      access_token: 'tok_abc',
      refresh_token: 'rtok_xyz',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      token_url: 'https://auth.example.com/token',
      client_id: 'client123',
      client_secret: 'secret456',
    }, 'My Slack');

    expect(meta.id).toMatch(/^cred_/);
    expect(meta.type).toBe('mcp_oauth');
    expect(meta.mcp_server_url).toBe(MOCK_URL);
    expect(meta.display_name).toBe('My Slack');
    expect(meta.archived).toBe(false);
    expect(meta.created_at).toBeTruthy();
    // Verify NO secret fields on returned metadata
    expect((meta as Record<string, unknown>)['access_token']).toBeUndefined();
    expect((meta as Record<string, unknown>)['refresh_token']).toBeUndefined();
    expect((meta as Record<string, unknown>)['client_secret']).toBeUndefined();
    expect((meta as Record<string, unknown>)['token']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. add — static_bearer happy path
// ---------------------------------------------------------------------------

describe('add — static_bearer', () => {
  it('creates a static bearer credential and returns metadata without token', async () => {
    const store = new CredentialStore('testns');
    const meta = await store.add({
      type: 'static_bearer',
      mcp_server_url: MOCK_URL,
      token: 'sk-live-abc123',
    });

    expect(meta.type).toBe('static_bearer');
    expect((meta as Record<string, unknown>)['token']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. URL uniqueness — 409 on second active credential for same URL
// ---------------------------------------------------------------------------

describe('URL uniqueness enforcement', () => {
  it('rejects a second active credential for the same mcp_server_url', async () => {
    const store = new CredentialStore('testns');
    await store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok1' });

    await expect(
      store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok2' }),
    ).rejects.toThrow(CredentialError);

    await expect(
      store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok2' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('allows different URLs in the same namespace', async () => {
    const store = new CredentialStore('testns');
    await store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok1' });
    const meta2 = await store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL_2, token: 'tok2' });
    expect(meta2.mcp_server_url).toBe(MOCK_URL_2);
  });
});

// ---------------------------------------------------------------------------
// 4. list — write-only enforcement
// ---------------------------------------------------------------------------

describe('list — metadata only, no secrets', () => {
  it('returns all non-archived credentials without secret fields', async () => {
    const store = new CredentialStore('testns');
    await store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok1' });
    await store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL_2, token: 'tok2' });

    const list = store.list();
    expect(list).toHaveLength(2);
    for (const item of list) {
      expect((item as Record<string, unknown>)['token']).toBeUndefined();
      expect((item as Record<string, unknown>)['access_token']).toBeUndefined();
      expect((item as Record<string, unknown>)['client_secret']).toBeUndefined();
    }
  });

  it('excludes archived credentials by default', async () => {
    const store = new CredentialStore('testns');
    const meta = await store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok' });
    await store.archive(meta.id);

    const list = store.list();
    expect(list).toHaveLength(0);

    const all = store.list(true);
    expect(all).toHaveLength(1);
    expect(all[0]!.archived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. getMeta — no secrets
// ---------------------------------------------------------------------------

describe('getMeta — metadata only', () => {
  it('returns metadata without secret fields', async () => {
    const store = new CredentialStore('testns');
    const added = await store.add({
      type: 'mcp_oauth',
      mcp_server_url: MOCK_URL,
      access_token: 'secret_token',
    });

    const meta = store.getMeta(added.id);
    expect(meta.id).toBe(added.id);
    expect((meta as Record<string, unknown>)['access_token']).toBeUndefined();
  });

  it('throws 404 for unknown id', () => {
    const store = new CredentialStore('testns');
    expect(() => store.getMeta('cred_nonexistent')).toThrow(CredentialError);
    expect(() => store.getMeta('cred_nonexistent')).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. getCredential — returns decrypted secrets in-memory by URL
// ---------------------------------------------------------------------------

describe('getCredential — in-memory decryption', () => {
  it('returns decrypted access_token for mcp_oauth credential', async () => {
    const store = new CredentialStore('testns');
    await store.add({
      type: 'mcp_oauth',
      mcp_server_url: MOCK_URL,
      access_token: 'xoxp-secret',
      client_secret: 'client_s3cr3t',
    });

    const cred = await store.getCredential(MOCK_URL);
    expect(cred).not.toBeNull();
    expect(cred!.access_token).toBe('xoxp-secret');
    expect(cred!.client_secret).toBe('client_s3cr3t');
    expect(cred!.mcp_server_url).toBe(MOCK_URL);
  });

  it('returns decrypted token for static_bearer credential', async () => {
    const store = new CredentialStore('testns');
    await store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'sk-live-xyz' });

    const cred = await store.getCredential(MOCK_URL);
    expect(cred!.token).toBe('sk-live-xyz');
  });

  it('returns null for archived credential', async () => {
    const store = new CredentialStore('testns');
    const meta = await store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok' });
    await store.archive(meta.id);

    const cred = await store.getCredential(MOCK_URL);
    expect(cred).toBeNull();
  });

  it('returns null for unknown URL', async () => {
    const store = new CredentialStore('testns');
    const cred = await store.getCredential('https://unknown.example.com/mcp');
    expect(cred).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. rotate — replaces secret, updates last_rotated_at
// ---------------------------------------------------------------------------

describe('rotate', () => {
  it('replaces secret values and updates last_rotated_at', async () => {
    const store = new CredentialStore('testns');
    const meta = await store.add({
      type: 'mcp_oauth',
      mcp_server_url: MOCK_URL,
      access_token: 'old_token',
    });

    expect(meta.last_rotated_at).toBeUndefined();

    const updated = await store.rotate(meta.id, { access_token: 'new_token' } as Partial<CredentialAuth>);
    expect(updated.last_rotated_at).toBeTruthy();

    // Verify new secret is readable via getCredential
    const cred = await store.getCredential(MOCK_URL);
    expect(cred!.access_token).toBe('new_token');
  });

  it('throws 409 when rotating an archived credential', async () => {
    const store = new CredentialStore('testns');
    const meta = await store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok' });
    await store.archive(meta.id);

    await expect(
      store.rotate(meta.id, {}),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 409 }));
  });
});

// ---------------------------------------------------------------------------
// 8. archive — purges secret, marks archived
// ---------------------------------------------------------------------------

describe('archive', () => {
  it('marks credential archived and purges the vault secret', async () => {
    const store = new CredentialStore('testns');
    const meta = await store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok' });

    const archived = await store.archive(meta.id);
    expect(archived.archived).toBe(true);

    // getCredential should return null (archived)
    const cred = await store.getCredential(MOCK_URL);
    expect(cred).toBeNull();
  });

  it('allows re-adding same URL after archive', async () => {
    const store = new CredentialStore('testns');
    const meta = await store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok1' });
    await store.archive(meta.id);

    // Should succeed — no active credential at that URL
    const meta2 = await store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok2' });
    expect(meta2.archived).toBe(false);
    expect(meta2.mcp_server_url).toBe(MOCK_URL);
  });
});

// ---------------------------------------------------------------------------
// 9. OAuth daemon — skips non-near-expiry credentials
// ---------------------------------------------------------------------------

describe('OAuthRefreshDaemon', () => {
  it('does not call fetch for credentials expiring far in the future', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    const store = new CredentialStore('testns');
    await store.add({
      type: 'mcp_oauth',
      mcp_server_url: MOCK_URL,
      access_token: 'tok',
      expires_at: new Date(Date.now() + 3600_000).toISOString(), // 1 hour away
      refresh_token: 'rtok',
      token_url: 'https://auth.example.com/token',
    });

    const daemon = new OAuthRefreshDaemon();
    await daemon._tick();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls token endpoint for near-expiry credential and swaps token atomically', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        access_token: 'new_access_tok',
        refresh_token: 'new_rtok',
        expires_in: 7200,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const store = new CredentialStore('testns');
    await store.add({
      type: 'mcp_oauth',
      mcp_server_url: MOCK_URL,
      access_token: 'old_tok',
      refresh_token: 'old_rtok',
      expires_at: new Date(Date.now() + 60_000).toISOString(), // 1 min — within 5 min window
      token_url: 'https://auth.example.com/token',
      client_id: 'cid',
      client_secret: 'csec',
    });

    const daemon = new OAuthRefreshDaemon();
    await daemon._tick();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const callArgs = fetchSpy.mock.calls[0]!;
    expect(callArgs[0]).toBe('https://auth.example.com/token');
    expect((callArgs[1] as RequestInit).method).toBe('POST');

    // Verify new access_token stored
    const cred = await store.getCredential(MOCK_URL);
    expect(cred!.access_token).toBe('new_access_tok');
    expect(cred!.refresh_token).toBe('new_rtok');
  });

  it('handles token endpoint errors gracefully without crashing', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network failure'));

    const store = new CredentialStore('testns');
    await store.add({
      type: 'mcp_oauth',
      mcp_server_url: MOCK_URL,
      access_token: 'tok',
      refresh_token: 'rtok',
      expires_at: new Date(Date.now() + 60_000).toISOString(), // near expiry
      token_url: 'https://auth.example.com/token',
    });

    const daemon = new OAuthRefreshDaemon();
    // Should not throw
    await expect(daemon._tick()).resolves.toBeUndefined();

    // Old token should still be readable (vault mock retains it)
    const cred = await store.getCredential(MOCK_URL);
    expect(cred!.access_token).toBe('tok');
  });

  it('starts and stops the daemon timer without error', () => {
    const daemon = new OAuthRefreshDaemon();
    daemon.start();
    daemon.stop();
    // Double stop should be safe
    daemon.stop();
  });
});

// ---------------------------------------------------------------------------
// 10. Validation errors
// ---------------------------------------------------------------------------

describe('input validation', () => {
  it('rejects invalid namespace pattern (uppercase)', () => {
    expect(() => new CredentialStore('INVALID_UPPER')).toThrow(CredentialError);
  });

  it('rejects mcp_oauth without access_token', async () => {
    const store = new CredentialStore('testns');
    await expect(
      store.add({ type: 'mcp_oauth', mcp_server_url: MOCK_URL, access_token: '' }),
    ).rejects.toThrow(CredentialError);
  });

  it('rejects static_bearer without token', async () => {
    const store = new CredentialStore('testns');
    await expect(
      store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: '' }),
    ).rejects.toThrow(CredentialError);
  });

  it('rejects invalid mcp_server_url', async () => {
    const store = new CredentialStore('testns');
    await expect(
      store.add({ type: 'static_bearer', mcp_server_url: 'not-a-url', token: 'tok' }),
    ).rejects.toThrow(CredentialError);
  });
});

// ---------------------------------------------------------------------------
// 11. token_url SSRF / HTTPS-only validation
// ---------------------------------------------------------------------------

describe('token_url validation (SSRF + HTTPS enforcement)', () => {
  it('rejects http:// token_url with INVALID_TOKEN_URL code', async () => {
    const store = new CredentialStore('testns');
    await expect(
      store.add({
        type: 'mcp_oauth',
        mcp_server_url: MOCK_URL,
        access_token: 'tok',
        token_url: 'http://example.com/token',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN_URL', statusCode: 400 });
  });

  it('rejects link-local SSRF address 169.254.169.254 in token_url', async () => {
    const store = new CredentialStore('testns');
    await expect(
      store.add({
        type: 'mcp_oauth',
        mcp_server_url: MOCK_URL,
        access_token: 'tok',
        token_url: 'https://169.254.169.254/token',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN_URL', statusCode: 400 });
  });

  it('rejects loopback 127.0.0.1 in token_url', async () => {
    const store = new CredentialStore('testns');
    await expect(
      store.add({
        type: 'mcp_oauth',
        mcp_server_url: MOCK_URL,
        access_token: 'tok',
        token_url: 'https://127.0.0.1/token',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN_URL', statusCode: 400 });
  });
});

// ---------------------------------------------------------------------------
// 12. OAuth daemon — SSRF bypass: credential written directly to vault storage
//     (bypassing add()/rotate() validation) must NOT trigger fetch
// ---------------------------------------------------------------------------

describe('OAuthRefreshDaemon — SSRF bypass via direct vault write', () => {
  it('does not call fetch when token_url is a blocked SSRF address written directly to storage', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );

    const credId = 'cred_ssrfbypasstest0001';
    const ns = 'testns';

    // Write metadata directly to disk — bypasses add() validation entirely
    const metaFilePath = path.join(tmpDir, `${ns}-credentials-meta.json`);
    const metaContent = {
      credentials: [
        {
          id: credId,
          namespace: ns,
          type: 'mcp_oauth',
          mcp_server_url: 'https://mcp.example.com/mcp',
          created_at: new Date().toISOString(),
          archived: false,
          expires_at: new Date(Date.now() + 60_000).toISOString(), // 1 min — within 5 min near-expiry window
        },
      ],
    };
    fs.writeFileSync(metaFilePath, JSON.stringify(metaContent), { encoding: 'utf8', mode: 0o600 });

    // Write secrets directly into vault mock — bypasses validateTokenUrl in add()/rotate()
    const secretPayload = JSON.stringify({
      access_token: 'old_token',
      refresh_token: 'old_rtok',
      token_url: 'https://169.254.169.254/token', // SSRF target
      client_id: 'cid',
    });
    vaultStore.set(`${ns}:cred:${credId}`, secretPayload);

    const daemon = new OAuthRefreshDaemon();
    // Must not throw, must not call fetch
    await expect(daemon._tick()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 13. TOCTOU mutex — concurrent add() with same URL: only one succeeds
// ---------------------------------------------------------------------------

describe('TOCTOU mutex — concurrent add()', () => {
  it('only one of two concurrent adds for the same URL succeeds; other throws URL_CONFLICT', async () => {
    const store = new CredentialStore('testns');

    const results = await Promise.allSettled([
      store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok-a' }),
      store.add({ type: 'static_bearer', mcp_server_url: MOCK_URL, token: 'tok-b' }),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason as CredentialError;
    expect(rejectedReason).toBeInstanceOf(CredentialError);
    expect(rejectedReason.statusCode).toBe(409);
    expect(rejectedReason.code).toBe('URL_CONFLICT');
  });
});
