/**
 * @file tests/gateway/well-known.test.ts
 * @description Wave 10 Phase 1 — /.well-known/agentskills.json discovery endpoint tests.
 *
 * Tests:
 *   WK-1: GET /.well-known/agentskills.json → 200, JSON with all 5 required fields
 *   WK-2: spec_version === "1.0", provider === "sudo-ai"
 *   WK-3: total_skills matches mock registry bundled count
 *   WK-4: ETag header present; conditional GET with matching If-None-Match → 304, no body
 *   WK-5: Access-Control-Allow-Origin: * header present on 200 response
 *   WK-6: OPTIONS /.well-known/agentskills.json → 200 with CORS headers
 *   WK-7: Rate limit — 61st request in 60s window from same IP → 429 with Retry-After
 *   WK-8: GET /.well-known/agentskills.xml → 404 (no hang)
 *   WK-9: GET /.well-known/unknown-thing.json → 404 (no hang)
 *   WK-10: GET /.well-known/agentskills.json/extra → 404 (no hang)
 *   WK-11: SUDO_PUBLIC_BASE_URL env var pins registry field origin (no header trust)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { SkillRegistry } from '../../src/core/skills/registry.js';
import { registerWellKnownRoutes } from '../../src/core/gateway/well-known-routes.js';
import { _resetRegistryRateLimits } from '../../src/core/skills/registry-route-types.js';
import type { SkillManifest } from '../../src/core/shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmpDir(): string {
  const dir = join(tmpdir(), `well-known-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeHash(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 32);
}

/**
 * Register N bundled skills via registerFromImport.
 */
function seedBundledSkills(registry: SkillRegistry, count = 5): void {
  const slugs = ['web-summary', 'cron-health', 'self-diagnostic', 'daily-brief', 'viral-hook'];
  const displayNames = ['Web Summary', 'Cron Health', 'Self Diagnostic', 'Daily Brief', 'Viral Hook'];
  const ids = [
    'research.web-summary',
    'automation.cron-health',
    'system.self-diagnostic',
    'intelligence.daily-brief',
    'content.viral-hook',
  ];

  for (let i = 0; i < count; i++) {
    const slug = slugs[i] ?? `skill-${i}`;
    const label = displayNames[i] ?? `Skill ${i}`;
    const skillId = ids[i] ?? `test.skill-${i}`;
    const raw = `---
id: ${skillId}
name: ${slug}
display_name: "${label}"
version: 1.0.0
description: Test skill ${i}.
author: sudo-ai
trust_tier: bundled
license: MIT
compatibility: [node-22]
caps: []
tags: [test]
source: bundled:sudo-ai
metadata:
  trust_tier: bundled
---

Test skill body.
`;
    const manifest: SkillManifest = {
      id: randomUUID(),
      name: slug,
      version: '1.0.0',
      description: `Test skill ${i}.`,
      author: 'sudo-ai',
      source: 'bundled:sudo-ai',
      scheme: 'bundled',
      caps: [],
      tools: [],
      trust: 'bundled',
      contentHash: makeHash(),
      importedAt: new Date().toISOString(),
    };
    registry.registerFromImport(manifest, raw);
  }
}

