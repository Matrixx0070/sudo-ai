/**
 * @file src/core/federation/federation-state-projector.ts
 * @description Gap #28d slice 3 — pure projection from the live federation
 * subsystem (PeerRegistry + AuditChainSync + FederationTokenPool) into the
 * `FederationState` admin-URL shape.
 *
 * **Why this lives in its own file.** The cli.ts closure that wires
 * `__sudoFederation` for the dashboard is hard to unit-test because it
 * captures three `let` bindings from boot scope. Lifting the projection
 * into a pure function lets:
 *   - cli.ts stay thin (one closure that delegates here),
 *   - tests assert the secret-redaction contract on real type-shaped
 *     inputs without needing to boot the CLI,
 *   - future federation refactors that add fields to PeerConfig get
 *     caught here rather than silently leaking through the dashboard.
 *
 * **Secret discipline (mirrored from FederationState's JSDoc).** Two
 * source-type fields carry credentials: `PeerConfig.token` (peer-side
 * auth bearer) and `FederationTokenWithDecrypted.token` (plaintext
 * credential). Neither appears in the output. Peers are projected to
 * `{name, url}` only; tokens are surfaced as aggregate counts.
 */

import type { FederationState } from '../dashboard/dashboard-types.js';

/** Minimal PeerRegistry surface — duck-typed to keep the projector decoupled. */
export interface PeerRegistryRead {
  getPeers(): Array<{ name: string; url: string; token: string }>;
}

/** Minimal AuditChainSync surface used by the projector. */
export interface AuditChainSyncRead {
  getInboundEventCount(): number;
  getLastInboundTs(): number | null;
}

/** Minimal FederationTokenPool surface used by the projector. */
export interface FederationTokenPoolRead {
  listTokens(opts: Record<string, never>): Array<{ active: boolean; provider: string }>;
}

/**
 * Build the admin-URL federation-state snapshot.
 *
 * Each subsystem argument is optional — the projection returns honest
 * zeros for any subsystem that didn't boot. `enabled: true` requires
 * BOTH `peerRegistry` AND `auditChainSync` (the §6.4h pair) to be
 * present, mirroring the boot contract.
 */
export function projectFederationState(opts: {
  instanceId: string;
  peerRegistry?: PeerRegistryRead;
  auditChainSync?: AuditChainSyncRead;
  federationTokenPool?: FederationTokenPoolRead;
  /**
   * Optional logger for swallowed errors. Defaults to no-op so the
   * projector stays usable from non-cli contexts (tests, future
   * surfaces). cli.ts wires its log.warn here so token-pool throw
   * paths surface in the boot log.
   */
  onError?: (err: unknown, context: string) => void;
}): FederationState {
  const onError = opts.onError ?? (() => { /* swallow */ });
  const enabled = !!(opts.peerRegistry && opts.auditChainSync);

  // PeerRegistry projection — strip `token`. Done with an explicit
  // object literal rather than spread so a future PeerConfig field
  // can't accidentally leak through.
  const peers: FederationState['peers'] = opts.peerRegistry
    ? opts.peerRegistry.getPeers().map((p) => ({ name: p.name, url: p.url }))
    : [];

  // AuditChainSync window.
  let audit: FederationState['audit'] = { inboundEventCount: 0, lastInboundTs: null, lastInboundIso: null };
  if (opts.auditChainSync) {
    try {
      const lastTs = opts.auditChainSync.getLastInboundTs();
      audit = {
        inboundEventCount: opts.auditChainSync.getInboundEventCount(),
        lastInboundTs: lastTs,
        lastInboundIso: typeof lastTs === 'number' ? new Date(lastTs).toISOString() : null,
      };
    } catch (err) {
      onError(err, 'audit-chain-sync');
    }
  }

  // FederationTokenPool aggregate counts. Individual token IDs and
  // peer IDs are intentionally omitted — operators who need them have
  // the gateway's federation-token-pool endpoints.
  let tokens: FederationState['tokens'] = { totalCount: 0, activeCount: 0, byProvider: {} };
  if (opts.federationTokenPool) {
    try {
      const entries = opts.federationTokenPool.listTokens({});
      const byProvider: Record<string, number> = {};
      let activeCount = 0;
      for (const e of entries) {
        if (e.active) {
          activeCount++;
          byProvider[e.provider] = (byProvider[e.provider] ?? 0) + 1;
        }
      }
      tokens = { totalCount: entries.length, activeCount, byProvider };
    } catch (err) {
      onError(err, 'federation-token-pool');
    }
  }

  return { enabled, instanceId: opts.instanceId, peers, audit, tokens };
}
