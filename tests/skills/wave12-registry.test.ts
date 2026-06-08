/**
 * @file tests/skills/wave12-registry.test.ts
 * @description Wave 12 — public skill registry route tests (8 required).
 *
 * Tests:
 *   T1 yaml-frontmatter-parse   — Parse all 5 bundled SKILL.md files; assert id, trust_tier, caps
 *   T2 registry-list-200        — GET /v1/registry/skills returns 200, array with bundled entries
 *   T3 registry-detail-200      — GET /v1/registry/skills/research.web-summary returns 200 + correct fields
 *   T4 registry-raw-200         — GET /v1/registry/skills/research.web-summary/raw returns 200 + ETag
 *   T5 registry-trust-tier-filter — Non-bundled skill returns 404 (not 403)
 *   T6 registry-404-on-missing  — Unknown id returns 404 for both detail + raw endpoints
 *   T7 no-auth-bypass           — GET /v1/registry/skills without Authorization returns 200
 *   T8 rate-limit-raw           — 21st raw request returns 429 with Retry-After header
 *
 * NOTE: T2–T8 use an in-memory SQLite registry seeded via registerFromImport,
 * so they work whether or not B1's SKILL.md migration is complete.
 * T1 reads real SKILL.md files on-disk (depends on B1 finishing).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SkillRegistry } from '../../src/core/skills/registry.js';
import { parseFrontmatter } from '../../src/core/skills/registry-types.js';
import { findBundledByFrontmatterId, emitFrontmatterYaml } from '../../src/core/skills/registry-route-types.js';
import type { SkillManifest } from '../../src/core/shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmpDir(): string {
  const dir = join(tmpdir(), `wave12-registry-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeHash(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 32);
}

/**
 * Build a bundled SkillManifest fixture with canonical frontmatter SKILL.md content.
 * The RAW_CONTENT includes both frontmatter and body so getSkillById returns valid body_md.
 * Wave 10 P1: includes display_name, license, compatibility in raw frontmatter so
 * registerFromImport can persist them through to toPublicEntry().
 */
function makeBundledManifest(
  id: string,
  name: string,
  caps: string[],
  tags: string[],
  description: string,
  overrides: Partial<SkillManifest> = {},
  displayName?: string,
): { manifest: SkillManifest; raw: string } {
  const contentHash = makeHash();
  const capsYaml = `[${caps.join(', ')}]`;
  const tagsYaml = `[${tags.join(', ')}]`;
  // Wave 10 P1: display_name uses the slug-derived human label when provided
  const humanLabel = displayName ?? name;
  const raw = `---
id: ${id}
name: ${name}
display_name: "${humanLabel}"
version: 1.0.0
description: ${description}
author: sudo-ai
trust_tier: bundled
license: MIT
compatibility: [node-22]
caps: ${capsYaml}
tags: ${tagsYaml}
source: bundled:sudo-ai
metadata:
  trust_tier: bundled
---

## Description

${description}
`;
  const manifest: SkillManifest = {
    id: randomUUID(),
    name,
    version: '1.0.0',
    description,
    author: 'sudo-ai',
    source: `bundled:sudo-ai`,
    scheme: 'bundled',
    caps,
    tools: [],
    trust: 'bundled',
    contentHash,
    importedAt: new Date().toISOString(),
    ...overrides,
  };
  return { manifest, raw };
}

