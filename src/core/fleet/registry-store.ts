/**
 * @file src/core/fleet/registry-store.ts
 * @description Gap #28c slice 1 — SQLite-backed registry of registered
 * devices. The registrar inserts/upserts on `POST /api/fleet/register` and
 * reads on `GET /api/admin/fleet/devices`.
 *
 * Schema is tiny in slice 1; slice 2 will add a `last_seen_at` heartbeat
 * column and slice 4 will add admission_status / admission_token columns.
 * All migrations follow the project's additive `ALTER ... ADD COLUMN` +
 * silence-known-races pattern (see audit-trail.ts:135).
 *
 * Upsert key: `device_id` (the SHA-256-derived id from publicKey). A device
 * that rotates its keypair gets a NEW device_id and a new row — same way
 * SSH keys are tracked per-key, not per-host. The admin UI can correlate
 * via hostname.
 */

import Database from 'better-sqlite3';
import path from 'node:path';

/** Row shape as returned to callers. */
export interface DeviceRow {
  deviceId: string;
  publicKeyPem: string;
  hostname: string;
  versionStr: string;
  firstRegisteredAt: string;
  lastRegisteredAt: string;
  metadataJson: string | null;
  /** Slice 4 — bumped on every inbox poll. ISO-8601 string or null. */
  lastSeenAt: string | null;
  /** Slice 4 — admission state machine. Default `approved` on first register. */
  admissionStatus: AdmissionStatus;
}

/** Slice-4 admission state. Newly-registered devices default to `approved`. */
export type AdmissionStatus = 'approved' | 'revoked';

/** Constructor input for `RegistryStore`. */
export interface RegistryStoreOptions {
  /** Absolute path to the SQLite file. */
  dbPath: string;
}

/** Default path under DATA_DIR. */
export function defaultRegistryDbPath(dataDir: string): string {
  return path.join(dataDir, 'fleet.db');
}

/**
 * SQLite-backed device registry. Single-process owner — there is no inter-
 * process locking beyond what better-sqlite3 + SQLite WAL gives us.
 *
 * Constructor is synchronous (matches AuditTrail). Close with `.close()`.
 */
export class RegistryStore {
  private readonly db: Database.Database;
  private readonly upsertStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  private readonly setLastSeenStmt: Database.Statement;
  private readonly setAdmissionStmt: Database.Statement;

