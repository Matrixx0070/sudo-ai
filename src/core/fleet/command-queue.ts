/**
 * @file src/core/fleet/command-queue.ts
 * @description Gap #28c slice 2 — the back-channel queue. Registrar inserts
 * a command on admin dispatch; device pulls it via long-poll inbox; device
 * POSTs back a result. The queue is the only shared state between the
 * admin and the device worker.
 *
 * **Persistence**: SQLite (DATA_DIR/fleet.db, same file as RegistryStore).
 * State survives registrar restart; a half-flighted command (status =
 * 'in_flight') will appear back in the inbox after restart so the device
 * can still complete it. The device-side executor is idempotent enough
 * for slice-2 commands (model.get is pure read; model.set is single-call
 * idempotent).
 *
 * **Long-poll waiters**: in-memory map `deviceId → Array<resolver>`. When
 * `enqueue` lands a command, we resolve the first matching waiter so the
 * device's pending GET wakes immediately. If no waiter is registered (no
 * device polling), the command stays `queued` until the next poll.
 *
 * **Slice-2 command set**: `model.get` and `model.set`. The queue holds
 * the command as opaque JSON — adding kinds is a device-side change with
 * NO queue schema migration.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

/** Persisted command states. */
export type CommandStatus = 'queued' | 'in_flight' | 'completed' | 'failed' | 'timeout';

/**
 * Fleet command kinds dispatched over the back-channel.
 *
 * - Slice 2 (#28c): `model.get`, `model.set` (brain-backed)
 * - Gap #28d slice 1: `autonomy.{pause,resume,status}` (WakeSleepCycle-backed)
 * - Gap #28d slice 2: `alignment.digest` (AlignmentAggregator-backed —
 *   admin's `/api/admin/fleet/alignment` rollup reads the latest completed
 *   row per device from this table for the fleet-wide view)
 *
 * Adding new kinds is intentionally a device-side change with NO queue
 * schema migration — see the file header for the contract.
 */
export type CommandKind =
  | 'model.get'
  | 'model.set'
  | 'autonomy.pause'
  | 'autonomy.resume'
  | 'autonomy.status'
  | 'alignment.digest';

/** Command body. */
export interface CommandBody {
  kind: CommandKind;
  args?: Record<string, unknown>;
}

/** Result returned by a device after executing a command. */
export interface CommandResult {
  status: 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

/** A row as returned to callers. */
export interface CommandRow {
  commandId: string;
  deviceId: string;
  kind: CommandKind;
  argsJson: string | null;
  status: CommandStatus;
  dispatcher: string;
  dispatchedAt: string;
  pickedUpAt: string | null;
  completedAt: string | null;
  resultJson: string | null;
  errorMessage: string | null;
}

/** Constructor options for `CommandQueue`. */
export interface CommandQueueOptions {
  /** SQLite path. Defaults to the same fleet.db RegistryStore uses. */
  dbPath: string;
}

/**
 * Long-poll inbox queue. One instance per registrar.
 */
export class CommandQueue {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly nextQueuedStmt: Database.Statement;
  private readonly markInFlightStmt: Database.Statement;
  private readonly completeStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly listForDeviceStmt: Database.Statement;
  /**
   * Resolvers waiting for a command on a given device. Each entry resolves
   * to the command id when one is enqueued, OR `null` after the long-poll
   * timeout fires (handled by the caller via Promise.race).
   */
  private readonly waiters: Map<string, Array<(commandId: string | null) => void>> = new Map();

