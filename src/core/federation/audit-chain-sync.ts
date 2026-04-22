/**
 * @file core/federation/audit-chain-sync.ts
 * @description Outbound audit event publisher and inbound tail fetcher for federation.
 *
 * publishEvent(eventType, payload) — POSTs to all peers in parallel, fire-and-forget.
 * fetchPeerTail(peerName, since)   — GETs peer's recent audit tail, returns events or [].
 *
 * Schema managed:
 *   federation_outbound_seq (instance_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL)
 *   federation_inbound_audit (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL,
 *     event_type TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL,
 *     seq INTEGER NOT NULL, received_at INTEGER NOT NULL,
 *     UNIQUE(instance_id, seq))
 *
 * Uses native fetch() — no added dependencies.
 * Wave 7E — federation MVP.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import type { PeerRegistry } from './peer-registry.js';
import { ArtifactSigner } from '../security/signer.js';

const log = createLogger('federation:audit-chain-sync');

const FETCH_TIMEOUT_MS = 3_000;
const DEFAULT_TAIL_LIMIT = 100;

// ---------------------------------------------------------------------------
// Duck-typed DB interface (matches better-sqlite3 statement shape)
// ---------------------------------------------------------------------------

interface PreparedStmt {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface AuditDbLike {
  prepare(sql: string): PreparedStmt;
  exec(sql: string): void;
}

// ---------------------------------------------------------------------------
// Federated event envelope
// ---------------------------------------------------------------------------

export interface FederatedEvent {
  id: string;
  instanceId: string;
  eventType: string;
  payload: unknown;
  ts: number;
  seq: number;
  // Wave 10H — optional signature fields (present when signer is configured):
  keyId?: string;
  keyVersion?: number;
  signature?: string;
  signedAt?: string;
}

// ---------------------------------------------------------------------------
// Schema initialiser
// ---------------------------------------------------------------------------

function ensureSchema(db: AuditDbLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS federation_outbound_seq (
      instance_id TEXT PRIMARY KEY,
      last_seq    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS federation_inbound_audit (
      id          TEXT    PRIMARY KEY,
      instance_id TEXT    NOT NULL,
      event_type  TEXT    NOT NULL,
      payload     TEXT    NOT NULL,
      ts          INTEGER NOT NULL,
      seq         INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      UNIQUE(instance_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_fed_inbound_received_at
      ON federation_inbound_audit (received_at);
  `);
}

// ---------------------------------------------------------------------------
// AuditChainSync class
// ---------------------------------------------------------------------------

export class AuditChainSync {
  private readonly db: AuditDbLike;
  private readonly registry: PeerRegistry;
  private readonly instanceId: string;
  private readonly _signer?: ArtifactSigner;

  private readonly stmtGetSeq: PreparedStmt;
  private readonly stmtUpsertSeq: PreparedStmt;
  private readonly stmtInsertInbound: PreparedStmt;
  private readonly stmtQueryTail: PreparedStmt;
  private readonly stmtCountInbound: PreparedStmt;
  private readonly stmtLastInbound: PreparedStmt;
  private readonly stmtLastOutbound: PreparedStmt;

  constructor(db: AuditDbLike, registry: PeerRegistry, instanceId: string, signer?: ArtifactSigner) {
    this.db = db;
    this.registry = registry;
    this.instanceId = instanceId;
    this._signer = signer;

    ensureSchema(db);

    // Pre-compile statements
    this.stmtGetSeq = db.prepare(
      `SELECT last_seq FROM federation_outbound_seq WHERE instance_id = ?`,
    );
    this.stmtUpsertSeq = db.prepare(
      `INSERT INTO federation_outbound_seq (instance_id, last_seq) VALUES (?, 1)
       ON CONFLICT(instance_id) DO UPDATE SET last_seq = last_seq + 1`,
    );
    this.stmtInsertInbound = db.prepare(
      `INSERT OR IGNORE INTO federation_inbound_audit
         (id, instance_id, event_type, payload, ts, seq, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtQueryTail = db.prepare(
      `SELECT id, instance_id, event_type, payload, ts, seq, received_at
       FROM federation_inbound_audit
       WHERE received_at >= ?
       ORDER BY received_at ASC
       LIMIT ?`,
    );
    this.stmtCountInbound = db.prepare(
      `SELECT COUNT(*) as cnt FROM federation_inbound_audit`,
    );
    this.stmtLastInbound = db.prepare(
      `SELECT MAX(received_at) as ts FROM federation_inbound_audit`,
    );
    this.stmtLastOutbound = db.prepare(
      `SELECT last_seq FROM federation_outbound_seq WHERE instance_id = ?`,
    );

    log.info({ instanceId }, 'AuditChainSync initialised');
  }

  // ---------------------------------------------------------------------------
  // Outbound: publish event to all peers
  // ---------------------------------------------------------------------------

  /**
   * Atomically increments local seq, then POSTs the event to all peers.
   * Fire-and-forget — failures are logged but never thrown.
   */
  publishEvent(eventType: string, payload: unknown): void {
    // Validate inputs defensively
    if (typeof eventType !== 'string' || eventType.trim() === '') {
      log.warn({ eventType }, 'publishEvent: invalid eventType, skipping');
      return;
    }

    const peers = this.registry.getPeers();
    if (peers.length === 0) return; // nothing to publish

    // Atomically increment seq
    let seq: number;
    try {
      this.stmtUpsertSeq.run(this.instanceId);
      const row = this.stmtGetSeq.get(this.instanceId) as { last_seq: number } | undefined;
      seq = row?.last_seq ?? 1;
    } catch (err) {
      log.warn({ err: String(err) }, 'publishEvent: seq increment failed, using timestamp fallback');
      seq = Date.now();
    }

    const envelope: FederatedEvent = {
      id: randomUUID(),
      instanceId: this.instanceId,
      eventType,
      payload,
      ts: Date.now(),
      seq,
    };

    // Wave 10H: sign outbound envelope if signer is present and kill-switch is off
    if (this._signer && process.env['SUDO_FED_SIGN_DISABLE'] !== '1') {
      try {
        const artifact = this._signer.sign(envelope.payload, 'federation_event');
        envelope.keyId = artifact.keyId;
        envelope.keyVersion = artifact.keyVersion;
        envelope.signature = artifact.signature;
        envelope.signedAt = artifact.signedAt;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err: msg }, 'publishEvent: signing failed, sending unsigned (non-fatal)');
      }
    }

    // Fan-out to all peers — fully async, fire-and-forget
    void this.fanOut(peers, envelope);
  }

  private async fanOut(
    peers: Array<{ name: string; url: string; token: string }>,
    envelope: FederatedEvent,
  ): Promise<void> {
    await Promise.allSettled(
      peers.map(peer => this.postToPeer(peer, envelope)),
    );
  }

  private async postToPeer(
    peer: { name: string; url: string; token: string },
    envelope: FederatedEvent,
  ): Promise<void> {
    const url = `${peer.url}/v1/federation/audit/ingest`;
    const body = JSON.stringify(envelope);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${peer.token}`,
          'X-Sudo-Instance': this.instanceId,
        },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        log.warn(
          { peer: peer.name, status: response.status },
          'publishEvent: peer rejected event',
        );
      } else {
        log.debug({ peer: peer.name, seq: envelope.seq }, 'publishEvent: peer accepted event');
      }
    } catch (err) {
      // Network errors, timeouts, etc. — all non-fatal
      log.warn({ peer: peer.name, err: String(err) }, 'publishEvent: fetch failed (non-fatal)');
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound: write accepted peer event to federation_inbound_audit
  // ---------------------------------------------------------------------------

  /**
   * Writes an inbound federated event to the DB.
   * Returns 'ok' on success, 'duplicate' on (instanceId, seq) conflict, 'error' otherwise.
   */
  ingestEvent(event: FederatedEvent): 'ok' | 'duplicate' | 'error' {
    try {
      const result = this.stmtInsertInbound.run(
        event.id,
        event.instanceId,
        event.eventType,
        JSON.stringify(event.payload),
        event.ts,
        event.seq,
        Date.now(),
      );
      if (result.changes === 0) {
        // OR IGNORE triggered — duplicate
        log.debug({ instanceId: event.instanceId, seq: event.seq }, 'ingestEvent: duplicate ignored');
        return 'duplicate';
      }
      log.debug({ instanceId: event.instanceId, seq: event.seq }, 'ingestEvent: stored');
      return 'ok';
    } catch (err) {
      log.error({ err: String(err) }, 'ingestEvent: DB write failed');
      return 'error';
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound: fetch tail from a peer
  // ---------------------------------------------------------------------------

  /**
   * GETs the peer's /v1/federation/audit/tail?since=N&limit=M.
   * Returns events array or [] on any failure (timeout, parse error, HTTP error).
   */
  async fetchPeerTail(peerName: string, sinceMs: number, limit?: number): Promise<FederatedEvent[]> {
    const peer = this.registry.getPeer(peerName);
    if (!peer) {
      log.warn({ peerName }, 'fetchPeerTail: unknown peer');
      return [];
    }
    const clampedLimit = Math.min(Math.max(1, limit ?? DEFAULT_TAIL_LIMIT), 500);
    const url = `${peer.url}/v1/federation/audit/tail?since=${sinceMs}&limit=${clampedLimit}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${peer.token}`,
          'X-Sudo-Instance': this.instanceId,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        log.warn({ peerName, status: response.status }, 'fetchPeerTail: peer returned error');
        return [];
      }
      const data = await response.json() as {
        ok: boolean;
        data?: { events: FederatedEvent[] };
      };
      if (!data.ok || !Array.isArray(data.data?.events)) {
        log.warn({ peerName }, 'fetchPeerTail: unexpected response shape');
        return [];
      }
      return data.data.events;
    } catch (err) {
      log.warn({ peerName, err: String(err) }, 'fetchPeerTail: fetch failed (non-fatal)');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Stats helpers (used by federation routes)
  // ---------------------------------------------------------------------------

  /**
   * Returns the names of all configured peers.
   * Used by SleepCycle to enumerate peers for the post-Phase-5 audit pull.
   * Wave 8D.
   */
  listPeers(): string[] {
    return this.registry.getPeers().map(p => p.name);
  }

  getOutboundSeq(): number {
    try {
      const row = this.stmtLastOutbound.get(this.instanceId) as { last_seq: number } | undefined;
      return row?.last_seq ?? 0;
    } catch {
      return 0;
    }
  }

  getInboundEventCount(): number {
    try {
      const row = this.stmtCountInbound.get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  getLastInboundTs(): number | null {
    try {
      const row = this.stmtLastInbound.get() as { ts: number | null } | undefined;
      return row?.ts ?? null;
    } catch {
      return null;
    }
  }

  getLastOutboundTs(): number | null {
    try {
      const seqRow = this.stmtGetSeq.get(this.instanceId) as { last_seq: number } | undefined;
      // We don't store outbound timestamps separately; return null if seq is 0.
      return seqRow ? Date.now() : null;
    } catch {
      return null;
    }
  }

  /**
   * Query local inbound audit tail (used for GET /v1/federation/audit/tail endpoint).
   * Returns outbound events this instance has received from peers, by received_at >= sinceMs.
   */
  queryInboundTail(sinceMs: number, limit: number): Array<{
    id: string;
    instanceId: string;
    eventType: string;
    payload: unknown;
    ts: number;
    seq: number;
    receivedAt: number;
  }> {
    try {
      const rows = this.stmtQueryTail.all(sinceMs, limit) as Array<{
        id: string;
        instance_id: string;
        event_type: string;
        payload: string;
        ts: number;
        seq: number;
        received_at: number;
      }>;
      return rows.map(r => ({
        id: r.id,
        instanceId: r.instance_id,
        eventType: r.event_type,
        payload: tryParseJson(r.payload),
        ts: r.ts,
        seq: r.seq,
        receivedAt: r.received_at,
      }));
    } catch (err) {
      log.error({ err: String(err) }, 'queryInboundTail: DB query failed');
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
