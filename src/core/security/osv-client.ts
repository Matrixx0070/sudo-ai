/**
 * @file security/osv-client.ts
 * @description OSV.dev API client for vulnerability scanning.
 *
 * Features:
 *  - batchQuery() for efficient multi-package lookups
 *  - In-memory cache with 1-hour TTL
 *  - Rate limiting with Retry-After header respect
 *  - Exponential backoff on failures
 *  - 10s timeout, 3 retries per request
 *  - CVSS severity mapping
 *
 * Env:
 *  - SUDO_SECURITY_OSV_URL — override API endpoint (default: https://api.osv.dev/v1/querybatch)
 *  - SUDO_SECURITY_AUDIT_DISABLE=1 — kill switch
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('osv-client');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OSVPackage {
  name: string;
  version: string;
  ecosystem: 'npm' | 'PyPI' | 'crates.io' | 'Maven' | 'NuGet' | 'Go' | 'RubyGems';
}

export interface OSVAdvisory {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'UNKNOWN';
  summary: string;
  details: string;
  fixedVersion: string | null;
  references: string[];
  packageName: string;
  affectedVersions: string[];
}

interface OSVQueryRequest {
  version: string;
  package: { name: string; ecosystem: string };
}

interface OSVQueryResponse {
  vulns?: Array<{
    id: string;
    summary?: string;
    details?: string;
    severity?: Array<{ type: string; score: string }>;
    references?: Array<{ url: string }>;
    affected?: Array<{
      package?: { name: string };
      ranges?: Array<{ events: Array<{ fixed?: string }> }>;
    }>;
  }>;
}

interface CacheEntry {
  advisories: OSVAdvisory[];
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OSV_API_URL = process.env['SUDO_SECURITY_OSV_URL'] ?? 'https://api.osv.dev/v1/querybatch';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

function mapSeverity(score: number): OSVAdvisory['severity'] {
  if (score >= 9.0) return 'CRITICAL';
  if (score >= 7.0) return 'HIGH';
  if (score >= 4.0) return 'MODERATE';
  if (score >= 0.1) return 'LOW';
  return 'UNKNOWN';
}

interface OSVVuln {
  id: string;
  summary?: string;
  details?: string;
  severity?: Array<{ type: string; score: string }>;
  references?: Array<{ url: string }>;
  affected?: Array<{
    package?: { name: string };
    ranges?: Array<{ events: Array<{ fixed?: string }> }>;
  }>;
}

function extractSeverity(vuln: OSVVuln): OSVAdvisory['severity'] {
  if (!vuln?.severity || vuln.severity.length === 0) return 'UNKNOWN';

  for (const sev of vuln.severity) {
    if (sev.type === 'CVSS_V3' || sev.type === 'CVSS_V2') {
      const score = parseFloat(sev.score);
      if (!isNaN(score)) return mapSeverity(score);
    }
  }
  return 'UNKNOWN';
}

function extractFixedVersion(vuln: OSVVuln): string | null {
  const affected = vuln.affected?.[0];
  if (!affected?.ranges) return null;

  for (const range of affected.ranges) {
    for (const event of range.events) {
      if (event.fixed) return event.fixed;
    }
  }
  return null;
}

function extractReferences(vuln: OSVVuln): string[] {
  return vuln.references?.map((r) => r.url).filter(Boolean) ?? [];
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

class AdvisoryCache {
  private cache = new Map<string, CacheEntry>();

  get(key: string): OSVAdvisory[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.advisories;
  }

  set(key: string, advisories: OSVAdvisory[]): void {
    this.cache.set(key, {
      advisories,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

const cache = new AdvisoryCache();

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

let rateLimitDelay = 0;
let lastRequestTime = 0;

async function applyRateLimit(): Promise<void> {
  const now = Date.now();
  const waitTime = Math.max(0, rateLimitDelay - (now - lastRequestTime));
  if (waitTime > 0) {
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  lastRequestTime = Date.now();
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 0;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return seconds * 1000;
  const retryDate = new Date(header);
  if (!isNaN(retryDate.getTime())) return Math.max(0, retryDate.getTime() - Date.now());
  return 0;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  packages: OSVPackage[],
  retryCount = 0,
): Promise<OSVAdvisory[]> {
  if (process.env['SUDO_SECURITY_AUDIT_DISABLE'] === '1') {
    log.warn('OSV client disabled via SUDO_SECURITY_AUDIT_DISABLE');
    return [];
  }

  await applyRateLimit();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const query: OSVQueryRequest[] = packages.map(pkg => ({
    version: pkg.version,
    package: { name: pkg.name, ecosystem: pkg.ecosystem },
  }));

  try {
    const response = await fetch(OSV_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: query }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Handle rate limiting
    const retryAfter = response.headers.get('Retry-After');
    if (response.status === 429 || response.status === 503) {
      rateLimitDelay = parseRetryAfter(retryAfter) || BASE_BACKOFF_MS * Math.pow(2, retryCount);
      if (retryCount < MAX_RETRIES) {
        log.warn({ retryAfter, retryCount }, 'Rate limited, backing off');
        await new Promise(resolve => setTimeout(resolve, rateLimitDelay));
        return fetchWithRetry(packages, retryCount + 1);
      }
      throw new Error(`OSV API rate limited after ${MAX_RETRIES} retries`);
    }

    if (!response.ok) {
      throw new Error(`OSV API error: ${response.status} ${response.statusText}`);
    }

    const data: { results?: OSVQueryResponse[] } = await response.json();
    const advisories: OSVAdvisory[] = [];

    if (data.results) {
      for (let i = 0; i < data.results.length; i++) {
        const result = data.results[i];
        const pkg = packages[i];
        if (!pkg || !result?.vulns) continue;

        for (const vuln of result.vulns) {
          advisories.push({
            id: vuln.id,
            severity: extractSeverity(vuln as OSVVuln),
            summary: vuln.summary ?? 'No summary available',
            details: vuln.details ?? 'No details available',
            fixedVersion: extractFixedVersion(vuln as OSVVuln),
            references: extractReferences(vuln as OSVVuln),
            packageName: pkg.name,
            affectedVersions: [],
          });
        }
      }
    }

    return advisories;
  } catch (err) {
    clearTimeout(timeoutId);

    const isRetryable = err instanceof Error && (
      err.message.includes('timeout') ||
      err.message.includes('ETIMEDOUT') ||
      err.message.includes('ECONNRESET')
    );

    if (isRetryable && retryCount < MAX_RETRIES) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, retryCount);
      log.warn({ err: String(err), retryCount, backoff }, 'Retrying OSV request');
      await new Promise(resolve => setTimeout(resolve, backoff));
      return fetchWithRetry(packages, retryCount + 1);
    }

    log.error({ err: String(err) }, 'OSV query failed');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Query OSV.dev for vulnerabilities affecting the given packages.
 * Results are cached for 1 hour.
 */
export async function batchQuery(packages: OSVPackage[]): Promise<OSVAdvisory[]> {
  if (packages.length === 0) return [];
  if (process.env['SUDO_SECURITY_AUDIT_DISABLE'] === '1') return [];

  // Create cache key from package identifiers
  const cacheKey = packages
    .map(p => `${p.ecosystem}:${p.name}@${p.version}`)
    .sort()
    .join('|');

  const cached = cache.get(cacheKey);
  if (cached) {
    log.debug({ count: cached.length }, 'OSV cache hit');
    return cached;
  }

  log.info({ packageCount: packages.length }, 'Querying OSV.dev');
  const advisories = await fetchWithRetry(packages);
  cache.set(cacheKey, advisories);

  log.info({ found: advisories.length }, 'OSV query complete');
  return advisories;
}

/**
 * Clear the advisory cache (useful for testing or forced refresh).
 */
export function clearCache(): void {
  cache.clear();
  rateLimitDelay = 0;
  lastRequestTime = 0;
}
