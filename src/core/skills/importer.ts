/**
 * @file importer.ts
 * @description SkillImporter — fetch and parse skills from remote registries.
 *
 * SSRF safety: Only 3 URI schemes are accepted:
 *   github:owner/repo/path/to/skill.md  → raw.githubusercontent.com (allowlisted)
 *   openclaw:registry-id/skill-id       → openclaw.ai registry (allowlisted)
 *   openjarvis:registry-id/skill-id     → openjarvis.io registry (allowlisted)
 *
 * Raw URLs are rejected. Hostnames are constructed from scheme constants,
 * never derived from user input. Response is capped at 256 KB. Timeout 10s.
 *
 * @see wave10-spec.md Section E (Builder 1 — importer.ts)
 */

import { createHash } from 'node:crypto';
import type {
  SkillManifest,
  SkillTrustTier,
  SkillSourceScheme,
  ToolTranslatorEntry,
} from '../shared/wave10-types.js';
import { checkCapabilities } from './trust-policy.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('skills:importer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024; // 256 KB

/** Allowlisted base URLs per scheme — never derived from user input. */
const SCHEME_BASE_URLS: Record<string, string> = {
  github: 'https://raw.githubusercontent.com',
  openclaw: 'https://registry.openclaw.ai/v1/skills',
  openjarvis: 'https://registry.openjarvis.io/v1/skills',
};

// ---------------------------------------------------------------------------
// sudo: scheme — conditionally added at module load time (spec C4)
// Requires SUDO_PUBLIC_REGISTRY_BASE env var; must be https:// with a
// non-RFC-1918, non-loopback hostname. If unset or invalid: silently absent.
// ---------------------------------------------------------------------------
((): void => {
  const base = process.env['SUDO_PUBLIC_REGISTRY_BASE'];
  if (!base || base.trim() === '') return;

  // Must use HTTPS transport
  if (!base.startsWith('https://')) {
    log.warn({ base }, 'sudo: scheme rejected — SUDO_PUBLIC_REGISTRY_BASE must use https://');
    return;
  }

  // Must parse as valid URL
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    log.warn({ base }, 'sudo: scheme rejected — SUDO_PUBLIC_REGISTRY_BASE is not a valid URL');
    return;
  }

  // Hostname validation — reject loopback and RFC-1918 / link-local addresses
  const hostname = parsed.hostname.toLowerCase();

  // Strip IPv6 brackets if present (URL.hostname strips them, but guard anyway)
  const isPrivate = (host: string): boolean => {
    // Loopback IPv6
    if (host === '::1' || host === 'localhost') return true;

    // IPv4-mapped IPv6: ::ffff:<ipv4> — strip prefix and re-check embedded IPv4
    if (/^::ffff:/i.test(host)) {
      return isPrivate(host.replace(/^::ffff:/i, ''));
    }

    // ULA range: fc00::/7 (fc00:: – fdff::)
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;

    // Link-local IPv6: fe80::/10 (fe80:: – febf::)
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;

    // IPv4 check: parse octets
    const parts = host.split('.');
    if (parts.length === 4) {
      const [a, b] = parts.map(Number);
      // 127.x.x.x — loopback
      if (a === 127) return true;
      // 10.x.x.x — Class A private
      if (a === 10) return true;
      // 172.16–31.x.x — Class B private
      if (a === 172 && b >= 16 && b <= 31) return true;
      // 192.168.x.x — Class C private
      if (a === 192 && b === 168) return true;
      // 169.254.x.x — link-local
      if (a === 169 && b === 254) return true;
    }

    // Belt-and-suspenders: reject bare numeric IP literals (IPv4 or IPv6).
    // The env var should point to a hostname like registry.sudoai.com, not a raw IP.
    if (/^[\d.]+$/.test(host) || /^[0-9a-f:]+$/i.test(host)) return true;

    return false;
  };

  if (isPrivate(hostname)) {
    log.warn(
      { hostname },
      'sudo: scheme rejected — SUDO_PUBLIC_REGISTRY_BASE hostname is loopback or RFC-1918',
    );
    return;
  }

  // All checks passed — register the sudo: scheme
  SCHEME_BASE_URLS['sudo'] = `${base}/v1/registry/skills`;
})();

