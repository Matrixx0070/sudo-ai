/**
 * Unit tests for SkillsHub and SkillSandbox (Wave 10 Skills Hub)
 *
 * Tests: search, install, update, list, remove, sandbox capability enforcement,
 *        kill-switches, REST route handlers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SkillsHub } from '../../src/core/skills/skills-hub.js';
import { SkillSandbox, getCapabilityList } from '../../src/core/skills/skill-sandbox.js';
import { SkillRegistry } from '../../src/core/skills/registry.js';
import type { InstalledSkill, RegistrySkillEntry } from '../../src/core/skills/skills-hub-types.js';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_REGISTRY_ENTRY: RegistrySkillEntry = {
  id: 'io.github.test.summarize',
  name: 'summarize',
  displayName: 'Summarize Skill',
  description: 'Summarize text concisely',
  version: '1.0.0',
  author: 'test-author',
  license: 'MIT',
  trustTier: 'indexed',
  caps: ['fs.read', 'net.fetch'],
  downloads: 1234,
  tags: ['productivity', 'text'],
  sourceUrl: 'https://github.com/test/summarize',
  compatibility: '>=4.0.0',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

const MOCK_SEARCH_RESPONSE = {
  total: 1,
  results: [MOCK_REGISTRY_ENTRY],
  page: 1,
  pageSize: 1,
};

const MOCK_SKILL_MD = `---
id: io.github.test.summarize
name: summarize
version: 1.0.0
description: Summarize text concisely
author: test-author
trust_tier: indexed
caps: [fs.read, net.fetch]
---

# Summarize Skill

This skill summarizes text.
`;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: InstanceType<typeof Database>;
let registry: SkillRegistry;
let testDir: string;
const INSTALLED_SKILLS_DIR = 'data/installed-skills';

function cleanupInstalledDir(): void {
  const installedDir = join(process.cwd(), INSTALLED_SKILLS_DIR);
  try {
    if (existsSync(installedDir)) {
      rmSync(installedDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }
  mkdirSync(installedDir, { recursive: true });
}

beforeEach(() => {
  testDir = join(tmpdir(), `skills-hub-test-${randomUUID()}`);
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  registry = new SkillRegistry(db, testDir);
  cleanupInstalledDir();
});

afterEach(() => {
  if (db) {
    db.close();
  }
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  cleanupInstalledDir();
});

// ---------------------------------------------------------------------------
// SkillsHub tests
// ---------------------------------------------------------------------------

describe('SkillsHub', () => {
  describe('search', () => {
    it('searches the remote registry with mocked fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => MOCK_SEARCH_RESPONSE,
      });
      vi.stubGlobal('fetch', mockFetch);

      const hub = new SkillsHub(registry);
      const result = await hub.search('summarize', 1, 10);

      expect(result.total).toBe(1);
      expect(result.results.length).toBe(1);
      expect(result.results[0].name).toBe('summarize');
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(1);
    });

    it('throws when hub is disabled', async () => {
      const originalEnv = process.env['SUDO_SKILLS_HUB_DISABLE'];
      process.env['SUDO_SKILLS_HUB_DISABLE'] = '1';

      const hub = new SkillsHub(registry);
      await expect(hub.search('test')).rejects.toThrow('SkillsHub is disabled');

      if (originalEnv !== undefined) {
        process.env['SUDO_SKILLS_HUB_DISABLE'] = originalEnv;
      } else {
        delete process.env['SUDO_SKILLS_HUB_DISABLE'];
      }
    });

    it('retries on fetch failure with exponential backoff', async () => {
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue({
          ok: true,
          json: async () => MOCK_SEARCH_RESPONSE,
        });
      vi.stubGlobal('fetch', mockFetch);

      const hub = new SkillsHub(registry, { maxRetries: 3 });
      const result = await hub.search('summarize');

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result.total).toBe(1);
    });
  });

  describe('install', () => {
    it('installs a skill from mocked registry response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => MOCK_SKILL_MD,
      });
      vi.stubGlobal('fetch', mockFetch);

      const hub = new SkillsHub(registry);
      const installed = await hub.install('summarize');

      expect(installed.name).toBe('summarize');
      expect(installed.version).toBe('1.0.0');
      expect(installed.source).toBe('registry');
      expect(installed.trustTier).toBe('indexed');
    });

    it('throws when install is disabled', async () => {
      const originalEnv = process.env['SUDO_SKILLS_INSTALL_DISABLE'];
      process.env['SUDO_SKILLS_INSTALL_DISABLE'] = '1';

      const hub = new SkillsHub(registry);
      await expect(hub.install('test')).rejects.toThrow('Skill installation is disabled');

      if (originalEnv !== undefined) {
        process.env['SUDO_SKILLS_INSTALL_DISABLE'] = originalEnv;
      } else {
        delete process.env['SUDO_SKILLS_INSTALL_DISABLE'];
      }
    });
  });

  describe('update', () => {
    it('checks for updates and applies them', async () => {
      let installCalled = false;

      // Mock fetch - first call (install) returns 1.0.0, subsequent calls (update check) return 1.1.0
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/download')) {
          if (!installCalled) {
            installCalled = true;
            // First download - install version 1.0.0
            return Promise.resolve({
              ok: true,
              text: async () => MOCK_SKILL_MD, // version 1.0.0
            });
          }
          // Second download - update to version 1.1.0 (minor, non-breaking)
          return Promise.resolve({
            ok: true,
            text: async () => MOCK_SKILL_MD.replace('version: 1.0.0', 'version: 1.1.0'),
          });
        }
        // Search response with newer version 1.1.0 (minor update)
        return Promise.resolve({
          ok: true,
          json: async () => ({
            total: 1,
            results: [{ ...MOCK_REGISTRY_ENTRY, version: '1.1.0' }],
            page: 1,
            pageSize: 1,
          }),
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      const hub = new SkillsHub(registry);

      // First install a skill at version 1.0.0
      await hub.install('summarize');

      // Verify installation worked before testing update
      const skillFile = join(process.cwd(), INSTALLED_SKILLS_DIR, 'summarize', 'SKILL.md');
      expect(existsSync(skillFile)).toBe(true);

      // Then check for updates - should detect 1.1.0 available (non-breaking)
      const updates = await hub.update('summarize');
      expect(updates.length).toBeGreaterThan(0);
      expect(updates[0].hasUpdate).toBe(true);
      expect(updates[0].breakingChanges).toBe(false);
    });
  });

  describe('list', () => {
    it('returns empty array when no skills installed', () => {
      // Directory is cleaned in beforeEach, so list should return empty
      const hub = new SkillsHub(registry);
      const skills = hub.list();
      expect(skills).toEqual([]);
    });

    it('lists installed skills after install', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => MOCK_SKILL_MD,
      });
      vi.stubGlobal('fetch', mockFetch);

      const hub = new SkillsHub(registry);
      await hub.install('summarize');

      // Verify file was written to disk before listing
      const skillFile = join(process.cwd(), INSTALLED_SKILLS_DIR, 'summarize', 'SKILL.md');
      expect(existsSync(skillFile)).toBe(true);

      const skills = hub.list();
      expect(skills.length).toBeGreaterThan(0);
      expect(skills[0].name).toBe('summarize');
    });
  });

  describe('remove', () => {
    it('removes an installed skill', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => MOCK_SKILL_MD,
      });
      vi.stubGlobal('fetch', mockFetch);

      const hub = new SkillsHub(registry);
      await hub.install('summarize');

      // Verify file was written before testing removal
      const skillFile = join(process.cwd(), INSTALLED_SKILLS_DIR, 'summarize', 'SKILL.md');
      expect(existsSync(skillFile)).toBe(true);

      // Remove
      const removed = hub.remove('summarize');
      expect(removed).toBe(true);
      expect(existsSync(skillFile)).toBe(false);
    });

    it('returns false when skill not found', () => {
      const hub = new SkillsHub(registry);
      const removed = hub.remove('nonexistent');
      expect(removed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// SkillSandbox tests
// ---------------------------------------------------------------------------

describe('SkillSandbox', () => {
  const bundledSkill: InstalledSkill = {
    id: 'test-bundled',
    name: 'bundled-skill',
    version: '1.0.0',
    installedAt: new Date().toISOString(),
    source: 'bundled',
    trustTier: 'bundled',
    caps: ['fs.read', 'fs.write', 'net.fetch', 'db.read', 'db.write', 'shell.exec'],
    enabled: true,
  };

  const indexedSkill: InstalledSkill = {
    id: 'test-indexed',
    name: 'indexed-skill',
    version: '1.0.0',
    installedAt: new Date().toISOString(),
    source: 'registry',
    trustTier: 'indexed',
    caps: ['fs.read', 'net.fetch'],
    enabled: true,
  };

  const unreviewedSkill: InstalledSkill = {
    id: 'test-unreviewed',
    name: 'unreviewed-skill',
    version: '1.0.0',
    installedAt: new Date().toISOString(),
    source: 'import',
    trustTier: 'unreviewed',
    caps: ['fs.read'],
    enabled: true,
  };

  describe('checkCapabilities', () => {
    it('allows all tools for bundled tier', () => {
      const sandbox = new SkillSandbox();
      expect(sandbox.checkCapabilities(bundledSkill, 'coder.read-file')).toBe(true);
      expect(sandbox.checkCapabilities(bundledSkill, 'coder.write-file')).toBe(true);
      expect(sandbox.checkCapabilities(bundledSkill, 'system.shell')).toBe(true);
    });

    it('allows only indexed tools for indexed tier', () => {
      const sandbox = new SkillSandbox();
      expect(sandbox.checkCapabilities(indexedSkill, 'coder.read-file')).toBe(true);
      expect(sandbox.checkCapabilities(indexedSkill, 'coder.fetch')).toBe(true);
      expect(sandbox.checkCapabilities(indexedSkill, 'system.shell')).toBe(false);
      expect(sandbox.checkCapabilities(indexedSkill, 'coder.write-file')).toBe(false);
    });

    it('allows only fs.read for unreviewed tier', () => {
      const sandbox = new SkillSandbox();
      expect(sandbox.checkCapabilities(unreviewedSkill, 'coder.read-file')).toBe(true);
      expect(sandbox.checkCapabilities(unreviewedSkill, 'coder.fetch')).toBe(false);
      expect(sandbox.checkCapabilities(unreviewedSkill, 'coder.write-file')).toBe(false);
    });

    it('bypasses all checks when sandbox is disabled', () => {
      const originalEnv = process.env['SUDO_SKILLS_SANDBOX_DISABLE'];
      process.env['SUDO_SKILLS_SANDBOX_DISABLE'] = '1';

      const sandbox = new SkillSandbox();
      expect(sandbox.checkCapabilities(unreviewedSkill, 'system.shell')).toBe(true);
      expect(sandbox.checkCapabilities(unreviewedSkill, 'db.write')).toBe(true);

      if (originalEnv !== undefined) {
        process.env['SUDO_SKILLS_SANDBOX_DISABLE'] = originalEnv;
      } else {
        delete process.env['SUDO_SKILLS_SANDBOX_DISABLE'];
      }
    });
  });

  describe('getCapabilityList', () => {
    it('returns all tools for bundled tier', () => {
      const tools = getCapabilityList('bundled');
      expect(tools.length).toBeGreaterThan(5);
      expect(tools).toContain('coder.read-file');
      expect(tools).toContain('system.shell');
    });

    it('returns limited tools for indexed tier', () => {
      const tools = getCapabilityList('indexed');
      expect(tools).toContain('coder.read-file');
      expect(tools).toContain('coder.fetch');
      expect(tools).not.toContain('system.shell');
    });

    it('returns minimal tools for unreviewed tier', () => {
      const tools = getCapabilityList('unreviewed');
      expect(tools).toContain('coder.read-file');
      expect(tools.length).toBeLessThan(5);
    });
  });
});

// ---------------------------------------------------------------------------
// REST route handler tests (mock req/res)
// ---------------------------------------------------------------------------

describe('SkillsHub REST routes', () => {
  it('search endpoint returns results with mock req/res', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => MOCK_SEARCH_RESPONSE,
    });
    vi.stubGlobal('fetch', mockFetch);

    // Set up auth token
    const originalToken = process.env['GATEWAY_TOKEN'];
    process.env['GATEWAY_TOKEN'] = 'test-token';

    const { registerSkillsHubRoutes } = await import('../../src/core/skills/skills-hub-routes.js');
    const http = await import('node:http');

    const server = http.createServer();
    const hub = new SkillsHub(registry);
    registerSkillsHubRoutes(server, hub);

    // Mock response object
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn(),
      headersSent: false,
    } as unknown as import('node:http').ServerResponse;

    // Mock request object
    const mockReq = {
      url: '/v1/skills/registry/search?q=test',
      method: 'GET',
      headers: { authorization: 'Bearer test-token' },
      socket: { remoteAddress: '127.0.0.1' },
      on: vi.fn(),
    } as unknown as import('node:http').IncomingMessage;

    server.emit('request', mockReq, mockRes);

    // Give async handler time to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFetch).toHaveBeenCalled();

    if (originalToken !== undefined) {
      process.env['GATEWAY_TOKEN'] = originalToken;
    } else {
      delete process.env['GATEWAY_TOKEN'];
    }
  });
});
