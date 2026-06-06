/**
 * TeamPermissionSync coordinates permission requests between workers
 * and the team leader.
 *
 * Workers that need approval for dangerous or restricted operations send
 * a permission request through this module. The leader (or an
 * auto-apply rule) can approve or deny the request. Pending requests
 * are held in an in-memory queue until resolved.
 *
 * Auto-apply rules allow pre-configured patterns to automatically
 * approve or deny matching requests without leader intervention.
 */

import { EventEmitter } from 'events';
import { createLogger } from '../../shared/logger.js';
import { genId } from '../../shared/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Whether a permission request was approved or denied. */
export type PermissionVerdict = 'approved' | 'denied';

/** The lifecycle status of a single permission request. */
export type PermissionStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** A single permission request. */
export interface PermissionRequest {
  /** Unique request identifier. */
  id: string;
  /** AgentId of the worker making the request. */
  requesterId: string;
  /** Name of the tool or action being requested. */
  action: string;
  /** Arguments associated with the action (e.g. file path). */
  args: Record<string, unknown>;
  /** Why the permission is needed (human-readable). */
  reason: string;
  /** ISO timestamp of when the request was created. */
  createdAt: string;
  /** Current resolution status. */
  status: PermissionStatus;
  /** Who resolved the request (leader agentId or 'auto-rule'). */
  resolvedBy?: string;
  /** ISO timestamp of resolution. */
  resolvedAt?: string;
  /** Optional explanation for the verdict. */
  responseReason?: string;
}

/** An auto-apply rule that can short-circuit the approval flow. */
export interface AutoApplyRule {
  /** Unique rule identifier. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Glob or regex pattern to match against the action name. */
  actionPattern: string;
  /** Whether matching requests are auto-approved or auto-denied. */
  verdict: PermissionVerdict;
  /** Optional: only auto-apply if the requester matches this pattern. */
  requesterPattern?: string;
  /** Rule priority — higher priority rules are evaluated first. */
  priority: number;
}

/** Options for the requestPermission call. */
export interface PermissionRequestOptions {
  /** The tool or action name. */
  action: string;
  /** Arguments to the action. */
  args?: Record<string, unknown>;
  /** Human-readable justification. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// TeamPermissionSync
// ---------------------------------------------------------------------------

const log = createLogger('team-permission-sync');

export class TeamPermissionSync extends EventEmitter {
  private readonly pending: Map<string, PermissionRequest> = new Map();
  private readonly resolved: Map<string, PermissionRequest> = new Map();
  private readonly rules: AutoApplyRule[] = [];
  private readonly leaderId: string;

  /** Milliseconds after which a pending request is auto-expired. */
  private readonly expiryMs: number;

  constructor(leaderId: string, expiryMs: number = 30_000) {
    super();
    this.leaderId = leaderId;
    this.expiryMs = expiryMs;
  }

  // -----------------------------------------------------------------------
  // Auto-apply rules
  // -----------------------------------------------------------------------

  /**
   * Register an auto-apply rule. Rules are evaluated in priority order
   * (highest first) when a new permission request comes in.
   */
  addAutoApplyRule(rule: Omit<AutoApplyRule, 'id'>): AutoApplyRule {
    const fullRule: AutoApplyRule = { ...rule, id: genId() };
    this.rules.push(fullRule);
    this.rules.sort((a, b) => b.priority - a.priority);
    log.info({ ruleId: fullRule.id, action: rule.actionPattern, verdict: rule.verdict }, 'Auto-apply rule added');
    return fullRule;
  }