  constructor(opts: CommandQueueOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_commands (
        command_id     TEXT PRIMARY KEY,
        device_id      TEXT NOT NULL,
        kind           TEXT NOT NULL,
        args_json      TEXT,
        status         TEXT NOT NULL DEFAULT 'queued',
        dispatcher     TEXT NOT NULL,
        dispatched_at  TEXT NOT NULL,
        picked_up_at   TEXT,
        completed_at   TEXT,
        result_json    TEXT,
        error_message  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_fleet_commands_device_status
        ON fleet_commands(device_id, status);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO fleet_commands (command_id, device_id, kind, args_json, status, dispatcher, dispatched_at)
      VALUES (@commandId, @deviceId, @kind, @argsJson, 'queued', @dispatcher, @nowIso)
    `);
    // SELECT then UPDATE within a single transaction inside `pickup()` so a
    // racing second poller can't grab the same command.
    this.nextQueuedStmt = this.db.prepare(`
      SELECT command_id AS commandId
      FROM fleet_commands
      WHERE device_id = ? AND status IN ('queued', 'in_flight')
      ORDER BY dispatched_at ASC
      LIMIT 1
    `);
    this.markInFlightStmt = this.db.prepare(`
      UPDATE fleet_commands
      SET status = 'in_flight', picked_up_at = COALESCE(picked_up_at, ?)
      WHERE command_id = ? AND status IN ('queued', 'in_flight')
    `);
    this.completeStmt = this.db.prepare(`
      UPDATE fleet_commands
      SET status        = @status,
          completed_at  = @nowIso,
          result_json   = @resultJson,
          error_message = @errorMessage
      WHERE command_id = @commandId AND status = 'in_flight'
    `);
    this.getStmt = this.db.prepare(`
      SELECT
        command_id    AS commandId,
        device_id     AS deviceId,
        kind          AS kind,
        args_json     AS argsJson,
        status        AS status,
        dispatcher    AS dispatcher,
        dispatched_at AS dispatchedAt,
        picked_up_at  AS pickedUpAt,
        completed_at  AS completedAt,
        result_json   AS resultJson,
        error_message AS errorMessage
      FROM fleet_commands
      WHERE command_id = ?
    `);
    this.listForDeviceStmt = this.db.prepare(`
      SELECT
        command_id    AS commandId,
        device_id     AS deviceId,
        kind          AS kind,
        args_json     AS argsJson,
        status        AS status,
        dispatcher    AS dispatcher,
        dispatched_at AS dispatchedAt,
        picked_up_at  AS pickedUpAt,
        completed_at  AS completedAt,
        result_json   AS resultJson,
        error_message AS errorMessage
      FROM fleet_commands
      WHERE device_id = ?
      ORDER BY dispatched_at DESC
      LIMIT ?
    `);
  }

  /** Insert a queued command + wake one waiter (if any). Returns the new id. */
  enqueue(input: {
    deviceId: string;
    command: CommandBody;
    dispatcher: string;
    now?: Date;
  }): string {
    const commandId = randomUUID();
    const nowIso = (input.now ?? new Date()).toISOString();
    const argsJson = input.command.args ? JSON.stringify(input.command.args) : null;
    this.insertStmt.run({
      commandId,
      deviceId: input.deviceId,
      kind: input.command.kind,
      argsJson,
      dispatcher: input.dispatcher,
      nowIso,
    });
    // Wake the first waiter on this device, if any.
    const waiters = this.waiters.get(input.deviceId);
    if (waiters && waiters.length > 0) {
      const next = waiters.shift()!;
      next(commandId);
    }
    return commandId;
  }

  /**
   * Atomically pick up the next queued (or stuck-in_flight) command for a
   * device. Returns `undefined` when none is available. Marks the picked
   * command as in_flight so a second poller does not race.
   */
  pickup(deviceId: string, now: Date = new Date()): CommandRow | undefined {
    const txn = this.db.transaction((dev: string, ts: string) => {
      const head = this.nextQueuedStmt.get(dev) as { commandId: string } | undefined;
      if (!head) return undefined;
      this.markInFlightStmt.run(ts, head.commandId);
      return this.getStmt.get(head.commandId) as CommandRow | undefined;
    });
    return txn(deviceId, now.toISOString());
  }

  /**
   * Long-poll variant of `pickup`. Resolves immediately if a command is
   * available; otherwise waits up to `timeoutMs` for an `enqueue` to wake
   * us. Returns `undefined` if the timeout fires first.
   */
  async pickupLongPoll(deviceId: string, timeoutMs: number): Promise<CommandRow | undefined> {
    const immediate = this.pickup(deviceId);
    if (immediate) return immediate;

    return new Promise<CommandRow | undefined>((resolve) => {
      const list = this.waiters.get(deviceId) ?? [];
      const waiter = (commandId: string | null): void => {
        clearTimeout(timer);
        // Remove ourselves from the list (idempotent — `enqueue` already
        // shift()ed but the timer-path needs to clean up).
        const cur = this.waiters.get(deviceId);
        if (cur) {
          const idx = cur.indexOf(waiter);
          if (idx >= 0) cur.splice(idx, 1);
        }
        if (commandId === null) {
          // Timeout — re-check for a command anyway (a tiny race window
          // exists between enqueue and our timer firing).
          resolve(this.pickup(deviceId));
        } else {
          // We were woken by enqueue. Do the atomic pickup now.
          resolve(this.pickup(deviceId));
        }
      };
      list.push(waiter);
      this.waiters.set(deviceId, list);
      const timer = setTimeout(() => waiter(null), timeoutMs);
    });
  }

  /**
   * Record a result. Returns the updated row, or undefined if the command
   * is not in_flight (i.e. already completed or unknown).
   */
  complete(input: { commandId: string; result: CommandResult; now?: Date }): CommandRow | undefined {
    const nowIso = (input.now ?? new Date()).toISOString();
    const r = this.completeStmt.run({
      commandId: input.commandId,
      status: input.result.status,
      nowIso,
      resultJson: input.result.result !== undefined ? JSON.stringify(input.result.result) : null,
      errorMessage: input.result.error ?? null,
    });
    if (r.changes === 0) return undefined;
    return this.getStmt.get(input.commandId) as CommandRow | undefined;
  }

  /** Mark a command as timed-out (admin-side bookkeeping). */
  markTimeout(commandId: string, now: Date = new Date()): CommandRow | undefined {
    const r = this.db.prepare(
      `UPDATE fleet_commands SET status = 'timeout', completed_at = ? WHERE command_id = ? AND status IN ('queued', 'in_flight')`,
    ).run(now.toISOString(), commandId);
    if (r.changes === 0) return undefined;
    return this.getStmt.get(commandId) as CommandRow | undefined;
  }

  /** Lookup one command. */
  get(commandId: string): CommandRow | undefined {
    return this.getStmt.get(commandId) as CommandRow | undefined;
  }

  /** List recent commands for a device (admin-facing). */
  listForDevice(deviceId: string, limit: number = 50): CommandRow[] {
    const clamped = Math.max(1, Math.min(1000, Math.floor(limit)));
    return this.listForDeviceStmt.all(deviceId, clamped) as CommandRow[];
  }

  /**
   * Return the most recent `completed` row of the given kind for each
   * device that has one. Used by the gap #28d slice 2 admin endpoint
   * `/api/admin/fleet/alignment` to build the fleet-wide rollup without
   * needing a per-device cache column.
   *
   * Devices with no completed row of this kind are simply absent from
   * the result — the route handler joins against RegistryStore to derive
   * a "missing" list.
   */
  latestCompletedByKindPerDevice(kind: CommandKind): CommandRow[] {
    return this.db.prepare(`
      SELECT
        command_id    AS commandId,
        device_id     AS deviceId,
        kind          AS kind,
        args_json     AS argsJson,
        status        AS status,
        dispatcher    AS dispatcher,
        dispatched_at AS dispatchedAt,
        picked_up_at  AS pickedUpAt,
        completed_at  AS completedAt,
        result_json   AS resultJson,
        error_message AS errorMessage
      FROM fleet_commands fc
      WHERE kind = ? AND status = 'completed' AND completed_at = (
        SELECT MAX(completed_at) FROM fleet_commands
        WHERE kind = ? AND status = 'completed' AND device_id = fc.device_id
      )
    `).all(kind, kind) as CommandRow[];
  }

  /** Total row count — debug + tests. */
  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM fleet_commands`).get() as { n: number }).n;
  }

  close(): void {
    // Wake any pending long-pollers so callers' promises resolve before close.
    for (const list of this.waiters.values()) {
      for (const w of list) w(null);
    }
    this.waiters.clear();
    this.db.close();
  }
}