/** Simple HTTP GET/OPTIONS helper */
async function httpRequest(
  baseUrl: string,
  urlPath: string,
  method: string = 'GET',
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; bodyText: string; headers: http.IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const opts: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: extraHeaders,
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          bodyText: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Well-Known: /.well-known/agentskills.json', () => {
  let db: InstanceType<typeof Database>;
  let registry: SkillRegistry;
  let skillsDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    skillsDir = mkTmpDir();
    registry = new SkillRegistry(db, skillsDir);
    seedBundledSkills(registry, 5);

    // Reset rate-limit state so each test starts clean
    _resetRegistryRateLimits();

    server = http.createServer();
    registerWellKnownRoutes(server, registry);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server?.listening) await stopServer(server);
    try { db.close(); } catch { /* ignore */ }
    rmSync(skillsDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // WK-1: 200 with all 5 required fields
  // -------------------------------------------------------------------------

  it('WK-1: GET /.well-known/agentskills.json returns 200 with all 5 required fields', async () => {
    const { status, bodyText } = await httpRequest(baseUrl, '/.well-known/agentskills.json');
    expect(status).toBe(200);

    const body = JSON.parse(bodyText) as Record<string, unknown>;
    expect(body).toHaveProperty('registry');
    expect(body).toHaveProperty('spec_version');
    expect(body).toHaveProperty('provider');
    expect(body).toHaveProperty('total_skills');
    expect(body).toHaveProperty('last_updated_iso');
  });

  // -------------------------------------------------------------------------
  // WK-2: spec_version === "1.0", provider === "sudo-ai"
  // -------------------------------------------------------------------------

  it('WK-2: spec_version is "1.0" and provider is "sudo-ai"', async () => {
    const { bodyText } = await httpRequest(baseUrl, '/.well-known/agentskills.json');
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    expect(body['spec_version']).toBe('1.0');
    expect(body['provider']).toBe('sudo-ai');
  });

  // -------------------------------------------------------------------------
  // WK-3: total_skills matches seeded bundled count
  // -------------------------------------------------------------------------

  it('WK-3: total_skills matches the number of bundled skills in the registry', async () => {
    const { bodyText } = await httpRequest(baseUrl, '/.well-known/agentskills.json');
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    expect(body['total_skills']).toBe(5);

    // Also verify registry field starts with http and ends with /v1/registry/skills
    const registryUrl = body['registry'] as string;
    expect(registryUrl).toMatch(/^https?:\/\//);
    expect(registryUrl).toMatch(/\/v1\/registry\/skills$/);
  });

  // -------------------------------------------------------------------------
  // WK-4: ETag present; conditional GET with matching If-None-Match → 304
  // -------------------------------------------------------------------------

  it('WK-4: ETag header present; conditional GET with matching If-None-Match returns 304', async () => {
    const { status, headers } = await httpRequest(baseUrl, '/.well-known/agentskills.json');
    expect(status).toBe(200);

    const etag = headers['etag'] as string;
    expect(etag).toBeDefined();
    expect(etag.length).toBeGreaterThan(0);

    // Conditional GET with matching ETag
    const { status: status304, bodyText: body304 } = await httpRequest(
      baseUrl,
      '/.well-known/agentskills.json',
      'GET',
      { 'If-None-Match': etag },
    );
    expect(status304).toBe(304);
    // 304 must have no body
    expect(body304).toBe('');
  });

  // -------------------------------------------------------------------------
  // WK-5: Access-Control-Allow-Origin: * present on 200 response
  // -------------------------------------------------------------------------

  it('WK-5: Access-Control-Allow-Origin: * header present on 200 response', async () => {
    const { headers } = await httpRequest(baseUrl, '/.well-known/agentskills.json');
    expect(headers['access-control-allow-origin']).toBe('*');
  });

  // -------------------------------------------------------------------------
  // WK-6: OPTIONS preflight returns 200 with CORS headers
  // -------------------------------------------------------------------------

  it('WK-6: OPTIONS /.well-known/agentskills.json returns 200 with CORS headers', async () => {
    const { status, headers } = await httpRequest(
      baseUrl,
      '/.well-known/agentskills.json',
      'OPTIONS',
    );
    expect(status).toBe(200);
    expect(headers['access-control-allow-origin']).toBe('*');
    expect(headers['access-control-allow-methods']).toContain('GET');
  });

  // -------------------------------------------------------------------------
  // WK-7: Rate limit — 61st request → 429 with Retry-After
  // -------------------------------------------------------------------------

  it('WK-7: 61st request in 60s window from same IP returns 429 with Retry-After', async () => {
    // Reset to ensure clean window for this test
    _resetRegistryRateLimits();

    // Fire 60 requests — all should succeed
    for (let i = 1; i <= 60; i++) {
      const { status } = await httpRequest(baseUrl, '/.well-known/agentskills.json');
      expect(status, `request ${i} should be 200`).toBe(200);
    }

    // 61st must be rate-limited
    const { status, headers } = await httpRequest(baseUrl, '/.well-known/agentskills.json');
    expect(status).toBe(429);

    const retryAfter = headers['retry-after'];
    expect(retryAfter).toBeDefined();
    expect(Number.isFinite(parseInt(retryAfter as string, 10))).toBe(true);
    expect(parseInt(retryAfter as string, 10)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // WK-8..10: Unknown /.well-known/* paths must return 404, not hang
  // -------------------------------------------------------------------------

  it('WK-8: GET /.well-known/agentskills.xml returns 404 immediately (no hang)', async () => {
    const { status } = await httpRequest(baseUrl, '/.well-known/agentskills.xml');
    expect(status).toBe(404);
  });

  it('WK-9: GET /.well-known/unknown-thing.json returns 404 immediately (no hang)', async () => {
    const { status } = await httpRequest(baseUrl, '/.well-known/unknown-thing.json');
    expect(status).toBe(404);
  });

  it('WK-10: GET /.well-known/agentskills.json/extra returns 404 immediately (no hang)', async () => {
    const { status } = await httpRequest(baseUrl, '/.well-known/agentskills.json/extra');
    expect(status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // WK-11: SUDO_PUBLIC_BASE_URL env var pins origin — headers NOT trusted
  // -------------------------------------------------------------------------

  it('WK-11: SUDO_PUBLIC_BASE_URL env var overrides default origin in registry field', async () => {
    const prev = process.env['SUDO_PUBLIC_BASE_URL'];
    process.env['SUDO_PUBLIC_BASE_URL'] = 'https://sudoapi.shop/';
    try {
      const { status, bodyText } = await httpRequest(
        baseUrl,
        '/.well-known/agentskills.json',
        'GET',
        // Attacker-controlled headers — must NOT appear in the response
        { host: 'evil.com', 'x-forwarded-proto': 'javascript' },
      );
      expect(status).toBe(200);
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      const registryUrl = body['registry'] as string;
      // Must use env var origin (trailing slash stripped)
      expect(registryUrl).toBe('https://sudoapi.shop/v1/registry/skills');
      // Must NOT contain attacker headers
      expect(registryUrl).not.toContain('evil.com');
      expect(registryUrl).not.toContain('javascript');
    } finally {
      if (prev === undefined) {
        delete process.env['SUDO_PUBLIC_BASE_URL'];
      } else {
        process.env['SUDO_PUBLIC_BASE_URL'] = prev;
      }
    }
  });
});