  /**
   * Remove an auto-apply rule by its id.
   *
   * @returns `true` if the rule was found and removed.
   */
  removeAutoApplyRule(ruleId: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  // -----------------------------------------------------------------------
  // Request / respond
  // -----------------------------------------------------------------------

  /**
   * Submit a permission request from a worker. If an auto-apply rule
   * matches, the request is resolved immediately and the caller gets a
   * non-pending status back.
   *
   * @returns The PermissionRequest (may already be resolved by auto-rule).
   */
  requestPermission(
    requesterId: string,
    options: PermissionRequestOptions,
  ): PermissionRequest {
    const req: PermissionRequest = {
      id: genId(),
      requesterId,
      action: options.action,
      args: options.args ?? {},
      reason: options.reason ?? '',
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    // Evaluate auto-apply rules in priority order.
    const autoRule = this.evaluateAutoRules(req);
    if (autoRule) {
      req.status = autoRule.verdict === 'approved' ? 'approved' : 'denied';
      req.resolvedBy = 'auto-rule';
      req.resolvedAt = new Date().toISOString();
      req.responseReason = `Auto-apply rule: ${autoRule.description}`;
      this.resolved.set(req.id, req);
      log.info(
        { reqId: req.id, action: req.action, verdict: autoRule.verdict, ruleId: autoRule.id },
        'Permission auto-resolved',
      );
      this.emit('permission:resolved', req);
    } else {
      this.pending.set(req.id, req);
      log.info({ reqId: req.id, action: req.action, requesterId }, 'Permission request pending');
      this.emit('permission:requested', req);

      // Schedule auto-expiry.
      this.scheduleExpiry(req.id);
    }

    return req;
  }

  /**
   * Leader responds to a pending permission request.
   *
   * @param reqId    - The request id to respond to.
   * @param verdict  - 'approved' or 'denied'.
   * @param reason   - Optional explanation.
   * @returns The updated PermissionRequest.
   * @throws If the request is not found or already resolved.
   */
  respondToPermission(
    reqId: string,
    verdict: PermissionVerdict,
    reason?: string,
  ): PermissionRequest {
    const req = this.pending.get(reqId);
    if (!req) {
      // Check if already resolved
      const already = this.resolved.get(reqId);
      if (already) {
        throw new Error(`respondToPermission: request ${reqId} already resolved (${already.status})`);
      }
      throw new Error(`respondToPermission: request ${reqId} not found`);
    }

    req.status = verdict === 'approved' ? 'approved' : 'denied';
    req.resolvedBy = this.leaderId;
    req.resolvedAt = new Date().toISOString();
    req.responseReason = reason;

    this.pending.delete(reqId);
    this.resolved.set(reqId, req);

    log.info({ reqId, verdict, action: req.action }, 'Permission resolved by leader');
    this.emit('permission:resolved', req);

    return req;
  }

  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  /**
   * Return all pending (unresolved) permission requests.
   */
  getPending(): PermissionRequest[] {
    return Array.from(this.pending.values());
  }

  /**
   * Return a specific request by id (pending or resolved).
   */
  getRequest(reqId: string): PermissionRequest | undefined {
    return this.pending.get(reqId) ?? this.resolved.get(reqId);
  }

  /**
   * Return all resolved requests.
   */
  getResolved(): PermissionRequest[] {
    return Array.from(this.resolved.values());
  }

  /**
   * Expire any pending requests that have exceeded the expiry timeout.
   *
   * @returns The number of requests that were expired.
   */
  expireStale(): number {
    const now = Date.now();
    let expired = 0;

    for (const [id, req] of this.pending) {
      const age = now - new Date(req.createdAt).getTime();
      if (age >= this.expiryMs) {
        req.status = 'expired';
        req.resolvedBy = 'system';
        req.resolvedAt = new Date().toISOString();
        req.responseReason = 'Request expired (timeout)';
        this.pending.delete(id);
        this.resolved.set(id, req);
        expired++;
        this.emit('permission:expired', req);
      }
    }

    if (expired > 0) {
      log.info({ expired }, 'Expired stale permission requests');
    }
    return expired;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Evaluate auto-apply rules against a request. Returns the first
   * matching rule (by priority) or undefined.
   */
  private evaluateAutoRules(req: PermissionRequest): AutoApplyRule | undefined {
    for (const rule of this.rules) {
      const actionMatch = this.matchPattern(req.action, rule.actionPattern);
      const requesterMatch = !rule.requesterPattern || this.matchPattern(req.requesterId, rule.requesterPattern);
      if (actionMatch && requesterMatch) {
        return rule;
      }
    }
    return undefined;
  }

  /**
   * Simple pattern matching. Supports:
   *  - Exact string match
   *  - Glob-style wildcards (e.g. "read*" matches "readFile")
   */
  private matchPattern(value: string, pattern: string): boolean {
    if (pattern === value) return true;
    // Convert simple glob to regex: '*' -> '.*', escape other regex chars.
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try {
      const re = new RegExp(`^${escaped}$`);
      return re.test(value);
    } catch {
      return false;
    }
  }

  /**
   * Schedule auto-expiry of a pending request.
   */
  private scheduleExpiry(reqId: string): void {
    setTimeout(() => {
      const req = this.pending.get(reqId);
      if (!req) return; // Already resolved.
      const now = Date.now();
      const age = now - new Date(req.createdAt).getTime();
      if (age >= this.expiryMs) {
        req.status = 'expired';
        req.resolvedBy = 'system';
        req.resolvedAt = new Date().toISOString();
        req.responseReason = 'Request expired (timeout)';
        this.pending.delete(reqId);
        this.resolved.set(reqId, req);
        this.emit('permission:expired', req);
      }
    }, this.expiryMs).unref();
  }
}