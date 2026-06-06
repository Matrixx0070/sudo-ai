/**
 * @file skill-registry.ts
 * @description SUDO-AI Public Skill Registry — publishSkill, getSkill, listSkills,
 *   resolveSkill (sudo: URI scheme), verifySkillSignature.
 *
 * The public-facing counterpart to the internal SkillRegistry (registry.ts).
 * Whereas registry.ts is SQLite-backed and internal, this module provides an
 * in-memory registry optimized for publishing, discovery, and URI-based resolution
 * of skills shared across the SUDO-AI ecosystem.
 *
 * Features:
 *   1. publishSkill() with YAML frontmatter parsing and validation
 *   2. getSkill() by name with optional version
 *   3. listSkills() with search, filter, sort, and pagination
 *   4. resolveSkill() via sudo: URI scheme (sudo:author/skill-name@version)
 *   5. verifySkillSignature() using Ed25519-like HMAC verification
 *   6. ETag caching (SHA-256 content-based)
 *   7. Rate limiting (100 requests/min/IP, sliding window)
 *   8. CORS headers on all responses
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { genId, contentHash } from '../shared/utils.js';

const log = createLogger('skills:skill-registry');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed YAML frontmatter for a published skill. */
export interface SkillYamlFrontmatter {
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  tags: string[];
  requires: string[];
  provides: string[];
  license?: string;
  compatibility?: string[];
  trust_tier?: 'bundled' | 'indexed' | 'unreviewed' | 'workspace';
  /** Ed25519-style signature hex string for content verification. */
  signature?: string;
}

