/**
 * @file registry-route-types.ts
 * @description Types, helpers, and rate-limit logic for the public registry endpoints.
 *
 * Shared by registry-routes.ts.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseFrontmatter, type SkillMeta } from './registry-types.js';
import type { SkillRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Public response type (10 fields — spec E4)
// ---------------------------------------------------------------------------

/**
 * Public skill entry shape returned by GET /v1/registry/skills and
 * GET /v1/registry/skills/:id.
 *
 * 14 fields — the canonical 10 plus `metadata` block (trust_tier + display_name),
 * `license`, and `compatibility` added for agentskills.io compliance.
 *
 * NEVER includes body_md, frontmatter_json, archived_at, scoring fields,
 * session attachment records, or the internal SQLite row id.
 */
export interface PublicSkillEntry {
  id: string;               // frontmatter field `id` (e.g. "research.web-summary")
  name: string;             // frontmatter field `name` (canonical slug, e.g. "web-summary")
  version: string;          // frontmatter field `version`
  description: string;      // frontmatter field `description`
  author: string;           // frontmatter field `author`
  trust_tier: 'bundled';    // narrowed — only bundled ever appears in public responses
  caps: string[];           // frontmatter field `caps` (parsed array)
  tags: string[];           // frontmatter field `tags` (empty array if absent)
  source: string;           // frontmatter field `source`
  sha256: string;           // mapped from SkillMeta.sha256
  importedAt: string;       // mapped from SkillMeta.created_at (ISO-8601)
  license: string;          // SPDX identifier, empty string when absent
  compatibility: string[];  // Runtime targets (e.g. ["node-22"]), empty array when absent
  /** Spec-canonical metadata block — trust_tier + display_name for agentskills.io indexers. */
  metadata: {
    trust_tier: 'bundled';
    display_name: string;   // Human label (e.g. "Web Summary"), empty string when absent
  };
}

/**
 * Configuration for registerRegistryRoutes.
 * Currently empty — all fields reserved for future private registry modes.
 */
export interface RegistryRoutesConfig {
  // future: optional auth tokens for private registry modes
  // currently empty — all fields reserved
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

export function setCors(res: ServerResponse): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export const MAX_RAW_BYTES = 256 * 1024; // 256 KB — matches importer.ts MAX_RESPONSE_BYTES

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, msg: string): void {
  sendJson(res, status, { error: { message: msg, code: status } });
}

// ---------------------------------------------------------------------------
// Sliding-window rate limiters (two independent maps — spec E5)
// Key: sha256(ip) — hashed for privacy
// ---------------------------------------------------------------------------

export const REGISTRY_LIST_RL = { windowMs: 60_000, max: 60 };
export const REGISTRY_RAW_RL  = { windowMs: 60_000, max: 20 };

// ---------------------------------------------------------------------------
// Rate-limit map bounds (Issue A — OOM guard for unique-IP flood on public endpoint)
// ---------------------------------------------------------------------------

const MAX_RL_WINDOWS  = 50_000;   // hard cap — 50k unique IPs per map
const RL_EVICT_COUNT  = 10_000;   // evict oldest 10k entries at 80% threshold (50k * 0.8 = 40k trigger)
const RL_EVICT_AT     = MAX_RL_WINDOWS * 0.8; // 40k — trigger LRU sweep before hitting hard cap
const RL_GC_INTERVAL_MS = 60_000; // GC every 60s — cleans empty arrays + truly-expired entries

export const _listRlWindows = new Map<string, number[]>();
export const _rawRlWindows  = new Map<string, number[]>();

/** Evict oldest RL_EVICT_COUNT entries from the map when it exceeds the eviction threshold. */
function evictRlMap(windows: Map<string, number[]>): void {
  let evicted = 0;
  for (const key of windows.keys()) {
    if (evicted >= RL_EVICT_COUNT) break;
    windows.delete(key);
    evicted++;
  }
}

/**
 * Module-level GC: sweep both maps every 60s.
 * Deletes keys whose timestamp array is empty (all expired).
 * Unreffed so the timer does not keep the process alive in tests.
 */
const _rlGcTimer = setInterval(() => {
  const now = Date.now();
  for (const [windows, windowMs] of [
    [_listRlWindows, REGISTRY_LIST_RL.windowMs],
    [_rawRlWindows,  REGISTRY_RAW_RL.windowMs],
  ] as [Map<string, number[]>, number][]) {
    for (const [key, ts] of windows) {
      const filtered = ts.filter((t) => now - t < windowMs);
      if (filtered.length === 0) {
        windows.delete(key);
      } else if (filtered.length !== ts.length) {
        windows.set(key, filtered);
      }
    }
  }
}, RL_GC_INTERVAL_MS);
if (_rlGcTimer.unref) _rlGcTimer.unref();

/**
 * Test seam — resets both rate-limit maps.
 * MUST be called by QE in beforeEach for T8. Never called in production code.
 */
export function _resetRegistryRateLimits(): void {
  _listRlWindows.clear();
  _rawRlWindows.clear();
}

