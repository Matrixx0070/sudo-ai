/**
 * @file sandbox/sandbox-manager.ts
 * @description SandboxManager provisions/tears down per-session workspace dirs
 * and manages per-session SandboxPolicy overrides.
 *
 * Listens to SessionStateMachine events:
 *   session:status:terminated — triggers teardown
 *   session:status:archived   — triggers teardown
 *
 * Security invariants:
 *   teardown() validates workspace path via realpathSync before rm -rf.
 *   Path must start with workspaceRoot + path.sep to prevent traversal.
 */

import { type EventEmitter } from 'node:events';
import { mkdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  type SandboxPolicy,
  SandboxManagerError,
} from './sandbox-types.js';
import { mergePolicy } from './sandbox-policy.js';

const log = createLogger('sandbox:manager');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SandboxManagerOptions {
  /** Root dir under which per-session workspace dirs are created. */
  workspaceRoot: string;
  /** Default policy applied when no session-specific override is set. */
  defaultPolicy: SandboxPolicy;
  /**
   * SessionStateMachine instance (duck-typed as EventEmitter).
   * Manager subscribes to 'session:status:terminated' and 'session:status:archived'.
   */
  stateMachine: EventEmitter;
  // P1 cross
  platform?: 'linux' | 'win' | 'mac';
}

// ---------------------------------------------------------------------------
// SandboxManager
// ---------------------------------------------------------------------------

export class SandboxManager {
  private readonly _workspaceRoot: string;
  private readonly _defaultPolicy: SandboxPolicy;
  private readonly _stateMachine: EventEmitter;

  /** sessionId → absolute workspace path */
  private readonly _provisioned = new Map<string, string>();
  /** sessionId → per-session policy override (partial, merged on read) */
  private readonly _policyOverrides = new Map<string, Partial<SandboxPolicy>>();

  /** Bound handler references for later removal in a potential destroy(). */
  private readonly _onTerminal: (payload: { sessionId: string }) => void;

  constructor(opts: SandboxManagerOptions) {
    this._workspaceRoot = path.resolve(opts.workspaceRoot);
    this._defaultPolicy = opts.defaultPolicy;
    this._stateMachine = opts.stateMachine;

    // Bind once so we can use the same reference for .off() if needed
    this._onTerminal = (payload: { sessionId: string }) => {
      void this._handleSessionTerminal(payload);
    };

    this._stateMachine.on('session:status:terminated', this._onTerminal);
    this._stateMachine.on('session:status:archived', this._onTerminal);

    log.info({ workspaceRoot: this._workspaceRoot }, 'SandboxManager initialized');
  }

  // ---------------------------------------------------------------------------
  // provision
  // ---------------------------------------------------------------------------

  /**
   * Provision a workspace directory for sessionId.
   * Idempotent — returns same path if already provisioned.
   * Returns absolute path.
   */
  async provision(sessionId: string): Promise<string> {
    const existing = this._provisioned.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }

    if (!isValidSessionId(sessionId)) {
      throw new Error(`SandboxManager: invalid sessionId: ${JSON.stringify(sessionId)}`);
    }

    const dir = path.join(this._workspaceRoot, sessionId);
    mkdirSync(dir, { recursive: true });