// ---------------------------------------------------------------------------
// URI parsing
// ---------------------------------------------------------------------------

export interface ParsedSkillUri {
  scheme: SkillSourceScheme;
  path: string; // everything after "scheme:"
}

/**
 * Parse a skill URI into its scheme and path components.
 * Rejects raw URLs, relative paths, and unknown schemes.
 *
 * @throws Error if URI is invalid or scheme is not supported.
 */
export function parseSkillUri(uri: string): ParsedSkillUri {
  if (!uri || typeof uri !== 'string') {
    throw new Error('Skill URI must be a non-empty string');
  }
  // Reject raw HTTP/HTTPS URLs — must use scheme aliases
  if (/^https?:\/\//i.test(uri)) {
    throw new Error('Raw HTTP/HTTPS URLs are not accepted. Use github:/openclaw:/openjarvis: schemes.');
  }
  const colonIdx = uri.indexOf(':');
  if (colonIdx < 1) {
    throw new Error(`Invalid skill URI — no scheme separator found: ${uri}`);
  }
  const scheme = uri.slice(0, colonIdx).toLowerCase();
  const path = uri.slice(colonIdx + 1);

  if (!SCHEME_BASE_URLS[scheme]) {
    throw new Error(
      `Unsupported skill URI scheme: "${scheme}". Allowed: github, openclaw, openjarvis`,
    );
  }
  if (!path || path.length < 3) {
    throw new Error(`Skill URI path is too short: ${uri}`);
  }
  return { scheme: scheme as SkillSourceScheme, path };
}

/**
 * Build the safe fetch URL from a parsed URI.
 * The hostname is always from the allowlist — never from user input.
 */
function buildFetchUrl(parsed: ParsedSkillUri): string {
  const base = SCHEME_BASE_URLS[parsed.scheme];
  // base is guaranteed to be set (parseSkillUri validates scheme)
  if (!base) throw new Error(`No base URL for scheme: ${parsed.scheme}`);
  // For github: path is "owner/repo/path/to/skill.md"
  // Convert to raw GitHub URL: base + "/" + path
  return `${base}/${parsed.path}`;
}

// ---------------------------------------------------------------------------
// Frontmatter parser (minimal — duplicated from registry-types but kept
// self-contained so importer has no circular dep on registry-types)
// ---------------------------------------------------------------------------

function parseFrontmatterFields(raw: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const lines = raw.split('\n');
  if (lines[0]?.trimEnd() !== '---') return { meta: {}, body: raw };
  const endIdx = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (endIdx === -1) return { meta: {}, body: raw };

  const meta: Record<string, unknown> = {};
  for (const line of lines.slice(1, endIdx)) {
    const colonAt = line.indexOf(':');
    if (colonAt < 1) continue;
    const key = line.slice(0, colonAt).trim();
    const rawVal = line.slice(colonAt + 1).trim();
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      meta[key] = rawVal
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    } else {
      meta[key] = rawVal;
    }
  }
  const body = lines.slice(endIdx + 1).join('\n').trimStart();
  return { meta, body };
}

// ---------------------------------------------------------------------------
// Fetch helper (SSRF-safe)
// ---------------------------------------------------------------------------

/**
 * Fetch raw skill content from a safe URL with timeout and size cap.
 * @throws Error on timeout, size exceeded, or non-200 HTTP status.
 */