export function hashIp(remoteAddress: string | undefined): string {
  return createHash('sha256')
    .update(remoteAddress ?? 'unknown')
    .digest('hex');
}

export function checkRateLimit(
  windows: Map<string, number[]>,
  key: string,
  windowMs: number,
  max: number,
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const timestamps = (windows.get(key) ?? []).filter((t) => now - t < windowMs);

  if (timestamps.length >= max) {
    const oldest = timestamps[0]!;
    const retryAfterSec = Math.ceil((windowMs - (now - oldest)) / 1000);
    // Persist the filtered (non-stale) array back even on deny
    windows.set(key, timestamps);
    return { allowed: false, retryAfterSec };
  }

  timestamps.push(now);
  windows.set(key, timestamps);

  // Issue A: delete key if array is somehow empty (defensive — should not happen after push)
  if (timestamps.length === 0) windows.delete(key);

  // Issue A: cap enforcement — evict oldest RL_EVICT_COUNT entries when approaching limit
  if (windows.size >= RL_EVICT_AT) {
    evictRlMap(windows);
  }

  return { allowed: true, retryAfterSec: 0 };
}

export function checkListRateLimit(req: IncomingMessage): { allowed: boolean; retryAfterSec: number } {
  const key = hashIp(req.socket.remoteAddress);
  return checkRateLimit(_listRlWindows, key, REGISTRY_LIST_RL.windowMs, REGISTRY_LIST_RL.max);
}

export function checkRawRateLimit(req: IncomingMessage): { allowed: boolean; retryAfterSec: number } {
  const key = hashIp(req.socket.remoteAddress);
  return checkRateLimit(_rawRlWindows, key, REGISTRY_RAW_RL.windowMs, REGISTRY_RAW_RL.max);
}

// ---------------------------------------------------------------------------
// Frontmatter YAML emitter (canonical schema only — scalar + bracket arrays)
// Reconstructs frontmatter header for /raw responses from stored JSON.
// Includes license/compatibility/display_name support.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// agentskills.io compliance helpers
// ---------------------------------------------------------------------------

/**
 * Strip leading and trailing double-quote characters.
 * parseFrontmatter preserves literal quotes around double-quoted values
 * (e.g. `display_name: "Web Summary"` → meta['display_name'] = '"Web Summary"').
 * Apply at every read site so consumers always see the unquoted string.
 */
function stripQuotes(s: string): string {
  return s.replace(/^"|"$/g, '');
}

/**
 * Sanitize a scalar value for safe emission into YAML frontmatter.
 * Replaces any character outside printable ASCII ([\x20-\x7E\t]) with a space.
 * Prevents newline injection that could break YAML structure if a malicious
 * SKILL.md contains control characters in license, display_name, or other fields.
 */
function sanitizeFrontmatterScalar(s: string): string {
  return String(s).replace(/[^\x20-\x7E\t]/g, ' ');
}

// ---------------------------------------------------------------------------
// Frontmatter YAML emitter helpers
// ---------------------------------------------------------------------------

// `metadata` and `display_name` are intentionally excluded here — they are
// emitted as a nested block below rather than as flat scalars.
// `license` and `compatibility` are emitted before `caps`.
const ORDERED_FM_KEYS = ['id', 'name', 'version', 'description', 'author', 'trust_tier', 'license', 'compatibility', 'caps', 'tags', 'source'];

// Keys that must never be emitted as flat scalars (handled by dedicated emitters).
// `display_name` is skipped so the metadata block emitter controls it exclusively.
const SKIP_IN_FALLTHROUGH = new Set([...ORDERED_FM_KEYS, 'metadata', 'display_name']);

