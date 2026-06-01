/**
 * @file tests/federation/federation-token-pool.test.ts
 * @description FederationTokenPool unit tests — Wave 2.
 *
 * Tests:
 *   FED-TOK-1  Contribute token: stored encrypted, metadata in DB
 *   FED-TOK-2  Get tokens for provider: decrypts, returns in priority order (local first)
 *   FED-TOK-3  List tokens: metadata only, no decrypted values
 *   FED-TOK-4  Deactivate: sets active=0
 *   FED-TOK-5  Expired token: filtered from getTokensForProvider
 *   FED-TOK-6  Vault failure: fail-open with error log
 *   FED-TOK-7  Destroy cleanup
 *   FED-TOK-8  Disabled via env var
 *   FED-TOK-9  Called after destroy() returns early
 *   FED-TOK-10 Multiple tokens from different peers
 *   FED-TOK-11 Token with expiresAt
 *   FED-TOK-12 Mark token used updates last_used_at
 *   FED-TOK-13 Deactivate non-existent token returns error
 *   FED-TOK-14 List with provider filter
 *   FED-TOK-15 List with peerId filter
 *   FED-TOK-16 List with activeOnly=false includes inactive
 *   FED-TOK-17 Vault get returns null for expired token
 *   FED-TOK-18 Contribute token returns error on vault failure
 *   FED-TOK-SEC-1  Token format validation: reject too-long tokens
 *   FED-TOK-SEC-2  Token format validation: reject non-printable ASCII
 *   FED-TOK-SEC-3  Token format validation: reject null bytes
 *   FED-TOK-SEC-4  SQL filter key allowlist: reject unknown filter key
 *   FED-TOK-SEC-5  Kill-switch consistency: both contribute and get throw same error
 *   FED-TOK-SEC-6  Token exposure: listTokens never returns decrypted tokens
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { FederationTokenPool } from '../../src/core/federation/federation-token-pool.js';
import type { FederationTokenContribution } from '../../src/core/federation/federation-token-pool-types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

function createMockVault(opts?: {
  getValue?: string;
  getReturnsNull?: boolean;
  getThrows?: boolean;
  setThrows?: boolean;
}) {
  const vaultData = new Map<string, string>();

  const mockVault = {
    set: vi.fn<(...args: unknown[]) => Promise<void>>().mockImplementation(async (namespace, key, value, opts) => {
      if (opts?.setThrows) {
        throw new Error('Vault set failed');
      }
      vaultData.set(`${namespace}:${key}`, value);
    }),
    get: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation(async (namespace, key) => {
      if (opts?.getThrows) {
        throw new Error('Vault get failed');
      }
      if (opts?.getReturnsNull) {
        return null;
      }
      const value = vaultData.get(`${namespace}:${key}`);
      return value ? { value } : null;
    }),
  };

  return { mockVault, vaultData };
}

function makeContribution(overrides?: Partial<FederationTokenContribution>): FederationTokenContribution {
  return {
    peerId: 'peer-test',
    provider: 'openai',
    token: 'sk-test-token-12345',
    ...overrides,
  };
}

function createPool(opts?: {
  vaultGetValue?: string;
  vaultGetReturnsNull?: boolean;
  vaultGetThrows?: boolean;
  vaultSetThrows?: boolean;
}) {
  const db = makeInMemoryDb();
  const { mockVault } = createMockVault({
    getValue: opts?.vaultGetValue,
    getReturnsNull: opts?.vaultGetReturnsNull,
    getThrows: opts?.vaultGetThrows,
    setThrows: opts?.vaultSetThrows,
  });

  return {
    db,
    mockVault,
    pool: new FederationTokenPool({
      vault: mockVault,
      db,
    }),
  };
}

// ---------------------------------------------------------------------------
// FED-TOK-1: Contribute token happy path
// ---------------------------------------------------------------------------

describe('FederationTokenPool — contributeToken', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-1: contribute token stores encrypted in vault and metadata in DB', async () => {
    const { db, mockVault, pool } = createPool();

    const contribution = makeContribution();
    const result = await pool.contributeToken(contribution);

    expect(result.success).toBe(true);
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // Verify vault.set was called
    expect(mockVault.set).toHaveBeenCalledWith(
      'federation-tokens',
      expect.stringMatching(/^peer-test:openai:/),
      'sk-test-token-12345',
      expect.objectContaining({}),
    );

    // Verify DB record exists
    const rows = db.prepare('SELECT * FROM federation_token_pool').all() as Array<{
      id: string;
      peer_id: string;
      provider: string;
      vault_key: string;
      active: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.peer_id).toBe('peer-test');
    expect(rows[0]!.provider).toBe('openai');
    expect(rows[0]!.active).toBe(1);

    pool.destroy();
  });

  it('FED-TOK-11: token with expiresAt stored correctly', async () => {
    const { pool, mockVault } = createPool();

    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const contribution = makeContribution({ expiresAt });
    const result = await pool.contributeToken(contribution);

    expect(result.success).toBe(true);

    // Verify vault.set was called with expiresAt
    const setCall = (mockVault.set as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(setCall?.[3]?.expiresAt).toBe(expiresAt);

    pool.destroy();
  });

  it('FED-TOK-18: contribute token returns error on vault failure', async () => {
    const db = makeInMemoryDb();
    const mockVault = {
      set: vi.fn<(...args: unknown[]) => Promise<void>>().mockImplementation(async () => {
        throw new Error('Vault set failed');
      }),
      get: vi.fn(),
    };

    const pool = new FederationTokenPool({ vault: mockVault, db });

    const contribution = makeContribution();
    const result = await pool.contributeToken(contribution);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Vault set failed');

    pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-TOK-2: Get tokens for provider
// ---------------------------------------------------------------------------

describe('FederationTokenPool — getTokensForProvider', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-2: get tokens decrypts and returns in priority order (local first)', async () => {
    const db = makeInMemoryDb();

    // Set up vault that returns different values based on key
    const vaultData = new Map<string, string>();
    const mockVault = {
      set: vi.fn<(...args: unknown[]) => Promise<void>>().mockImplementation(async (ns, key, value) => {
        vaultData.set(`${ns}:${key}`, value as string);
      }),
      get: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation(async (ns, key) => {
        const value = vaultData.get(`${ns}:${key}`);
        return value ? { value } : null;
      }),
    };

    const pool = new FederationTokenPool({ vault: mockVault, db });

    // Contribute tokens from different peers
    await pool.contributeToken(makeContribution({ peerId: 'peer-a', token: 'token-a' }));
    await pool.contributeToken(makeContribution({ peerId: 'local', token: 'token-local' }));
    await pool.contributeToken(makeContribution({ peerId: 'peer-b', token: 'token-b' }));

    const tokens = await pool.getTokensForProvider('openai');

    expect(tokens).toHaveLength(3);
    // Local should be first
    expect(tokens[0]!.peerId).toBe('local');
    expect(tokens[0]!.token).toBe('token-local');

    pool.destroy();
  });

  it('FED-TOK-10: multiple tokens from different peers returned correctly', async () => {
    const { pool, mockVault } = createPool();

    // Set up vault data for multiple tokens
    const vaultData = new Map<string, string>();
    (mockVault.get as ReturnType<typeof vi.fn>).mockImplementation(async (ns, key) => {
      const value = vaultData.get(`${ns}:${key}`);
      return value ? { value } : null;
    });
    (mockVault.set as ReturnType<typeof vi.fn>).mockImplementation(async (ns, key, value) => {
      vaultData.set(`${ns}:${key}`, value as string);
    });

    await pool.contributeToken(makeContribution({ peerId: 'peer-a', token: 'token-a' }));
    await pool.contributeToken(makeContribution({ peerId: 'peer-b', token: 'token-b' }));

    const tokens = await pool.getTokensForProvider('openai');
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t) => t.peerId)).toEqual(expect.arrayContaining(['peer-a', 'peer-b']));

    pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-TOK-3: List tokens
// ---------------------------------------------------------------------------

describe('FederationTokenPool — listTokens', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-3: list tokens returns metadata only, no decrypted values', async () => {
    const { pool, db } = createPool();

    await pool.contributeToken(makeContribution({ token: 'secret-token-123' }));

    const tokens = pool.listTokens();

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.token).toBeUndefined(); // No decrypted value
    expect(tokens[0]!.peerId).toBe('peer-test');
    expect(tokens[0]!.provider).toBe('openai');
    expect(tokens[0]!.active).toBe(true);

    pool.destroy();
  });

  it('FED-TOK-14: list with provider filter', async () => {
    const { pool } = createPool();

    await pool.contributeToken(makeContribution({ provider: 'openai' }));
    await pool.contributeToken(makeContribution({ provider: 'anthropic' }));

    const openaiTokens = pool.listTokens({ provider: 'openai' });
    expect(openaiTokens).toHaveLength(1);
    expect(openaiTokens[0]!.provider).toBe('openai');

    pool.destroy();
  });

  it('FED-TOK-15: list with peerId filter', async () => {
    const { pool } = createPool();

    await pool.contributeToken(makeContribution({ peerId: 'peer-a' }));
    await pool.contributeToken(makeContribution({ peerId: 'peer-b' }));

    const peerATokens = pool.listTokens({ peerId: 'peer-a' });
    expect(peerATokens).toHaveLength(1);
    expect(peerATokens[0]!.peerId).toBe('peer-a');

    pool.destroy();
  });

  it('FED-TOK-16: list with activeOnly=false includes inactive', async () => {
    const { pool, db } = createPool();

    await pool.contributeToken(makeContribution({ peerId: 'peer-active' }));
    await pool.contributeToken(makeContribution({ peerId: 'peer-inactive' }));

    // Manually deactivate one
    db.prepare('UPDATE federation_token_pool SET active = 0 WHERE peer_id = ?').run('peer-inactive');

    const allTokens = pool.listTokens({ activeOnly: false });
    expect(allTokens).toHaveLength(2);

    const activeOnly = pool.listTokens({ activeOnly: true });
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0]!.peerId).toBe('peer-active');

    pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-TOK-4: Deactivate token
// ---------------------------------------------------------------------------

describe('FederationTokenPool — deactivateToken', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-4: deactivate sets active=0 in DB', async () => {
    const { pool, db } = createPool();

    const result = await pool.contributeToken(makeContribution());
    const tokenId = result.id;

    const deactivateResult = await pool.deactivateToken(tokenId);
    expect(deactivateResult.success).toBe(true);

    // Verify DB update
    const row = db.prepare('SELECT active FROM federation_token_pool WHERE id = ?').get(tokenId) as { active: number };
    expect(row.active).toBe(0);

    pool.destroy();
  });

  it('FED-TOK-13: deactivate non-existent token returns error', async () => {
    const { pool } = createPool();

    const result = await pool.deactivateToken('nonexistent-token-id');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Token not found');

    pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-TOK-5: Expired token filtered
// ---------------------------------------------------------------------------

describe('FederationTokenPool — expired tokens', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-5: expired token filtered from getTokensForProvider', async () => {
    const db = makeInMemoryDb();

    const vaultData = new Map<string, string>();
    const mockVault = {
      set: vi.fn<(...args: unknown[]) => Promise<void>>().mockImplementation(async (ns, key, value) => {
        vaultData.set(`${ns}:${key}`, value as string);
      }),
      get: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation(async (ns, key) => {
        const value = vaultData.get(`${ns}:${key}`);
        return value ? { value } : null;
      }),
    };

    const pool = new FederationTokenPool({ vault: mockVault, db });

    // Contribute expired token
    const pastDate = new Date(Date.now() - 1000).toISOString();
    await pool.contributeToken(makeContribution({ expiresAt: pastDate }));

    const tokens = await pool.getTokensForProvider('openai');
    expect(tokens).toHaveLength(0); // Expired token filtered out

    pool.destroy();
  });

  it('FED-TOK-17: vault get returns null → token returned without decrypted value', async () => {
    const db = makeInMemoryDb();

    // Vault that returns null (simulating missing/expired token in vault)
    const mockVault = {
      set: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      get: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
    };

    const pool = new FederationTokenPool({ vault: mockVault, db });

    await pool.contributeToken(makeContribution());

    const tokens = await pool.getTokensForProvider('openai');
    // Token metadata returned but without decrypted value (vault returned null)
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.token).toBeUndefined();
    expect(tokens[0]!.peerId).toBe('peer-test');

    pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-TOK-6: Vault failure fail-open
// ---------------------------------------------------------------------------

describe('FederationTokenPool — fail-open behavior', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-6: vault get failure → fail-open, skips token but continues', async () => {
    const db = makeInMemoryDb();

    const mockVault = {
      set: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      get: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation(async () => {
        throw new Error('Vault get failed');
      }),
    };

    const pool = new FederationTokenPool({ vault: mockVault, db });

    await pool.contributeToken(makeContribution());

    // Should not throw, returns empty array (token skipped due to vault failure)
    const tokens = await pool.getTokensForProvider('openai');
    expect(tokens).toEqual([]);

    pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-TOK-7: Destroy cleanup
// ---------------------------------------------------------------------------

describe('FederationTokenPool — destroy', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-7: destroy() marks pool as destroyed', () => {
    const { pool } = createPool();

    pool.destroy();

    // Subsequent calls should return early
    expect(() => pool.destroy()).not.toThrow();

    pool.destroy();
  });

  it('FED-TOK-9: contributeToken called after destroy() returns early', async () => {
    const { pool } = createPool();

    pool.destroy();

    const result = await pool.contributeToken(makeContribution());
    expect(result.success).toBe(false);
    expect(result.error).toBe('Token pool destroyed');

    pool.destroy();
  });

  it('FED-TOK-9b: getTokensForProvider called after destroy() returns empty', async () => {
    const { pool } = createPool();

    pool.destroy();

    const tokens = await pool.getTokensForProvider('openai');
    expect(tokens).toEqual([]);

    pool.destroy();
  });

  it('FED-TOK-9c: listTokens called after destroy() returns empty', async () => {
    const { pool } = createPool();

    pool.destroy();

    const tokens = pool.listTokens();
    expect(tokens).toEqual([]);

    pool.destroy();
  });

  it('FED-TOK-9d: deactivateToken called after destroy() returns error', async () => {
    const { pool } = createPool();

    pool.destroy();

    const result = await pool.deactivateToken('any-token');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Token pool destroyed');

    pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-TOK-8: Disabled via env var
// ---------------------------------------------------------------------------

describe('FederationTokenPool — env var disable', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  afterEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-8: SUDO_FED_TOKEN_POOL_DISABLE=1 → returns early', async () => {
    process.env['SUDO_FED_TOKEN_POOL_DISABLE'] = '1';

    const { pool } = createPool();

    const result = await pool.contributeToken(makeContribution());
    expect(result.success).toBe(false);
    expect(result.error).toBe('token pool disabled');

    // getTokensForProvider throws when disabled
    await expect(pool.getTokensForProvider('openai')).rejects.toThrow('token pool disabled');

    pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-TOK-12: Mark token used
// ---------------------------------------------------------------------------

describe('FederationTokenPool — markTokenUsed', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-12: markTokenUsed updates last_used_at', async () => {
    const { pool, db } = createPool();

    const result = await pool.contributeToken(makeContribution());
    expect(result.success).toBe(true);
    const tokenId = result.id;

    // Verify initial last_used_at is null
    const before = db.prepare('SELECT last_used_at FROM federation_token_pool WHERE id = ?').get(tokenId) as { last_used_at: string | null } | undefined;
    expect(before?.last_used_at).toBeNull();

    await pool.markTokenUsed(tokenId);

    const after = db.prepare('SELECT last_used_at FROM federation_token_pool WHERE id = ?').get(tokenId) as { last_used_at: string | null } | undefined;
    expect(after?.last_used_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// Security Tests: Token Format Validation
// ---------------------------------------------------------------------------

describe('FederationTokenPool — security: token format validation', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  afterEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-SEC-1: reject too-long tokens (>4096 chars)', async () => {
    const { pool } = createPool();

    const longToken = 'a'.repeat(4097); // Exceeds MAX_TOKEN_LENGTH
    const result = await pool.contributeToken(makeContribution({ token: longToken }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid token format');

    pool.destroy();
  });

  it('FED-TOK-SEC-2: reject non-printable ASCII tokens', async () => {
    const { pool } = createPool();

    // Token with control character (0x00-0x1F)
    const nonPrintableToken = 'valid-part\x01invalid';
    const result = await pool.contributeToken(makeContribution({ token: nonPrintableToken }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid token format');

    pool.destroy();
  });

  it('FED-TOK-SEC-3: reject tokens with null bytes', async () => {
    const { pool } = createPool();

    const nullByteToken = 'prefix\x00suffix';
    const result = await pool.contributeToken(makeContribution({ token: nullByteToken }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid token format');

    pool.destroy();
  });

  it('FED-TOK-SEC-3b: reject unicode tokens', async () => {
    const { pool } = createPool();

    const unicodeToken = 'token-with-unicode-你好';
    const result = await pool.contributeToken(makeContribution({ token: unicodeToken }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid token format');

    pool.destroy();
  });

  it('FED-TOK-SEC-3c: reject invalid provider', async () => {
    const { pool } = createPool();

    const result = await pool.contributeToken(makeContribution({ provider: 'unknown-provider' }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid provider');

    pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// Security Tests: SQL Injection Prevention
// ---------------------------------------------------------------------------

describe('FederationTokenPool — security: SQL filter key allowlist', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-SEC-4: reject unknown filter key in listTokens', async () => {
    const { pool } = createPool();

    await pool.contributeToken(makeContribution());

    // @ts-expect-error - Testing invalid key rejection
    expect(() => pool.listTokens({ unknownKey: 'value' })).toThrow('Invalid filter key: unknownKey');

    pool.destroy();
  });

  it('FED-TOK-SEC-4b: accept valid filter keys', async () => {
    const { pool } = createPool();

    await pool.contributeToken(makeContribution({ provider: 'openai', peerId: 'peer-test' }));

    // These should not throw
    expect(() => pool.listTokens({ provider: 'openai' })).not.toThrow();
    expect(() => pool.listTokens({ peerId: 'peer-test' })).not.toThrow();
    expect(() => pool.listTokens({ activeOnly: false })).not.toThrow();

    pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// Security Tests: Kill-Switch Consistency
// ---------------------------------------------------------------------------

describe('FederationTokenPool — security: kill-switch consistency', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  afterEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-SEC-5: contributeToken returns {success: false, error} when disabled', async () => {
    process.env['SUDO_FED_TOKEN_POOL_DISABLE'] = '1';

    const { pool } = createPool();

    const result = await pool.contributeToken(makeContribution());

    expect(result.success).toBe(false);
    expect(result.error).toBe('token pool disabled');

    pool.destroy();
  });

  it('FED-TOK-SEC-5b: getTokensForProvider throws when disabled', async () => {
    process.env['SUDO_FED_TOKEN_POOL_DISABLE'] = '1';

    const { pool } = createPool();

    await expect(pool.getTokensForProvider('openai')).rejects.toThrow('token pool disabled');

    pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// Security Tests: Token Exposure
// ---------------------------------------------------------------------------

describe('FederationTokenPool — security: token exposure', () => {
  beforeEach(() => {
    delete process.env['SUDO_FED_TOKEN_POOL_DISABLE'];
  });

  it('FED-TOK-SEC-6: listTokens never returns decrypted token field', async () => {
    const { pool } = createPool();

    await pool.contributeToken(makeContribution({ token: 'secret-token-should-not-expose' }));

    const tokens = pool.listTokens();

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.token).toBeUndefined();

    pool.destroy();
  });
});