async function fetchSkillContent(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'sudo-ai-skill-importer/1.0' },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`Fetch failed: HTTP ${response.status} from ${url}`);
  }

  // Read body with size cap
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          throw new Error(`Skill response exceeds ${MAX_RESPONSE_BYTES} byte cap`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Manifest builder
// ---------------------------------------------------------------------------

const VALID_TRUST_TIERS = new Set<string>(['bundled', 'indexed', 'unreviewed', 'workspace']);

function buildManifest(
  raw: string,
  uri: string,
  scheme: SkillSourceScheme,
  trustOverride?: SkillTrustTier,
): SkillManifest {
  const { meta, body: _body } = parseFrontmatterFields(raw);
  const contentHash = createHash('sha256').update(raw).digest('hex');

  const id = (meta['id'] as string | undefined) ||
    (meta['name'] as string | undefined)?.toLowerCase().replace(/\s+/g, '-') ||
    contentHash.slice(0, 16);

  const name = (meta['name'] as string | undefined) || id;
  const version = (meta['version'] as string | undefined) || '0.0.0';
  const description = (meta['description'] as string | undefined) || '';
  const author = (meta['author'] as string | undefined) || 'unknown';

  // Parse caps
  let caps: string[] = [];
  const capsRaw = meta['caps'];
  if (Array.isArray(capsRaw)) {
    caps = capsRaw as string[];
  } else if (typeof capsRaw === 'string' && capsRaw.length > 0) {
    caps = capsRaw.split(',').map((c) => c.trim()).filter(Boolean);
  }

  // Parse tools
  let tools: ToolTranslatorEntry[] = [];
  const toolsRaw = meta['tools'];
  if (typeof toolsRaw === 'string' && toolsRaw.startsWith('[')) {
    try {
      tools = JSON.parse(toolsRaw) as ToolTranslatorEntry[];
    } catch {
      // malformed — keep empty
    }
  }

  // Determine trust tier
  let trust: SkillTrustTier;
  if (trustOverride && VALID_TRUST_TIERS.has(trustOverride)) {
    trust = trustOverride;
  } else {
    const tierRaw = meta['trust_tier'] as string | undefined;
    if (tierRaw && VALID_TRUST_TIERS.has(tierRaw)) {
      trust = tierRaw as SkillTrustTier;
    } else {
      // Default by scheme
      trust = scheme === 'bundled' ? 'bundled'
        : scheme === 'github' || scheme === 'openclaw' || scheme === 'openjarvis'
          ? 'unreviewed'
          : 'unreviewed';
    }
  }

  return {
    id,
    name,
    version,
    description,
    author,
    source: uri,
    scheme,
    caps,
    tools,
    trust,
    contentHash,
    importedAt: new Date().toISOString(),
    tags: Array.isArray(meta['tags']) ? (meta['tags'] as string[]) : undefined,
    minVersion: (meta['minVersion'] as string | undefined) || undefined,
  };
}

// ---------------------------------------------------------------------------
// SkillImporter class
// ---------------------------------------------------------------------------

export interface ImportResult {
  manifest: SkillManifest;
  raw: string;
}

export class SkillImporter {
  /**
   * Import a skill from a URI.
   *
   * @param uri          - Skill URI in scheme:path format.
   * @param trustOverride - Optional trust tier override; if omitted, defaults
   *                        to 'unreviewed' for all remote schemes.
   * @returns Resolved SkillManifest and raw content.
   * @throws Error on invalid URI, SSRF attempt, network failure, size cap, or
   *         capability violation.
   */
  async import(uri: string, trustOverride?: SkillTrustTier): Promise<ImportResult> {
    // Step 1: parse and validate the URI (SSRF gate)
    const parsed = parseSkillUri(uri);
    log.info({ uri, scheme: parsed.scheme }, 'importing skill');

    // Step 2: build the safe fetch URL and retrieve raw content
    const fetchUrl = buildFetchUrl(parsed);
    const raw = await fetchSkillContent(fetchUrl);

    // Step 3: build the skill manifest
    const manifest = buildManifest(raw, uri, parsed.scheme, trustOverride);

    // Step 4: capability check against tier policy
    if (manifest.caps.length > 0) {
      const result = checkCapabilities(manifest.caps, manifest.trust);
      if (!result.granted) {
        throw new Error(
          `Capability check failed for skill "${manifest.name}" at tier "${manifest.trust}". ` +
          `Missing: ${result.missing.join(', ')}`,
        );
      }
    }

    log.info({ id: manifest.id, trust: manifest.trust }, 'skill imported successfully');
    return { manifest, raw };
  }
}