export function emitFrontmatterYaml(fm: Record<string, unknown>): string {
  const lines: string[] = ['---'];

  for (const key of ORDERED_FM_KEYS) {
    if (!(key in fm)) continue;
    const val = fm[key];
    if (Array.isArray(val)) {
      lines.push(`${key}: [${(val as string[]).map((v) => sanitizeFrontmatterScalar(String(v))).join(', ')}]`);
    } else if (val !== undefined && val !== null) {
      lines.push(`${key}: ${sanitizeFrontmatterScalar(String(val))}`);
    }
  }

  // Emit spec-canonical metadata block.
  // The block is always emitted when trust_tier is present (either from the
  // stored `metadata: ""` key produced by parseFrontmatter, or derived from the
  // top-level trust_tier field when metadata key is absent — as in the
  // registerFromImport path used by tests).
  const metadataTrustTier = (() => {
    const stored = fm['metadata'];
    if (stored !== null && stored !== undefined && stored !== '') {
      // Genuine object (future-proofing for a real YAML parser upgrade)
      if (typeof stored === 'object' && !Array.isArray(stored)) {
        return (stored as Record<string, unknown>)['trust_tier'] as string | undefined;
      }
    }
    // Derive from top-level trust_tier (covers parseFrontmatter "" case + import path)
    return typeof fm['trust_tier'] === 'string' ? (fm['trust_tier'] as string) : undefined;
  })();

  if (metadataTrustTier !== undefined) {
    lines.push('metadata:');
    lines.push(`  trust_tier: ${sanitizeFrontmatterScalar(metadataTrustTier)}`);
    // Emit display_name inside metadata block when present.
    // Strip quotes because parseFrontmatter preserves them literally.
    const rawDisplayName = fm['display_name'];
    const metadataDisplayName =
      typeof rawDisplayName === 'string' && rawDisplayName.length > 0
        ? stripQuotes(rawDisplayName)
        : typeof fm['name'] === 'string'
          ? stripQuotes(fm['name'] as string)
          : undefined;
    if (metadataDisplayName) {
      lines.push(`  display_name: ${sanitizeFrontmatterScalar(metadataDisplayName)}`);
    }
  }

  // Any remaining non-standard keys (skip ordered keys, metadata, and empty strings)
  for (const [key, val] of Object.entries(fm)) {
    if (SKIP_IN_FALLTHROUGH.has(key)) continue;
    if (Array.isArray(val)) {
      lines.push(`${key}: [${(val as string[]).map((v) => sanitizeFrontmatterScalar(String(v))).join(', ')}]`);
    } else if (val !== undefined && val !== null && val !== '') {
      lines.push(`${key}: ${sanitizeFrontmatterScalar(String(val))}`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Trust-tier filter + PublicSkillEntry projection
// ---------------------------------------------------------------------------

export function isBundled(meta: SkillMeta): boolean {
  const tier = meta.frontmatter['trust_tier'];
  return typeof tier === 'string' && tier === 'bundled' && meta.archived_at === null;
}

export function toPublicEntry(meta: SkillMeta): PublicSkillEntry {
  const fm = meta.frontmatter;

  const caps: string[] = Array.isArray(fm['caps']) ? (fm['caps'] as string[]) : [];
  const tags: string[] = Array.isArray(fm['tags']) ? (fm['tags'] as string[]) : [];

  // agentskills.io fields — license, compatibility, display_name.
  // parseFrontmatter preserves literal double-quotes; stripQuotes removes them.
  const license: string =
    typeof fm['license'] === 'string' ? stripQuotes(fm['license']) : '';
  const compatibility: string[] =
    Array.isArray(fm['compatibility']) ? (fm['compatibility'] as string[]) : [];
  const display_name: string =
    typeof fm['display_name'] === 'string' ? stripQuotes(fm['display_name']) : '';

  return {
    id:          typeof fm['id']          === 'string' ? fm['id']          : meta.name,
    name:        typeof fm['name']        === 'string' ? fm['name']        : meta.name,
    version:     typeof fm['version']     === 'string' ? fm['version']     : String(meta.version),
    description: typeof fm['description'] === 'string' ? fm['description'] : '',
    author:      typeof fm['author']      === 'string' ? fm['author']      : '',
    trust_tier:  'bundled',
    caps,
    tags,
    source:      typeof fm['source']      === 'string' ? fm['source']      : '',
    sha256:      meta.sha256,
    importedAt:  meta.created_at,
    license,
    compatibility,
    // Spec-canonical metadata block — trust_tier + display_name for agentskills.io indexers.
    metadata:    { trust_tier: 'bundled', display_name },
  };
}

/**
 * Find a bundled skill by its frontmatter `id` field (e.g. "research.web-summary").
 * Returns null if not found, not bundled, or archived.
 *
 * Two-pass lookup to handle both storage paths:
 *   1. Fast path: frontmatter_json includes `id` (scanAndRegister path).
 *   2. Fallback: registerFromImport omits `id` from frontmatter_json — parse it
 *      directly from body_md which contains the full raw SKILL.md content.
 *      Injection errors for individual skills are swallowed so one poisoned
 *      skill cannot block lookup of all others.
 */
export function findBundledByFrontmatterId(
  registry: SkillRegistry,
  frontmatterId: string,
): SkillMeta | null {
  // list() already filters archived; fetch up to 200 (bundled skills are far fewer)
  const all = registry.list(200, 0);

  for (const m of all) {
    if (!isBundled(m)) continue;

    // Fast path: frontmatter_json already has id stored (scanAndRegister path)
    if (m.frontmatter['id'] === frontmatterId) return m;

    // Fallback: registerFromImport drops the `id` key from frontmatter_json.
    // The raw SKILL.md (with full frontmatter) is stored in body_md — parse it.
    // When a match is found, return a copy of the SkillMeta with frontmatter
    // augmented from body_md so that toPublicEntry returns the correct fields.
    try {
      const full = registry.getSkillById(m.id);
      if (!full) continue;
      const { meta: bodyMeta } = parseFrontmatter(full.body_md);
      if (bodyMeta['id'] === frontmatterId) {
        // Merge: body_md parsed frontmatter wins for any missing keys
        return {
          ...m,
          frontmatter: { ...bodyMeta, ...m.frontmatter, id: bodyMeta['id'] },
        };
      }
    } catch {
      // Injection-blocked or other transient error — skip this entry safely
      continue;
    }
  }

  return null;
}
