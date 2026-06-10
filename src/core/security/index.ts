/**
 * @file security/index.ts
 * @description SecurityGuard — comprehensive threat detection and mitigation for SUDO-AI.
 *
 * Subsystems:
 *  1. Prompt injection detection  — score-based, warns brain (non-blocking).
 *  2. Dangerous tool-call blocking — hard-blocks destructive patterns.
 *  3. Per-user rate limiting       — sliding window, owner-exempt.
 *  4. Audit logging                — data/logs/security.log + pino.
 *
 * Patterns live in patterns.ts, rate limiter in rate-limiter.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  INJECTION_PATTERNS,
  BLOCKED_EXEC_PATTERNS,
  BLOCKED_IP_PATTERN,
  CLOUD_METADATA_PATTERN,
} from './patterns.js';
import { RateLimiter } from './rate-limiter.js';
import type { CounterKey, RateLimitResult } from './rate-limiter.js';
import { PROJECT_ROOT as RESOLVED_PROJECT_ROOT } from '../shared/paths.js';

const log = createLogger('security');

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

const SECURITY_LOG_PATH = path.resolve('data/logs/security.log');

try {
  fs.mkdirSync(path.dirname(SECURITY_LOG_PATH), { recursive: true });
} catch {
  // Non-fatal.
}

// Project root boundary for file-write validation.
const PROJECT_ROOT = RESOLVED_PROJECT_ROOT;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InjectionCheckResult {
  safe: boolean;
  threat: string | null;
  score: number;
}

export interface ToolValidationResult {
  allowed: boolean;
  reason?: string;
}

export type { RateLimitResult, CounterKey };

export interface SecurityEvent {
  type: 'injection_detected' | 'command_blocked' | 'rate_limited' | 'auth_failure' | 'suspicious_activity';
  userId: string;
  details: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: string;
}

export interface SecurityReport {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  topUsers: Array<{ userId: string; count: number }>;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// SecurityGuard
// ---------------------------------------------------------------------------

// Upgrade 42: Prompt Injection Detection (standalone functions)
export {
  detectInjection,
  sanitizeToolResult,
} from './injection-detector.js';
export type { InjectionResult } from './injection-detector.js';

// Upgrade 46: Domain Fetch Validation
export {
  validateDomain,
  setDomainPermission,
  getDomainPermission,
} from './domain-validator.js';
export type { FetchPermission } from './domain-validator.js';

export class SecurityGuard {
  private readonly events: SecurityEvent[] = [];
  private readonly ownerIds: Set<string>;
  private readonly rateLimiter: RateLimiter;

  constructor(ownerIds: string[] = []) {
    const envIds = (process.env['TELEGRAM_CHAT_ID'] ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    this.ownerIds = new Set([...ownerIds, ...envIds]);
    this.rateLimiter = new RateLimiter(this.ownerIds);
    log.info({ ownerCount: this.ownerIds.size }, 'SecurityGuard initialized');
  }

  // -------------------------------------------------------------------------
  // 1. Prompt injection detection
  // -------------------------------------------------------------------------

  detectInjection(message: string): InjectionCheckResult {
    if (!message || typeof message !== 'string') {
      return { safe: true, threat: null, score: 0 };
    }

    let totalScore = 0;
    let firstThreat: string | null = null;

    for (const { pattern, weight, label } of INJECTION_PATTERNS) {
      if (pattern.test(message)) {
        totalScore += weight;
        if (!firstThreat) firstThreat = label;
        log.debug({ label, weight }, 'Injection pattern matched');
      }
    }

    const score = Math.min(totalScore, 1);
    const safe = score <= 0.5;

    if (!safe) {
      this.logSecurityEvent({
        type: 'injection_detected',
        userId: 'unknown',
        details: `Pattern: ${firstThreat}, score: ${score.toFixed(2)}, excerpt: ${message.slice(0, 120)}`,
        severity: score >= 0.8 ? 'critical' : 'high',
        timestamp: new Date().toISOString(),
      });
    } else if (score > 0) {
      this.logSecurityEvent({
        type: 'suspicious_activity',
        userId: 'unknown',
        details: `Low-score injection signal: ${firstThreat}, score: ${score.toFixed(2)}`,
        severity: 'medium',
        timestamp: new Date().toISOString(),
      });
    }

    return { safe, threat: firstThreat, score };
  }

  // -------------------------------------------------------------------------
  // 2. Tool-call validation
  // -------------------------------------------------------------------------

  validateToolCall(toolName: string, args: Record<string, unknown>): ToolValidationResult {
    if (!toolName || typeof toolName !== 'string') {
      return { allowed: false, reason: 'Tool name is required' };
    }

    try {
      if (toolName === 'system.exec' || toolName === 'exec') {
        const cmd = typeof args['command'] === 'string' ? args['command'] : '';
        for (const { pattern, label } of BLOCKED_EXEC_PATTERNS) {
          if (pattern.test(cmd)) {
            return this._block(toolName, `Blocked dangerous exec pattern: ${label}`);
          }
        }
      }

      if (toolName === 'coder.write-file' || toolName === 'fs.write') {
        const filePath = typeof args['path'] === 'string' ? args['path'] : '';
        if (filePath && !path.resolve(filePath).startsWith(PROJECT_ROOT)) {
          return this._block(toolName, `File write outside project root: ${path.resolve(filePath)}`);
        }
      }

      if (toolName === 'browser.navigate' || toolName === 'browser.open') {
        const url = typeof args['url'] === 'string' ? args['url'] : '';
        if (url) {
          if (CLOUD_METADATA_PATTERN.test(url)) return this._block(toolName, `Blocked cloud metadata endpoint: ${url}`);
          if (BLOCKED_IP_PATTERN.test(url)) return this._block(toolName, `Blocked internal IP navigation: ${url}`);
        }
      }

      if (toolName === 'system.api-call' || toolName === 'http.request') {
        const url = typeof args['url'] === 'string' ? args['url'] : '';
        if (url && CLOUD_METADATA_PATTERN.test(url)) {
          return this._block(toolName, `Blocked cloud metadata API call: ${url}`);
        }
      }
    } catch (err) {
      // Fail open: never block legitimate tools due to validator crash.
      log.error({ toolName, err: String(err) }, 'SecurityGuard.validateToolCall threw unexpectedly');
    }

    return { allowed: true };
  }

  // -------------------------------------------------------------------------
  // 3. Rate limiting (delegates to RateLimiter, emits audit event on block)
  // -------------------------------------------------------------------------

  checkRateLimit(userId: string, counterKey: CounterKey = 'messagesPerMinute'): RateLimitResult {
    const result = this.rateLimiter.check(userId, counterKey);
    if (!result.allowed) {
      this.logSecurityEvent({
        type: 'rate_limited',
        userId,
        details: `Counter ${counterKey} exceeded, retry in ${result.retryAfterMs}ms`,
        severity: 'low',
        timestamp: new Date().toISOString(),
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // 4. Audit logging
  // -------------------------------------------------------------------------

  logSecurityEvent(event: SecurityEvent): void {
    if (!event.type || !event.userId || !event.severity) {
      log.warn({ event }, 'logSecurityEvent: incomplete event — skipping');
      return;
    }

    this.events.push(event);

    const pinoLevel: 'warn' | 'info' =
      event.severity === 'critical' || event.severity === 'high' ? 'warn' : 'info';
    log[pinoLevel]({ securityEvent: event }, `Security event: ${event.type}`);

    try {
      fs.appendFileSync(SECURITY_LOG_PATH, JSON.stringify(event) + '\n', 'utf8');
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to write to security.log');
    }
  }

  // -------------------------------------------------------------------------
  // 5. Security report
  // -------------------------------------------------------------------------

  getReport(): SecurityReport {
    const eventsByType: Record<string, number> = {};
    const eventsBySeverity: Record<string, number> = {};
    const userCounts: Record<string, number> = {};

    for (const ev of this.events) {
      eventsByType[ev.type] = (eventsByType[ev.type] ?? 0) + 1;
      eventsBySeverity[ev.severity] = (eventsBySeverity[ev.severity] ?? 0) + 1;
      userCounts[ev.userId] = (userCounts[ev.userId] ?? 0) + 1;
    }

    const topUsers = Object.entries(userCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([userId, count]) => ({ userId, count }));

    return {
      totalEvents: this.events.length,
      eventsByType,
      eventsBySeverity,
      topUsers,
      generatedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _block(toolName: string, reason: string): ToolValidationResult {
    this.logSecurityEvent({
      type: 'command_blocked',
      userId: 'system',
      details: `Tool: ${toolName} — ${reason}`,
      severity: 'high',
      timestamp: new Date().toISOString(),
    });
    log.warn({ toolName, reason }, 'Tool call blocked by SecurityGuard');
    return { allowed: false, reason };
  }
}

// ---------------------------------------------------------------------------
// Upgrade 50 — Web fetch guard (re-exported from web-fetch-guard.ts)
// ---------------------------------------------------------------------------

export { guardFetch, safeFetch } from './web-fetch-guard.js';
export type { FetchGuardResult } from './web-fetch-guard.js';

// Tool translation (OpenClaw/Hermes/OpenJarvis tool mapping)
export { ToolTranslator } from './tool-translator.js';
export type { ToolMapping, ToolTranslationResult } from './tool-translator.js';

// Taint tracking (data lineage from untrusted sources)
export { TaintTracker } from './taint-tracker.js';
export type { TaintSource } from '../shared/wave10-types.js';
export type { Taint, TaintLevel, TaintSet, TaintViolation } from '../shared/wave10-types.js';

// Artifact signing (cryptographic integrity)
export { ArtifactSigner } from './artifact-signer.js';
export type { ArtifactSignature, SignerConfig } from './artifact-signer.js';

// Config 5-Pillar TOML overlay
export { Config5Pillar } from './config-5pillar.js';
export type { PillarConfig, FivePillarConfig } from './config-5pillar.js';
