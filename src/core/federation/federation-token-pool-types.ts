/**
 * @file federation-token-pool-types.ts
 * @description Type definitions for FederationTokenPool module.
 */

export interface FederationTokenEntry {
  id: string;
  peerId: string;
  provider: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  active: boolean;
}

export interface FederationTokenContribution {
  peerId: string;
  provider: string;
  token: string;
  expiresAt?: string;
}

export interface FederationTokenPoolDeps {
  vault: {
    set(namespace: string, key: string, value: string, opts?: { expiresAt?: string }): Promise<void>;
    get(namespace: string, key: string, requester: string): Promise<{ value: string } | null>;
  };
  db: {
    prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown | undefined; all(...args: unknown[]): unknown[] };
    exec(sql: string): void;
  };
}

export interface FederationTokenWithDecrypted extends FederationTokenEntry {
  token?: string; // Only present when decrypted via getTokensForProvider
}
