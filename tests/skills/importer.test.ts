/**
 * Tests for importer.ts — SkillImporter with URI validation and SSRF safety.
 * Fetch is mocked at module level using vi.mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSkillUri, SkillImporter } from '../../src/core/skills/importer.js';

// ---------------------------------------------------------------------------
// Mock global fetch (must be top-level, not inside describe/it)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkillMarkdown(opts: {
  name?: string;
  version?: string;
  caps?: string;
  trust_tier?: string;
} = {}): string {
  const lines = [
    '---',
    `name: ${opts.name ?? 'test-skill'}`,
    `version: ${opts.version ?? '1.0.0'}`,
    'description: A test skill',
    'author: tester',
  ];
  if (opts.caps) lines.push(`caps: ${opts.caps}`);
  if (opts.trust_tier) lines.push(`trust_tier: ${opts.trust_tier}`);
  lines.push('---', '', 'Skill body.');
  return lines.join('\n');
}

function mockSuccessResponse(content: string): void {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  let done = false;
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: bytes };
        },
        releaseLock: () => {},
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// parseSkillUri()
// ---------------------------------------------------------------------------

describe('parseSkillUri()', () => {
  it('parses github: scheme correctly', () => {
    const parsed = parseSkillUri('github:owner/repo/skill.md');
    expect(parsed.scheme).toBe('github');
    expect(parsed.path).toBe('owner/repo/skill.md');
  });

  it('parses openclaw: scheme correctly', () => {
    const parsed = parseSkillUri('openclaw:registry-id/skill-id');
    expect(parsed.scheme).toBe('openclaw');
    expect(parsed.path).toBe('registry-id/skill-id');
  });

  it('parses openjarvis: scheme correctly', () => {
    const parsed = parseSkillUri('openjarvis:jarvis/my-skill');
    expect(parsed.scheme).toBe('openjarvis');
    expect(parsed.path).toBe('jarvis/my-skill');
  });

  it('rejects raw https:// URLs', () => {
    expect(() => parseSkillUri('https://raw.githubusercontent.com/user/repo/skill.md')).toThrow(
      /Raw HTTP/,
    );
  });

  it('rejects raw http:// URLs', () => {
    expect(() => parseSkillUri('http://evil.com/skill.md')).toThrow(/Raw HTTP/);
  });

  it('rejects unknown schemes', () => {
    expect(() => parseSkillUri('ftp:some/path')).toThrow(/Unsupported skill URI scheme/);
  });

  it('rejects empty URI', () => {
    expect(() => parseSkillUri('')).toThrow(/non-empty string/);
  });

  it('rejects URI with no colon separator', () => {
    expect(() => parseSkillUri('nocolon')).toThrow(/no scheme separator/);
  });

  it('rejects URI with very short path', () => {
    expect(() => parseSkillUri('github:x')).toThrow(/too short/);
  });
});

// ---------------------------------------------------------------------------
// SkillImporter.import()
// ---------------------------------------------------------------------------

describe('SkillImporter.import()', () => {
  let importer: SkillImporter;

  beforeEach(() => {
    importer = new SkillImporter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves github: URI and returns SkillManifest', async () => {
    const content = makeSkillMarkdown({ name: 'my-skill', caps: '[fs.read]' });
    mockSuccessResponse(content);

    const result = await importer.import('github:owner/repo/my-skill.md');
    expect(result.manifest.name).toBe('my-skill');
    expect(result.manifest.scheme).toBe('github');
    expect(result.manifest.source).toBe('github:owner/repo/my-skill.md');
    expect(result.manifest.contentHash).toHaveLength(64); // SHA-256 hex
    expect(result.manifest.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('resolves openclaw: URI', async () => {
    const content = makeSkillMarkdown({ name: 'openclaw-skill' });
    mockSuccessResponse(content);

    const result = await importer.import('openclaw:registry/skill-id');
    expect(result.manifest.scheme).toBe('openclaw');
  });

  it('resolves openjarvis: URI', async () => {
    const content = makeSkillMarkdown({ name: 'jarvis-skill' });
    mockSuccessResponse(content);

    const result = await importer.import('openjarvis:jarvis/skill-id');
    expect(result.manifest.scheme).toBe('openjarvis');
  });

  it('applies trustOverride to manifest trust field', async () => {
    const content = makeSkillMarkdown({ name: 'override-skill' });
    mockSuccessResponse(content);

    const result = await importer.import('github:owner/repo/skill.md', 'indexed');
    expect(result.manifest.trust).toBe('indexed');
  });

  it('defaults to unreviewed trust tier for github: without override', async () => {
    const content = makeSkillMarkdown({ name: 'unknown-skill' });
    mockSuccessResponse(content);

    const result = await importer.import('github:owner/repo/skill.md');
    expect(result.manifest.trust).toBe('unreviewed');
  });

  it('throws for raw https:// URLs (SSRF safety)', async () => {
    await expect(importer.import('https://evil.com/skill.md')).rejects.toThrow(/Raw HTTP/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws for unsupported scheme (SSRF safety)', async () => {
    await expect(importer.import('ftp:some/path/thing')).rejects.toThrow(/Unsupported/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when HTTP response is not 200', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, body: null });
    await expect(importer.import('github:owner/repo/missing.md')).rejects.toThrow(/HTTP 404/);
  });

  it('throws when capability check fails for unreviewed skill requesting fs.write', async () => {
    const content = makeSkillMarkdown({
      name: 'greedy-skill',
      caps: '[fs.write, shell.exec]',
    });
    mockSuccessResponse(content);

    await expect(
      importer.import('github:owner/repo/greedy.md', 'unreviewed'),
    ).rejects.toThrow(/Capability check failed/);
  });

  it('allows skill with no caps (no cap check needed)', async () => {
    const content = makeSkillMarkdown({ name: 'no-caps-skill' });
    mockSuccessResponse(content);

    const result = await importer.import('github:owner/repo/no-caps.md');
    expect(result.manifest.caps).toHaveLength(0);
  });

  it('constructs fetch URL from safe allowlist base (SSRF: hostname not from user input)', async () => {
    const content = makeSkillMarkdown({ name: 'safe-skill' });
    mockSuccessResponse(content);

    await importer.import('github:owner/repo/safe.md');

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
    // Ensure no evil.com or arbitrary hostname
    expect(calledUrl).not.toContain('evil.com');
  });

  it('includes contentHash (SHA-256) in manifest', async () => {
    const content = makeSkillMarkdown({ name: 'hash-skill' });
    mockSuccessResponse(content);

    const result = await importer.import('github:owner/repo/hash.md');
    expect(result.manifest.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