    const absDir = path.resolve(dir);
    this._provisioned.set(sessionId, absDir);
    log.info({ sessionId, dir: absDir }, 'workspace provisioned');
    return absDir;
  }

  // ---------------------------------------------------------------------------
  // getPolicyFor
  // ---------------------------------------------------------------------------

  /**
   * Return merged policy for sessionId.
   * Session-level override wins over defaultPolicy.
   */
  getPolicyFor(sessionId: string): SandboxPolicy {
    const override = this._policyOverrides.get(sessionId);
    if (override === undefined) {
      return { ...this._defaultPolicy };
    }
    return mergePolicy(this._defaultPolicy, override);
  }

  // ---------------------------------------------------------------------------
  // setPolicy
  // ---------------------------------------------------------------------------

  /**
   * Set (or replace) a per-session policy override.
   * Called by loop-helpers after agent config lookup.
   */
  setPolicy(sessionId: string, policy: Partial<SandboxPolicy>): void {
    this._policyOverrides.set(sessionId, policy);
    log.debug({ sessionId }, 'sandbox policy override set');
  }

  // ---------------------------------------------------------------------------
  // getWorkspaceDir
  // ---------------------------------------------------------------------------

  /**
   * Return the provisioned workspace directory for sessionId.
   * Returns the stored path if provisioned, or constructs the expected path.
   * Does NOT create the directory — call provision() first.
   */
  getWorkspaceDir(sessionId: string): string {
    const existing = this._provisioned.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    // Return expected path even if not yet provisioned
    return path.join(this._workspaceRoot, sessionId);
  }

  // ---------------------------------------------------------------------------
  // teardown
  // ---------------------------------------------------------------------------

  /**
   * Remove workspace directory for sessionId using rm -rf.
   * Guards against path traversal: resolves realpath and verifies it starts
   * with workspaceRoot + path.sep. Throws if invariant violated.
   * Idempotent — no-op if directory does not exist.
   */
  async teardown(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new SandboxManagerError(
        `SandboxManager.teardown: invalid sessionId: ${JSON.stringify(sessionId)}`,
      );
    }

    const dir = this._provisioned.get(sessionId) ?? path.join(this._workspaceRoot, sessionId);

    // Idempotent: skip if already removed
    if (!existsSync(dir)) {
      this._provisioned.delete(sessionId);
      this._policyOverrides.delete(sessionId);
      return;
    }

    // Realpath guard — follow symlinks and verify path is under workspaceRoot
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      log.warn({ sessionId, dir }, 'teardown: realpathSync failed, skipping');
      this._provisioned.delete(sessionId);
      this._policyOverrides.delete(sessionId);
      return;
    }

    const guardPrefix = this._workspaceRoot + path.sep;
    if (!realDir.startsWith(guardPrefix)) {
      const msg =
        `SandboxManager.teardown: SECURITY — resolved path ${realDir} ` +
        `is not under workspaceRoot ${this._workspaceRoot}`;
      log.error({ sessionId, realDir, workspaceRoot: this._workspaceRoot }, msg);
      throw new Error(msg);
    }

    try {
      rmSync(realDir, { recursive: true, force: true });
      log.info({ sessionId, dir: realDir }, 'workspace torn down');
    } catch (err) {
      log.warn({ sessionId, err: String(err) }, 'teardown: rmSync failed');
    }

    this._provisioned.delete(sessionId);
    this._policyOverrides.delete(sessionId);
  }

  // ---------------------------------------------------------------------------
  // teardownAll
  // ---------------------------------------------------------------------------

  /**
   * Teardown all provisioned sessions. Called at process shutdown.
   * Errors in individual teardowns are logged but do not stop others.
   */
  async teardownAll(): Promise<void> {
    const sessionIds = [...this._provisioned.keys()];
    log.info({ count: sessionIds.length }, 'teardownAll started');

    const results = await Promise.allSettled(
      sessionIds.map((id) => this.teardown(id)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result && result.status === 'rejected') {
        log.warn({ sessionId: sessionIds[i], err: String(result.reason) }, 'teardownAll: partial failure');
      }
    }

    log.info('teardownAll complete');
  }

  // ---------------------------------------------------------------------------
  // Internal: session terminal event handler
  // ---------------------------------------------------------------------------

  private async _handleSessionTerminal(payload: { sessionId: string }): Promise<void> {
    const { sessionId } = payload;
    if (!sessionId) return;
    try {
      await this.teardown(sessionId);
    } catch (err) {
      log.warn({ sessionId, err: String(err) }, '_onSessionTerminal: teardown failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Basic sessionId validation to prevent directory traversal via the sessionId itself.
 * Accepts alphanumeric, hyphens, and underscores only.
 */
function isValidSessionId(sessionId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(sessionId);
}
