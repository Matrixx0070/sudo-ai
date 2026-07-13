/**
 * @file safety.ts
 * @description Safety rails for durable browser profiles (Spec 3, step 5):
 *   - an append-only audit log (data/browser-audit.jsonl, mode 0600);
 *   - owner-only + domain-allowlist decision helpers.
 *
 * Owner identity comes from ctx.isOwner (bound to the turn's AgentState by the
 * dispatch layer and threaded onto ToolContext), so checkOwnerAllowed takes the
 * resolved isOwner directly — no side table, no cross-turn staleness. The
 * AUTHORITATIVE per-caller gate remains the channel access policy (Feature 1);
 * this is defense-in-depth.
 */

import { appendFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import { dataPath } from '../../../shared/paths.js';
import type { BrowserProfileEntry } from './profile-registry.js';

const log = createLogger('browser:safety');
// Honors the DATA_DIR env override (prod/staging isolation) — never cwd-relative.
const AUDIT_PATH = dataPath('browser-audit.jsonl');

// --- audit -------------------------------------------------------------------
export function browserAudit(event: string, detail: Record<string, unknown>): void {
  try {
    const dir = dirname(AUDIT_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail }) + '\n';
    appendFileSync(AUDIT_PATH, line, { mode: 0o600 });
    try { chmodSync(AUDIT_PATH, 0o600); } catch { /* best-effort */ }
  } catch (err) {
    log.warn({ err: String(err) }, 'browser audit append failed');
  }
}

// --- decisions ---------------------------------------------------------------

/**
 * Gate an owner-only profile from the resolved caller identity (ctx.isOwner).
 * Known non-owner → denied. Unknown identity (internal/autonomous turn) →
 * allowed (channel policy is the authoritative gate) but audited.
 */
export function checkOwnerAllowed(entry: BrowserProfileEntry, isOwner: boolean | undefined, sessionId?: string): { allowed: boolean; reason?: string } {
  if (!entry.ownerOnly) return { allowed: true };
  if (isOwner === false) {
    browserAudit('owner-only-deny', { profile: entry.name, sessionId });
    return { allowed: false, reason: `profile "${entry.name}" is owner-only and this session is not the owner` };
  }
  if (isOwner === undefined) {
    browserAudit('owner-only-unknown-identity', { profile: entry.name, sessionId });
  }
  return { allowed: true };
}

/** Enforce a profile's per-profile navigation allowlist (empty = no restriction). */
export function domainAllowed(entry: BrowserProfileEntry, url: string): boolean {
  if (!entry.domainAllowlist || entry.domainAllowlist.length === 0) return true;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return entry.domainAllowlist.some((d) => {
    const dd = d.toLowerCase().replace(/^\./, '');
    return host === dd || host.endsWith('.' + dd);
  });
}