/** HTTP GET helper — returns status, body text, and headers. */
async function httpGetRaw(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; bodyText: string; headers: http.IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers,
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, bodyText, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Parse JSON body or return null. */
function parseJson(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Canonical bundled skill definitions (from spec §C1)
// ---------------------------------------------------------------------------

const BUNDLED_SKILLS = [
  {
    id: 'research.web-summary',
    name: 'web-summary',
    displayName: 'Web Summary',
    caps: ['net.fetch'],
    tags: ['research', 'web', 'no-llm'],
    description: 'Search the web via DuckDuckGo and return structured summary with key facts and source URLs.',
  },
  {
    id: 'automation.cron-health',
    name: 'cron-health',
    displayName: 'Cron Health',
    caps: ['fs.read', 'db.read'],
    tags: ['automation', 'monitoring', 'local'],
    description: 'Check all registered cron jobs and report healthy vs failing/overdue status.',
  },
  {
    id: 'system.self-diagnostic',
    name: 'self-diagnostic',
    displayName: 'Self Diagnostic',
    caps: ['fs.read', 'db.read'],
    tags: ['system', 'health', 'local'],
    description: 'Run comprehensive SUDO-AI platform health diagnostic across six local subsystems.',
  },
  {
    id: 'intelligence.daily-brief',
    name: 'daily-brief',
    displayName: 'Daily Brief',
    caps: ['net.fetch', 'db.read'],
    tags: ['intelligence', 'briefing', 'daily'],
    description: 'Generate structured daily briefing from Hacker News, GitHub Trending, and mind.db.',
  },
  {
    id: 'content.viral-hook',
    name: 'viral-hook',
    displayName: 'Viral Hook',
    caps: [],
    tags: ['content', 'youtube', 'no-llm', 'no-network'],
    description: 'Generate viral YouTube Shorts hook lines in curiosity/shock/challenge styles.',
  },
] as const;

/** Absolute paths to the 5 bundled SKILL.md files (B1 output). */
const SKILL_MD_PATHS: Record<string, string> = {
  'research.web-summary': `${process.cwd()}/src/core/skills/research/web-summary/SKILL.md`,
  'automation.cron-health': `${process.cwd()}/src/core/skills/automation/cron-health/SKILL.md`,
  'system.self-diagnostic': `${process.cwd()}/src/core/skills/system/self-diagnostic/SKILL.md`,
  'intelligence.daily-brief': `${process.cwd()}/src/core/skills/intelligence/daily-brief/SKILL.md`,
  'content.viral-hook': `${process.cwd()}/src/core/skills/content/viral-hook/SKILL.md`,
};

// ---------------------------------------------------------------------------
// Shared test infrastructure for T2–T8
// ---------------------------------------------------------------------------

/** Seed registry with the 5 canonical bundled skills + return their SHA map. */
function seedBundledSkills(registry: SkillRegistry): Record<string, string> {
  const shaMap: Record<string, string> = {};
  for (const skill of BUNDLED_SKILLS) {
    const { manifest, raw } = makeBundledManifest(
      skill.id,
      skill.name,
      [...skill.caps],
      [...skill.tags],
      skill.description,
      {},
      skill.displayName,
    );
    registry.registerFromImport(manifest, raw);
    shaMap[skill.id] = manifest.contentHash;
  }
  return shaMap;
}

// ---------------------------------------------------------------------------
// T1 — YAML frontmatter parse (real SKILL.md files from B1)
// ---------------------------------------------------------------------------

describe('T1: yaml-frontmatter-parse', () => {
  it('parses all 5 bundled SKILL.md files: id, trust_tier=bundled, caps non-empty array where expected', () => {
    for (const [skillId, filePath] of Object.entries(SKILL_MD_PATHS)) {
      const raw = readFileSync(filePath, 'utf8');
      const { meta } = parseFrontmatter(raw);

      // id must match the canonical id
      expect(meta['id'], `${skillId}: meta.id`).toBe(skillId);

      // trust_tier must be 'bundled'
      expect(meta['trust_tier'], `${skillId}: meta.trust_tier`).toBe('bundled');

      // caps must be an array (possibly empty for content.viral-hook)
      expect(Array.isArray(meta['caps']), `${skillId}: meta.caps is array`).toBe(true);

      // All skills except content.viral-hook should have at least one cap
      if (skillId !== 'content.viral-hook') {
        expect(
          (meta['caps'] as string[]).length,
          `${skillId}: caps non-empty`,
        ).toBeGreaterThan(0);
      }

      // author must be present
      expect(meta['author'], `${skillId}: meta.author`).toBe('sudo-ai');
    }
  });
});

// ---------------------------------------------------------------------------
// T2–T8 — HTTP route tests (in-memory registry + mock server)
// ---------------------------------------------------------------------------

describe('T2–T8: registry HTTP routes', () => {
  let db: InstanceType<typeof Database>;
  let registry: SkillRegistry;
  let skillsDir: string;
  let server: http.Server;
  let baseUrl: string;
  let shaMap: Record<string, string>;
  let resetRateLimits: (() => void) | null = null;
  let webSummaryName: string;

  beforeEach(async () => {
    // Fresh in-memory DB + temp skills dir for each test
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    skillsDir = mkTmpDir();
    registry = new SkillRegistry(db, skillsDir);

    // Seed the 5 bundled skills
    shaMap = seedBundledSkills(registry);

    // Wave 10 P1: web-summary name is now the canonical slug 'web-summary'
    webSummaryName = 'web-summary';

    // Dynamically import B2's routes (may not exist until B2 finishes — tsc will flag missing module)
    const routesModule = await import('../../src/core/skills/registry-routes.js') as {
      registerRegistryRoutes: (server: http.Server, registry: SkillRegistry) => void;
      _resetRegistryRateLimits: () => void;
    };

    resetRateLimits = routesModule._resetRegistryRateLimits;
    resetRateLimits();

    // Spin up fresh server for each test
    server = http.createServer();
    routesModule.registerRegistryRoutes(server, registry);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server?.listening) await stopServer(server);
    try { db.close(); } catch { /* already closed */ }
    rmSync(skillsDir, { recursive: true, force: true });
    resetRateLimits = null;
  });

  // -------------------------------------------------------------------------
  // T2: registry-list-200
  // -------------------------------------------------------------------------

  it('T2: GET /v1/registry/skills returns 200, data array with at least 5 bundled entries', async () => {
    const { status, bodyText } = await httpGetRaw(baseUrl, '/v1/registry/skills');
    expect(status).toBe(200);

    const body = parseJson(bodyText) as Record<string, unknown>;
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('total');
    expect(Array.isArray(body['data'])).toBe(true);

    const data = body['data'] as Array<Record<string, unknown>>;
    expect(data.length).toBeGreaterThanOrEqual(5);

    // All entries must have trust_tier === 'bundled'
    for (const entry of data) {
      expect(entry['trust_tier']).toBe('bundled');
    }
  });

  // -------------------------------------------------------------------------
  // T3: registry-detail-200
  // -------------------------------------------------------------------------

  it('T3: GET /v1/registry/skills/research.web-summary returns 200 with correct id, name, sha256', async () => {
    const { status, bodyText } = await httpGetRaw(baseUrl, '/v1/registry/skills/research.web-summary');
    expect(status).toBe(200);

    const body = parseJson(bodyText) as Record<string, unknown>;

    // id from frontmatter
    expect(body['id']).toBe('research.web-summary');
    // Wave 10 P1: name is now canonical slug, not display string
    expect(body['name']).toBe('web-summary');
    // sha256 must be present and a non-empty string
    expect(typeof body['sha256']).toBe('string');
    expect((body['sha256'] as string).length).toBeGreaterThan(0);
    // trust_tier must be bundled
    expect(body['trust_tier']).toBe('bundled');
    // Wave 10 P1: new fields
    expect(body['metadata'] as Record<string, unknown>).toBeDefined();
    expect((body['metadata'] as Record<string, unknown>)['display_name']).toBe('Web Summary');
    expect(body['license']).toBe('MIT');
    expect(Array.isArray(body['compatibility'])).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T4: registry-raw-200 (with ETag + 304 conditional GET)
  // -------------------------------------------------------------------------

  it('T4: GET /v1/registry/skills/research.web-summary/raw returns 200 + ETag; conditional GET returns 304', async () => {
    // First request
    const { status, bodyText, headers } = await httpGetRaw(
      baseUrl,
      '/v1/registry/skills/research.web-summary/raw',
    );
    expect(status).toBe(200);

    // Content-Type: text/plain or text/markdown
    const ct = headers['content-type'] ?? '';
    expect(ct).toMatch(/text\/(plain|markdown)/);

    // Body starts with --- (frontmatter)
    expect(bodyText.trimStart()).toMatch(/^---/);

    // Body contains trust_tier: bundled
    expect(bodyText).toContain('trust_tier: bundled');

    // ETag header must be present and in sha256:... format (RFC 7232 quoted)
    const etag = headers['etag'] as string;
    expect(etag).toBeDefined();
    expect(etag).toMatch(/^"sha256:[0-9a-f]+"$/);

    // Conditional GET with matching If-None-Match must return 304
    const { status: status304 } = await httpGetRaw(
      baseUrl,
      '/v1/registry/skills/research.web-summary/raw',
      { 'If-None-Match': etag },
    );
    expect(status304).toBe(304);
  });

  // -------------------------------------------------------------------------
  // T5: registry-trust-tier-filter
  // -------------------------------------------------------------------------

  it('T5: Non-bundled skill (workspace tier) returns 404 on detail endpoint — not 403', async () => {
    // Insert a workspace-tier skill into the same registry
    const { manifest, raw } = makeBundledManifest(
      'workspace.private-tool',
      'Private Tool',
      ['fs.write'],
      ['internal'],
      'An internal workspace skill that should not be public.',
      { trust: 'workspace' as SkillManifest['trust'] },
    );
    registry.registerFromImport(manifest, raw);

    // GET /v1/registry/skills/workspace.private-tool should return 404 (not 403)
    const { status } = await httpGetRaw(baseUrl, '/v1/registry/skills/workspace.private-tool');
    expect(status).toBe(404);

    // Also verify /raw returns 404
    const { status: statusRaw } = await httpGetRaw(
      baseUrl,
      '/v1/registry/skills/workspace.private-tool/raw',
    );
    expect(statusRaw).toBe(404);
  });

  // -------------------------------------------------------------------------
  // T6: registry-404-on-missing
  // -------------------------------------------------------------------------

  it('T6: Unknown id returns 404 on both detail and raw endpoints', async () => {
    const unknownId = `does-not-exist-${randomUUID()}`;

    const { status: detailStatus } = await httpGetRaw(baseUrl, `/v1/registry/skills/${unknownId}`);
    expect(detailStatus).toBe(404);

    const { status: rawStatus } = await httpGetRaw(
      baseUrl,
      `/v1/registry/skills/${unknownId}/raw`,
    );
    expect(rawStatus).toBe(404);
  });

  // -------------------------------------------------------------------------
  // T7: no-auth-bypass
  // -------------------------------------------------------------------------

  it('T7: GET /v1/registry/skills without Authorization header returns 200 (public endpoint)', async () => {
    // Explicitly send NO Authorization header
    const { status } = await httpGetRaw(baseUrl, '/v1/registry/skills', {});
    expect(status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // T8: rate-limit-raw
  // -------------------------------------------------------------------------

  it('T8: 20 sequential /raw requests succeed; 21st returns 429 with Retry-After header', async () => {
    // resetRateLimits() already called in beforeEach

    const rawPath = '/v1/registry/skills/research.web-summary/raw';

    // First 20 must succeed
    for (let i = 1; i <= 20; i++) {
      const { status } = await httpGetRaw(baseUrl, rawPath);
      expect(status, `request ${i} of 20 should be 200`).toBe(200);
    }

    // 21st must be rate-limited
    const { status: status21, headers } = await httpGetRaw(baseUrl, rawPath);
    expect(status21).toBe(429);

    const retryAfter = headers['retry-after'];
    expect(retryAfter, 'Retry-After header must be present on 429').toBeDefined();
    const retryAfterValue = parseInt(retryAfter as string, 10);
    expect(Number.isFinite(retryAfterValue)).toBe(true);
    expect(retryAfterValue).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // T9: raw body contains spec-canonical metadata block with trust_tier
  // -------------------------------------------------------------------------

  it('T9: GET /v1/registry/skills/:id/raw body contains metadata: block with trust_tier: bundled', async () => {
    const { status, bodyText } = await httpGetRaw(
      baseUrl,
      '/v1/registry/skills/research.web-summary/raw',
    );
    expect(status).toBe(200);

    // The raw YAML frontmatter must include a metadata: block
    expect(bodyText).toContain('metadata:');
    // The metadata block must carry the spec-canonical trust_tier signal
    expect(bodyText).toContain('  trust_tier: bundled');
    // Wave 10 P1: metadata block must also include display_name
    expect(bodyText).toContain('display_name: Web Summary');
  });

  // -------------------------------------------------------------------------
  // T10: JSON detail response exposes metadata.trust_tier
  // -------------------------------------------------------------------------

  it('T10: GET /v1/registry/skills/:id JSON has metadata.trust_tier === "bundled"', async () => {
    const { status, bodyText } = await httpGetRaw(
      baseUrl,
      '/v1/registry/skills/research.web-summary',
    );
    expect(status).toBe(200);

    const body = parseJson(bodyText) as Record<string, unknown>;
    expect(body).toHaveProperty('metadata');

    const metadata = body['metadata'] as Record<string, unknown>;
    expect(metadata['trust_tier']).toBe('bundled');
  });

  // -------------------------------------------------------------------------
  // T13: Wave 10 P1 — SKILL.md frontmatter includes license, compatibility, display_name
  // -------------------------------------------------------------------------

  it('T13: bundled skill response includes Wave 10 P1 fields (license, compatibility, metadata.display_name)', async () => {
    const { status, bodyText } = await httpGetRaw(baseUrl, '/v1/registry/skills/research.web-summary');
    expect(status).toBe(200);
    const body = parseJson(bodyText) as Record<string, unknown>;
    expect(body['license']).toBe('MIT');
    expect(body['compatibility']).toEqual(['node-22']);
    expect((body['metadata'] as Record<string, unknown>)['display_name']).toBe('Web Summary');
    // name must be canonical slug
    expect(body['name']).toBe('web-summary');
  });
});

// ---------------------------------------------------------------------------
// Wave 12.2 — registerFromImport persists frontmatter `id` in frontmatter_json
// ---------------------------------------------------------------------------

describe('Wave 12.2: registerFromImport persists frontmatter id', () => {
  let db: InstanceType<typeof Database>;
  let registry: SkillRegistry;
  let skillsDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    skillsDir = mkTmpDir();
    registry = new SkillRegistry(db, skillsDir);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    rmSync(skillsDir, { recursive: true, force: true });
  });

  it('T11: registerFromImport stores id in frontmatter_json so findBundledByFrontmatterId hits fast-path', async () => {
    const { manifest, raw } = makeBundledManifest(
      'test.imported-skill',
      'Imported Skill',
      ['net.fetch'],
      ['test'],
      'A test skill for Wave 12.2 import-id persistence.',
    );

    registry.registerFromImport(manifest, raw);

    // Primary: findBundledByFrontmatterId must find the skill by its frontmatter id
    const meta = findBundledByFrontmatterId(registry, 'test.imported-skill');
    expect(meta, 'findBundledByFrontmatterId should return non-null').not.toBeNull();
    expect(meta!.frontmatter['id']).toBe('test.imported-skill');

    // Discriminating assertion: frontmatter_json itself (via rowToMeta) must contain id,
    // proving the fast-path (not the body_md fallback) is what populated the result.
    const full = registry.getSkillById(meta!.id);
    expect(full, 'getSkillById should return non-null').not.toBeNull();
    expect(
      full!.frontmatter['id'],
      'frontmatter_json must persist the id field so fast-path lookup works',
    ).toBe('test.imported-skill');
  });

  it('T12: registerFromImport falls back to manifest.name when raw has no id field', async () => {
    // Raw with no id in frontmatter (legacy skill)
    const rawNoId = `---
name: Legacy Skill
version: 1.0.0
description: A legacy skill without a frontmatter id.
author: sudo-ai
trust_tier: bundled
caps: []
tags: []
source: bundled:sudo-ai
---

Legacy skill body.
`;
    const manifest: SkillManifest = {
      id: randomUUID(),
      name: 'legacy-skill',
      version: '1.0.0',
      description: 'A legacy skill without a frontmatter id.',
      author: 'sudo-ai',
      source: 'bundled:sudo-ai',
      scheme: 'bundled',
      caps: [],
      tools: [],
      trust: 'bundled',
      contentHash: makeHash(),
      importedAt: new Date().toISOString(),
    };

    registry.registerFromImport(manifest, rawNoId);

    // The skill should be persisted; frontmatter id falls back to manifest.name
    const all = registry.list(50, 0);
    const found = all.find((m) => m.name === 'legacy-skill');
    expect(found, 'legacy skill should be registered').not.toBeUndefined();
    // Fallback: frontmatter id is manifest.name
    expect(found!.frontmatter['id']).toBe('legacy-skill');
  });
});

// ---------------------------------------------------------------------------
// Wave 10 P1 Fix 4 — YAML newline injection prevention in emitFrontmatterYaml
// ---------------------------------------------------------------------------

describe('Fix 4: emitFrontmatterYaml sanitizes newline injection in scalar values', () => {
  it('T-FIX4-1: newline in license field is replaced with space (not injected into YAML)', () => {
    const fm: Record<string, unknown> = {
      id: 'test.injected',
      name: 'injected-skill',
      version: '1.0.0',
      description: 'Clean description',
      author: 'sudo-ai',
      trust_tier: 'bundled',
      license: "MIT\ndelete from skills; --",
      caps: [],
      tags: [],
      source: 'bundled:sudo-ai',
    };

    const yaml = emitFrontmatterYaml(fm);

    // The emitted YAML must not contain a raw newline inside the license scalar
    // Split on \n and look for the license line — it must be a single line entry
    const lines = yaml.split('\n');
    const licenseLines = lines.filter((l) => l.startsWith('license:'));
    expect(licenseLines.length).toBe(1);
    // The injected newline must have been replaced with a space
    expect(licenseLines[0]).toContain('MIT');
    expect(licenseLines[0]).not.toContain('\n');
    // The attack payload newline content must not appear as its own line
    expect(lines).not.toContain('delete from skills; --');
  });

  it('T-FIX4-2: newline in display_name (metadata block) is replaced with space', () => {
    const fm: Record<string, unknown> = {
      id: 'test.injected',
      name: 'injected-skill',
      version: '1.0.0',
      description: 'Clean',
      author: 'sudo-ai',
      trust_tier: 'bundled',
      display_name: "Web Summary\nmalicious: true",
      license: 'MIT',
      caps: [],
      tags: [],
      source: 'bundled:sudo-ai',
    };

    const yaml = emitFrontmatterYaml(fm);

    // display_name inside metadata block must be a single unbroken line
    const lines = yaml.split('\n');
    const displayLine = lines.find((l) => l.trimStart().startsWith('display_name:'));
    expect(displayLine).toBeDefined();
    expect(displayLine).not.toContain('\n');
    // The injected payload must not appear as a separate YAML key
    const maliciousLine = lines.find((l) => l.trimStart().startsWith('malicious:'));
    expect(maliciousLine).toBeUndefined();
  });

  it('T-FIX4-3: registerFromImport with newline in license produces clean /raw frontmatter', async () => {
    const db = new Database(':memory:');
    const tmpDir = join(tmpdir(), 'fix4-test-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    const registry = new SkillRegistry(db, tmpDir);

    const rawWithNewline = `---
id: test.newline-skill
name: newline-skill
display_name: "Clean Name"
version: 1.0.0
description: Test skill.
author: sudo-ai
trust_tier: bundled
license: "MIT\\ninjection-attempt"
compatibility: [node-22]
caps: []
tags: [test]
source: bundled:sudo-ai
metadata:
  trust_tier: bundled
---

Body text.
`;

    const manifest: SkillManifest = {
      id: randomUUID(),
      name: 'newline-skill',
      version: '1.0.0',
      description: 'Test skill.',
      author: 'sudo-ai',
      source: 'bundled:sudo-ai',
      scheme: 'bundled',
      caps: [],
      tools: [],
      trust: 'bundled',
      contentHash: makeHash(),
      importedAt: new Date().toISOString(),
    };

    registry.registerFromImport(manifest, rawWithNewline);

    // Retrieve the stored skill and emit its frontmatter
    const meta = registry.list(10, 0)[0];
    expect(meta).toBeDefined();
    const yaml = emitFrontmatterYaml(meta!.frontmatter);

    // The YAML must not contain raw newlines inside scalar values
    const lines = yaml.split('\n');
    const licenseLines = lines.filter((l) => l.startsWith('license:'));
    expect(licenseLines.length).toBeLessThanOrEqual(1); // at most one license line

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
    try { db.close(); } catch { /* ignore */ }
  });
});