/** A published skill entry in the public registry. */
export interface PublishedSkill {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  tags: string[];
  requires: string[];
  provides: string[];
  license: string;
  compatibility: string[];
  trust_tier: 'bundled' | 'indexed' | 'unreviewed' | 'workspace';
  signature: string;
  /** SHA-256 of the raw content (frontmatter + body). Used as ETag. */
  contentSha256: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** Search/filter parameters for listSkills(). */
export interface SkillSearchParams {
  query?: string;
  author?: string;
  category?: string;
  tags?: string[];
  trust_tier?: PublishedSkill['trust_tier'];
  sortBy?: 'name' | 'recent' | 'author' | 'category';
  limit?: number;
  offset?: number;
}

/** Paginated result from listSkills(). */
export interface SkillListResult {
  data: PublishedSkill[];
  total: number;
  limit: number;
  offset: number;
}

/** Resolved skill from a sudo: URI. */
export interface ResolvedSkill {
  skill: PublishedSkill;
  uri: string;
  resolvedAt: string;
}

/** Rate-limit check result. */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SKILL_BODY_BYTES = 1_048_576; // 1 MB
const RATE_LIMIT_WINDOW_MS = 60_000;    // 1 minute
const RATE_LIMIT_MAX = 100;             // 100 requests/min
const MAX_PAGINATION_LIMIT = 200;
const VALID_TRUST_TIERS = new Set<string>(['bundled', 'indexed', 'unreviewed', 'workspace']);
const VALID_CATEGORIES = new Set<string>([
  'automation', 'coding', 'research', 'content-creation', 'data-analysis',
  'devops', 'communication', 'finance', 'security', 'productivity',
  'education', 'entertainment', 'social-media', 'e-commerce', 'custom',
]);

/**
 * sudo: URI regex.
 * Format: sudo:author/skill-name[@version]
 * Examples: sudo:acme/web-summary, sudo:acme/web-summary@2.0.0
 */
const SUDO_URI_RE = /^sudo:([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)(?:@([a-zA-Z0-9_.]+))?$/;

/**
 * Compare two semver-like version strings.
 * Returns: negative if a < b, positive if a > b, 0 if equal.
 * Handles versions like "1.0.0", "2.3.1", etc.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Max-Age': '86400',
};

// ---------------------------------------------------------------------------
// Rate-limit map (sliding window per IP)
// ---------------------------------------------------------------------------

const _rlWindows = new Map<string, number[]>();
const MAX_RL_KEYS = 50_000;
const RL_EVICT_AT = 40_000;  // 80% of 50k
const RL_EVICT_COUNT = 10_000;
const RL_GC_INTERVAL_MS = 60_000;

// Periodic GC: remove expired entries from rate-limit maps
const _rlGcTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of _rlWindows) {
    const filtered = ts.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (filtered.length === 0) {
      _rlWindows.delete(key);
    } else if (filtered.length !== ts.length) {
      _rlWindows.set(key, filtered);
    }
  }
}, RL_GC_INTERVAL_MS);
if (_rlGcTimer.unref) _rlGcTimer.unref();

/**
 * Test seam — resets rate-limit map. Call in beforeEach.
 */
export function _resetSkillRegistryRateLimits(): void {
  _rlWindows.clear();
}

// ---------------------------------------------------------------------------
// YAML Frontmatter Parser
// ---------------------------------------------------------------------------

/**
 * Parse YAML-style --- frontmatter from a raw skill document.
 * Returns { frontmatter, body }. Supports scalar values and bracket arrays.
 */
export function parseYamlFrontmatter(raw: string): {
  frontmatter: SkillYamlFrontmatter;
  body: string;
} {
  const lines = raw.split('\n');
  if (lines[0]?.trimEnd() !== '---') {
    return { frontmatter: _emptyFrontmatter(), body: raw };
  }
  const endIdx = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (endIdx === -1) {
    return { frontmatter: _emptyFrontmatter(), body: raw };
  }

  const rawMeta: Record<string, unknown> = {};
  for (const line of lines.slice(1, endIdx)) {
    const colonAt = line.indexOf(':');
    if (colonAt < 1) continue;
    const key = line.slice(0, colonAt).trim();
    const rawVal = line.slice(colonAt + 1).trim();
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      rawMeta[key] = rawVal
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    } else {
      rawMeta[key] = rawVal;
    }
  }

  const body = lines.slice(endIdx + 1).join('\n').trimStart();
  const frontmatter = _coerceFrontmatter(rawMeta);
  return { frontmatter, body };
}

function _emptyFrontmatter(): SkillYamlFrontmatter {
  return {
    name: '',
    version: '1.0.0',
    description: '',
    author: '',
    category: 'custom',
    tags: [],
    requires: [],
    provides: [],
  };
}

function _coerceFrontmatter(raw: Record<string, unknown>): SkillYamlFrontmatter {
  const str = (v: unknown): string => typeof v === 'string' ? v : '';
  const arr = (v: unknown): string[] => Array.isArray(v) ? (v as string[]) : [];

  const tier = str(raw['trust_tier']);
  return {
    name: str(raw['name']),
    version: str(raw['version']) || '1.0.0',
    description: str(raw['description']),
    author: str(raw['author']),
    category: VALID_CATEGORIES.has(str(raw['category'])) ? str(raw['category']) : 'custom',
    tags: arr(raw['tags']),
    requires: arr(raw['requires']),
    provides: arr(raw['provides']),
    license: str(raw['license']) || undefined,
    compatibility: arr(raw['compatibility']).length > 0 ? arr(raw['compatibility']) : undefined,
    trust_tier: VALID_TRUST_TIERS.has(tier) ? (tier as SkillYamlFrontmatter['trust_tier']) : undefined,
    signature: str(raw['signature']) || undefined,
  };
}

// ---------------------------------------------------------------------------
// Signature Verification
// ---------------------------------------------------------------------------

/**
 * Sign a skill's content using an HMAC-SHA256 with the given secret.
 * Returns a hex string that can be stored in frontmatter `signature`.
 *
 * In production, this would use Ed25519 or similar asymmetric signing.
 * For the registry MVP, HMAC provides content integrity without key management.
 */
export function signSkillContent(contentSha256: string, secret: string): string {
  return _hmacSign(contentSha256, secret);
}

function _hmacSign(data: string, secret: string): string {
  try {
    const crypto = require('node:crypto');
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
  } catch {
    return _fallbackSign(data, secret);
  }
}

function _fallbackSign(data: string, secret: string): string {
  // Deterministic fallback: hash(secret + data)
  return createHash('sha256').update(secret + data).digest('hex');
}

/**
 * Verify a skill's signature against its content hash and a known secret.
 * Returns true if the signature matches the expected HMAC.
 */
export function verifySkillSignature(
  skill: PublishedSkill,
  secret: string,
): boolean {
  if (!skill.signature || !skill.contentSha256) return false;
  const expected = _hmacSign(skill.contentSha256, secret);
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== skill.signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ skill.signature.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// SkillRegistry
// ---------------------------------------------------------------------------

/**
 * Public Skill Registry for the SUDO-AI ecosystem.
 *
 * In-memory registry with publishSkill, getSkill, listSkills (search/filter/pagination),
 * resolveSkill (sudo: URI scheme), verifySkillSignature, ETag caching, and rate limiting.
 */
export class SkillRegistry {
  private readonly skills: Map<string, PublishedSkill> = new Map();
  /** name → Set of versions (e.g., "web-summary" → Set(["1.0.0", "2.0.0"])) */
  private readonly versions: Map<string, Set<string>> = new Map();
  /** name-version composite key → PublishedSkill id (for version lookups) */
  private readonly nameVersionIndex: Map<string, string> = new Map();
  private readonly etagCache: Map<string, string> = new Map();
  private readonly signingSecret: string;

  constructor(signingSecret?: string) {
    this.signingSecret = signingSecret ?? genId();

    log.info(
      { skillCount: this.skills.size },
      'SkillRegistry (public) initialized',
    );
  }

  // -----------------------------------------------------------------------
  // publishSkill
  // -----------------------------------------------------------------------

  /**
   * Publish a skill to the registry from a raw markdown document with YAML frontmatter.
   *
   * Validates required fields, parses frontmatter, computes content SHA-256 for ETag,
   * signs the content, and stores the skill keyed by name (latest version wins for
   * default lookups; all versions are retained).
   *
   * @param raw - Full raw content including --- frontmatter delimiters and body.
   * @returns The PublishedSkill entry.
   * @throws Error on validation failure or if body exceeds 1 MB.
   */
  publishSkill(raw: string): PublishedSkill {
    if (!raw || typeof raw !== 'string') {
      throw new Error('publishSkill: raw content is required');
    }

    const bodyBytes = Buffer.byteLength(raw, 'utf8');
    if (bodyBytes > MAX_SKILL_BODY_BYTES) {
      throw new Error(`publishSkill: content exceeds ${MAX_SKILL_BODY_BYTES} byte limit (${bodyBytes} bytes)`);
    }

    const { frontmatter, body } = parseYamlFrontmatter(raw);

    // Validate required fields
    if (!frontmatter.name) {
      throw new Error('publishSkill: frontmatter "name" is required');
    }
    if (!frontmatter.version) {
      throw new Error('publishSkill: frontmatter "version" is required');
    }
    if (!frontmatter.author) {
      throw new Error('publishSkill: frontmatter "author" is required');
    }

    // Check for duplicate version
    const versionKey = `${frontmatter.name}@${frontmatter.version}`;
    const existingId = this.nameVersionIndex.get(versionKey);
    if (existingId) {
      // Update existing entry at this version
      const existing = this.skills.get(existingId)!;
      const sha256 = contentHash(raw);
      const signature = _hmacSign(sha256, this.signingSecret);
      const updated: PublishedSkill = {
        ...existing,
        description: frontmatter.description || existing.description,
        category: frontmatter.category || existing.category,
        tags: frontmatter.tags.length > 0 ? frontmatter.tags : existing.tags,
        requires: frontmatter.requires.length > 0 ? frontmatter.requires : existing.requires,
        provides: frontmatter.provides.length > 0 ? frontmatter.provides : existing.provides,
        license: frontmatter.license || existing.license,
        compatibility: frontmatter.compatibility || existing.compatibility,
        trust_tier: frontmatter.trust_tier || existing.trust_tier,
        contentSha256: sha256,
        signature,
        body,
        updatedAt: new Date().toISOString(),
      };
      this.skills.set(existingId, updated);
      this.etagCache.set(existingId, `"sha256:${sha256}"`);
      log.info({ name: frontmatter.name, version: frontmatter.version, id: existingId }, 'Skill republished (updated)');
      return updated;
    }

    const id = genId();
    const sha256 = contentHash(raw);
    const signature = _hmacSign(sha256, this.signingSecret);

    const skill: PublishedSkill = {
      id,
      name: frontmatter.name,
      version: frontmatter.version,
      description: frontmatter.description,
      author: frontmatter.author,
      category: frontmatter.category,
      tags: frontmatter.tags,
      requires: frontmatter.requires,
      provides: frontmatter.provides,
      license: frontmatter.license ?? '',
      compatibility: frontmatter.compatibility ?? [],
      trust_tier: frontmatter.trust_tier ?? 'unreviewed',
      signature,
      contentSha256: sha256,
      body,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.skills.set(id, skill);
    this.etagCache.set(id, `"sha256:${sha256}"`);

    // Track versions
    if (!this.versions.has(skill.name)) {
      this.versions.set(skill.name, new Set());
    }
    this.versions.get(skill.name)!.add(skill.version);
    this.nameVersionIndex.set(versionKey, id);

    log.info({ name: skill.name, version: skill.version, id }, 'Skill published');
    return skill;
  }

  // -----------------------------------------------------------------------
  // getSkill
  // -----------------------------------------------------------------------

  /**
   * Get a skill by name, optionally at a specific version.
   * If no version given, returns the latest version (highest createdAt).
   *
   * @param name - Skill name (from frontmatter).
   * @param version - Optional semver version string.
   * @returns The PublishedSkill or null if not found.
   */
  getSkill(name: string, version?: string): PublishedSkill | null {
    if (version) {
      const versionKey = `${name}@${version}`;
      const id = this.nameVersionIndex.get(versionKey);
      return id ? (this.skills.get(id) ?? null) : null;
    }

    // Return latest version (highest semver)
    let latest: PublishedSkill | null = null;
    for (const skill of this.skills.values()) {
      if (skill.name === name) {
        if (!latest || compareSemver(skill.version, latest.version) > 0) {
          latest = skill;
        }
      }
    }
    return latest;
  }

  /**
   * Get a skill by its internal id.
   */
  getSkillById(id: string): PublishedSkill | null {
    return this.skills.get(id) ?? null;
  }

  // -----------------------------------------------------------------------
  // listSkills
  // -----------------------------------------------------------------------

  /**
   * List and search published skills with filtering, sorting, and pagination.
   *
   * @param params - Search parameters (query, author, category, tags, trust_tier, sortBy, limit, offset).
   * @returns Paginated result with data, total, limit, offset.
   */
  listSkills(params: SkillSearchParams = {}): SkillListResult {
    let results = Array.from(this.skills.values());

    // Text search (name, description, tags, author)
    if (params.query) {
      const q = params.query.toLowerCase();
      results = results.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.author.toLowerCase().includes(q) ||
        s.tags.some(t => t.toLowerCase().includes(q)),
      );
    }

    // Author filter
    if (params.author) {
      const author = params.author.toLowerCase();
      results = results.filter(s => s.author.toLowerCase() === author);
    }

    // Category filter
    if (params.category) {
      results = results.filter(s => s.category === params.category);
    }

    // Tag filter
    if (params.tags && params.tags.length > 0) {
      results = results.filter(s =>
        params.tags!.some(t => s.tags.includes(t)),
      );
    }

    // Trust tier filter
    if (params.trust_tier) {
      results = results.filter(s => s.trust_tier === params.trust_tier);
    }

    // Sort
    switch (params.sortBy) {
      case 'recent':
        results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        break;
      case 'author':
        results.sort((a, b) => a.author.localeCompare(b.author));
        break;
      case 'category':
        results.sort((a, b) => a.category.localeCompare(b.category));
        break;
      case 'name':
      default:
        results.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }

    const total = results.length;
    const offset = Math.max(0, params.offset ?? 0);
    const limit = Math.min(params.limit ?? 50, MAX_PAGINATION_LIMIT);
    const page = results.slice(offset, offset + limit);

    return { data: page, total, limit, offset };
  }

  // -----------------------------------------------------------------------
  // resolveSkill — sudo: URI scheme
  // -----------------------------------------------------------------------

  /**
   * Resolve a sudo: URI to a published skill.
   *
   * URI format: sudo:author/skill-name[@version]
   * Examples:
   *   sudo:acme/web-summary       → latest version of acme/web-summary
   *   sudo:acme/web-summary@2.0.0 → specific version
   *
   * @param uri - A sudo: URI string.
   * @returns ResolvedSkill with the skill, original URI, and resolution timestamp.
   * @throws Error on malformed URI or if skill not found.
   */
  resolveSkill(uri: string): ResolvedSkill {
    const match = SUDO_URI_RE.exec(uri);
    if (!match) {
      throw new Error(
        `resolveSkill: invalid sudo: URI format — expected "sudo:author/name[@version]", got "${uri}"`,
      );
    }

    const [, author, name, version] = match;

    // Find skill by author + name (+ optional version)
    let skill: PublishedSkill | null = null;

    if (version) {
      // Specific version lookup
      const versionKey = `${name}@${version}`;
      const id = this.nameVersionIndex.get(versionKey);
      if (id) {
        const candidate = this.skills.get(id)!;
        if (candidate.author.toLowerCase() === (author ?? '').toLowerCase()) {
          skill = candidate;
        }
      }
    } else {
      // Latest version by author (highest semver)
      let latest: PublishedSkill | null = null;
      for (const s of this.skills.values()) {
        if (s.name === name && s.author.toLowerCase() === (author ?? '').toLowerCase()) {
          if (!latest || compareSemver(s.version, latest.version) > 0) {
            latest = s;
          }
        }
      }
      skill = latest;
    }

    if (!skill) {
      throw new Error(
        `resolveSkill: skill not found for URI "${uri}"`,
      );
    }

    return {
      skill,
      uri,
      resolvedAt: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // verifySkillSignature
  // -----------------------------------------------------------------------

  /**
   * Verify a skill's content signature using the registry's signing secret.
   *
   * @param skill - The PublishedSkill to verify.
   * @returns true if the signature is valid, false otherwise.
   */
  verifySkillSignature(skill: PublishedSkill): boolean {
    return verifySkillSignature(skill, this.signingSecret);
  }

  // -----------------------------------------------------------------------
  // ETag
  // -----------------------------------------------------------------------

  /**
   * Get the ETag for a skill by its id.
   * ETag format: "sha256:<hex>" (quoted for HTTP header compliance).
   *
   * @param id - Internal skill id.
   * @returns The ETag string, or null if the skill is not found.
   */
  getEtag(id: string): string | null {
    return this.etagCache.get(id) ?? null;
  }

  /**
   * Check if the If-None-Match header matches the skill's ETag.
   * Returns true if the content has not been modified (304 eligible).
   */
  isNotModified(id: string, ifNoneMatch: string | undefined): boolean {
    if (!ifNoneMatch) return false;
    const etag = this.etagCache.get(id);
    return etag === ifNoneMatch;
  }

  // -----------------------------------------------------------------------
  // Rate limiting
  // -----------------------------------------------------------------------

  /**
   * Check the rate limit for a given IP address.
   * Sliding window: 100 requests per minute.
   *
   * @param remoteAddress - Client IP address.
   * @returns RateLimitResult with allowed flag and retry-after seconds.
   */
  checkRateLimit(remoteAddress: string | undefined): RateLimitResult {
    const key = contentHash(remoteAddress ?? 'unknown');
    const now = Date.now();
    const timestamps = (_rlWindows.get(key) ?? []).filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS,
    );

    if (timestamps.length >= RATE_LIMIT_MAX) {
      const oldest = timestamps[0]!;
      const retryAfterSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000);
      _rlWindows.set(key, timestamps);
      return { allowed: false, retryAfterSec };
    }

    timestamps.push(now);
    _rlWindows.set(key, timestamps);

    // Eviction guard
    if (_rlWindows.size >= RL_EVICT_AT) {
      let evicted = 0;
      for (const k of _rlWindows.keys()) {
        if (evicted >= RL_EVICT_COUNT) break;
        _rlWindows.delete(k);
        evicted++;
      }
    }

    return { allowed: true, retryAfterSec: 0 };
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  /**
   * Delete a skill by name. Removes all versions.
   *
   * @param name - Skill name.
   * @returns true if any skills were removed, false if not found.
   */
  deleteSkill(name: string): boolean {
    const versionSet = this.versions.get(name);
    if (!versionSet || versionSet.size === 0) return false;

    let removed = 0;
    for (const ver of versionSet) {
      const versionKey = `${name}@${ver}`;
      const id = this.nameVersionIndex.get(versionKey);
      if (id) {
        this.skills.delete(id);
        this.etagCache.delete(id);
        this.nameVersionIndex.delete(versionKey);
        removed++;
      }
    }
    this.versions.delete(name);

    log.info({ name, removed }, 'Skill deleted (all versions)');
    return removed > 0;
  }

  // -----------------------------------------------------------------------
  // Version queries
  // -----------------------------------------------------------------------

  /**
   * Get all versions for a skill name.
   *
   * @param name - Skill name.
   * @returns Array of PublishedSkill entries, one per version, sorted by createdAt.
   */
  getVersions(name: string): PublishedSkill[] {
    const versionSet = this.versions.get(name);
    if (!versionSet) return [];

    const results: PublishedSkill[] = [];
    for (const ver of versionSet) {
      const versionKey = `${name}@${ver}`;
      const id = this.nameVersionIndex.get(versionKey);
      if (id) {
        const skill = this.skills.get(id);
        if (skill) results.push(skill);
      }
    }

    results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return results;
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  /**
   * Get registry statistics.
   */
  getStats(): {
    totalSkills: number;
    totalVersions: number;
    byCategory: Record<string, number>;
    byTrustTier: Record<string, number>;
    byAuthor: Record<string, number>;
  } {
    const byCategory: Record<string, number> = {};
    const byTrustTier: Record<string, number> = {};
    const byAuthor: Record<string, number> = {};
    let totalVersions = 0;

    for (const skill of this.skills.values()) {
      byCategory[skill.category] = (byCategory[skill.category] ?? 0) + 1;
      byTrustTier[skill.trust_tier] = (byTrustTier[skill.trust_tier] ?? 0) + 1;
      byAuthor[skill.author] = (byAuthor[skill.author] ?? 0) + 1;
      totalVersions++;
    }

    return {
      totalSkills: this.versions.size,
      totalVersions,
      byCategory,
      byTrustTier,
      byAuthor,
    };
  }
}