  constructor(opts: RegistryStoreOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_devices (
        device_id           TEXT PRIMARY KEY,
        public_key_pem      TEXT NOT NULL,
        hostname            TEXT NOT NULL,
        version_str         TEXT NOT NULL,
        first_registered_at TEXT NOT NULL,
        last_registered_at  TEXT NOT NULL,
        metadata_json       TEXT
      )
    `);

    // Slice-4 additive migrations. Same pattern as audit-trail.ts:135 —
    // each ALTER is its own try/catch silencing only "already exists" /
    // "duplicate column name" so re-boots don't re-add columns. All other
    // SQLite errors re-throw.
    this.addSlice4Columns();

    // Prepared statements — cheaper than re-parsing the SQL per request.
    // UPSERT keeps `first_registered_at` from the original row (uses COALESCE
    // via the SELECT in the ON CONFLICT clause) and bumps last_registered_at.
    this.upsertStmt = this.db.prepare(`
      INSERT INTO fleet_devices (device_id, public_key_pem, hostname, version_str, first_registered_at, last_registered_at, metadata_json)
      VALUES (@deviceId, @publicKeyPem, @hostname, @versionStr, @nowIso, @nowIso, @metadataJson)
      ON CONFLICT(device_id) DO UPDATE SET
        public_key_pem     = excluded.public_key_pem,
        hostname           = excluded.hostname,
        version_str        = excluded.version_str,
        last_registered_at = excluded.last_registered_at,
        metadata_json      = excluded.metadata_json
    `);

    this.listStmt = this.db.prepare(`
      SELECT
        device_id           AS deviceId,
        public_key_pem      AS publicKeyPem,
        hostname            AS hostname,
        version_str         AS versionStr,
        first_registered_at AS firstRegisteredAt,
        last_registered_at  AS lastRegisteredAt,
        metadata_json       AS metadataJson,
        last_seen_at        AS lastSeenAt,
        admission_status    AS admissionStatus
      FROM fleet_devices
      ORDER BY last_registered_at DESC
      LIMIT ?
    `);

    this.getStmt = this.db.prepare(`
      SELECT
        device_id           AS deviceId,
        public_key_pem      AS publicKeyPem,
        hostname            AS hostname,
        version_str         AS versionStr,
        first_registered_at AS firstRegisteredAt,
        last_registered_at  AS lastRegisteredAt,
        metadata_json       AS metadataJson,
        last_seen_at        AS lastSeenAt,
        admission_status    AS admissionStatus
      FROM fleet_devices
      WHERE device_id = ?
    `);

    this.setLastSeenStmt = this.db.prepare(`
      UPDATE fleet_devices SET last_seen_at = ? WHERE device_id = ?
    `);
    this.setAdmissionStmt = this.db.prepare(`
      UPDATE fleet_devices SET admission_status = ? WHERE device_id = ?
    `);

    this.countStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM fleet_devices`);
  }

  /** Insert or update a device. Returns the row that was written. */
  upsert(input: {
    deviceId: string;
    publicKeyPem: string;
    hostname: string;
    versionStr: string;
    metadata?: Record<string, string>;
    now?: Date;
  }): DeviceRow {
    const nowIso = (input.now ?? new Date()).toISOString();
    const metadataJson = input.metadata && Object.keys(input.metadata).length > 0
      ? JSON.stringify(input.metadata)
      : null;
    this.upsertStmt.run({
      deviceId: input.deviceId,
      publicKeyPem: input.publicKeyPem,
      hostname: input.hostname,
      versionStr: input.versionStr,
      nowIso,
      metadataJson,
    });
    const row = this.getStmt.get(input.deviceId) as DeviceRow | undefined;
    if (!row) throw new Error('RegistryStore.upsert: row not visible after write — bug');
    return row;
  }

  /**
   * List devices, most-recently-registered first.
   * @param limit  Max rows to return. Default 100, clamped to [1, 1000].
   */
  list(limit: number = 100): DeviceRow[] {
    const clamped = Math.max(1, Math.min(1000, Math.floor(limit)));
    return this.listStmt.all(clamped) as DeviceRow[];
  }

  /** Lookup one device. Returns undefined if not present. */
  get(deviceId: string): DeviceRow | undefined {
    return this.getStmt.get(deviceId) as DeviceRow | undefined;
  }

  /**
   * Slice 4 — bump the device's `last_seen_at` heartbeat column. Called by
   * the inbox handler on every long-poll. Silently no-ops for unknown
   * deviceIds — the inbox handler 404s those before this is reached.
   */
  setLastSeen(deviceId: string, now: Date = new Date()): void {
    this.setLastSeenStmt.run(now.toISOString(), deviceId);
  }

  /**
   * Slice 4 — flip admission state. Returns the updated row, or undefined
   * if the device is not registered. Admin-driven; auditing is the caller's
   * responsibility (admin routes append admission audit entries).
   */
  setAdmissionStatus(deviceId: string, status: AdmissionStatus): DeviceRow | undefined {
    const r = this.setAdmissionStmt.run(status, deviceId);
    if (r.changes === 0) return undefined;
    return this.get(deviceId);
  }

  /** Total row count — cheap. */
  count(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  /** Close the underlying SQLite handle. */
  close(): void {
    this.db.close();
  }

  /**
   * Slice-4 additive migrations — add `last_seen_at` (nullable, no default)
   * and `admission_status` (default 'approved' so existing rows match slice
   * 1+2 implicit-approval semantics). Each ALTER is its own try/catch
   * silencing only the known-race messages — every other error re-throws.
   */
  private addSlice4Columns(): void {
    const alters = [
      "ALTER TABLE fleet_devices ADD COLUMN last_seen_at TEXT",
      "ALTER TABLE fleet_devices ADD COLUMN admission_status TEXT NOT NULL DEFAULT 'approved'",
    ];
    for (const sql of alters) {
      try {
        this.db.exec(sql);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('duplicate column name') || msg.includes('already has a column named')) continue;
        throw err;
      }
    }
  }
}
