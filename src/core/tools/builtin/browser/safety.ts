/**
 * @file safety.ts
 * @description Safety rails for durable browser profiles (Spec 3, step 5):
 *   - session→owner registry (populated by the channel dispatch layer where
 *     Feature 1's isOwner is known) so tools can gate owner-only profiles;
 *   - an append-only audit log (data/browser-audit.jsonl, mode 0600);
 *   - owner-only + domain-allowlist decision helpers.
 *
 * The AUTHORITATIVE per-caller gate is still the channel access policy
 * (Feature 1) — non-owners never reach the agent. This is defense-in-depth:
 * a known non-owner session is denied owner-only profiles; an unknown identity
 * is allowed but audited (single-owner deployments where identity wasn't wired).
 */

import { appendFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { BrowserProfileEntry } from './profile-registry.js';

const log = createLogger('browser:safety');
const AUDIT_PATH = resolve('data/browser-audit.jsonl');
const MAX_IDENTITIES = 2000;

// --- session → owner identity ------------------------------------------------
const identities = new Map<string, boolean>();

/** Record whether the session's driver is the owner (called by dispatch layer). */
export function setSessionOwner(sessionId: string, isOwner: boolean): void {
  if (!sessionId) return;
  if (identities.size >= MAX_IDENTITIES) identities.clear(); // crude bound; identities are cheap to relearn
  identities.set(sessionId, isOwner === true);
}
/** true / false when known, undefined when the session's identity wasn't recorded. */
export function sessionIsOwner(sessionId: string): boolean | undefined {
  return identities.get(sessionId);
}
export function __resetSessionOwnersForTests(): void { identities.clear(); }

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
 * Gate an owner-only profile. Known non-owner → denied. Unknown identity →
 * allowed (single-owner default) but audited so the gap is visible.
 */
export function checkOwnerAllowed(entry: BrowserProfileEntry, sessionId: string): { allowed: boolean; reason?: string } {
  if (!entry.ownerOnly) return { allowed: true };
  const owner = sessionIsOwner(sessionId);
  if (owner === false) {
    browserAudit('owner-only-deny', { profile: entry.name, sessionId });
    return { allowed: false, reason: `profile "${entry.name}" is owner-only and this session is not the owner` };
  }
  if (owner === undefined) {
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
