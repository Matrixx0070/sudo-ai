/**
 * Unit tests for the Public Skill Registry (skill-registry.ts)
 *
 * Tests: publishSkill, getSkill, listSkills, resolveSkill,
 *   verifySkillSignature, ETag caching, rate limiting,
 *   deleteSkill, getVersions, YAML frontmatter parsing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SkillRegistry,
  parseYamlFrontmatter,
  verifySkillSignature,
  _resetSkillRegistryRateLimits,
  type PublishedSkill,
} from '../../src/core/skills/skill-registry.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SKILL_WEB_SUMMARY = `---
name: web-summary
version: 1.0.0
description: Summarize web pages concisely
author: acme
category: research
tags: [research, web, summary]
requires: [fetch, read]
provides: [summarize]
trust_tier: bundled
---

# Web Summary

Summarize any web page into a concise brief.
`;

const SKILL_WEB_SUMMARY_V2 = `---
name: web-summary
version: 2.0.0
description: Summarize web pages with memory support
author: acme
category: research
tags: [research, web, summary, memory]
requires: [fetch, read, memory_search]
provides: [summarize]
trust_tier: bundled
---

# Web Summary v2

Enhanced web page summarization with memory.
`;

const SKILL_CODE_REVIEW = `---
name: code-review
version: 1.0.0
description: Automated code review with best practices
author: devtools
category: coding
tags: [coding, review, automation]
requires: [read, write]
provides: [review]
trust_tier: indexed
---

# Code Review

Automated code review powered by best practices.
`;

const SKILL_MINIMAL = `---
name: minimal-skill
version: 0.1.0
description: A minimal skill
author: tester
category: custom
---

# Minimal

Minimal skill body.
`;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let registry: SkillRegistry;

beforeEach(() => {
  _resetSkillRegistryRateLimits();
  registry = new SkillRegistry('test-secret-key');
});

// ---------------------------------------------------------------------------
// publishSkill tests
// ---------------------------------------------------------------------------

describe('publishSkill', () => {
  it('publishes a skill from raw YAML frontmatter + body', () => {
    const skill = registry.publishSkill(SKILL_WEB_SUMMARY);

    expect(skill.id).toBeTruthy();
    expect(skill.name).toBe('web-summary');
    expect(skill.version).toBe('1.0.0');
    expect(skill.description).toBe('Summarize web pages concisely');
    expect(skill.author).toBe('acme');
    expect(skill.category).toBe('research');
    expect(skill.tags).toEqual(['research', 'web', 'summary']);
    expect(skill.trust_tier).toBe('bundled');
    expect(skill.contentSha256).toBeTruthy();
    expect(skill.signature).toBeTruthy();
    expect(skill.body).toContain('Summarize any web page');
  });

  it('throws when name is missing from frontmatter', () => {
    const noName = `---
version: 1.0.0
author: test
---

Body
`;
    expect(() => registry.publishSkill(noName)).toThrow('name');
  });

  it('throws when author is missing from frontmatter', () => {
    const noAuthor = `---
name: test-skill
version: 1.0.0
---

Body
`;
    expect(() => registry.publishSkill(noAuthor)).toThrow('author');
  });

  it('throws when content exceeds 1 MB limit', () => {
    const bigBody = 'x'.repeat(1_048_577);
    const bigSkill = `---
name: big-skill
version: 1.0.0
author: tester
---

${bigBody}`;
    expect(() => registry.publishSkill(bigSkill)).toThrow('exceeds');
  });

  it('allows re-publishing at a new version for the same skill name', () => {
    registry.publishSkill(SKILL_WEB_SUMMARY);
    const v2 = registry.publishSkill(SKILL_WEB_SUMMARY_V2);

    expect(v2.version).toBe('2.0.0');
    expect(v2.name).toBe('web-summary');
    // Both versions should be retrievable
    expect(registry.getSkill('web-summary', '1.0.0')).not.toBeNull();
    expect(registry.getSkill('web-summary', '2.0.0')).not.toBeNull();
  });

  it('defaults trust_tier to unreviewed when not specified', () => {
    const skill = registry.publishSkill(SKILL_MINIMAL);
    expect(skill.trust_tier).toBe('unreviewed');
  });
});

// ---------------------------------------------------------------------------
// getSkill tests
// ---------------------------------------------------------------------------

describe('getSkill', () => {
  it('returns the latest version when no version specified', () => {
    registry.publishSkill(SKILL_WEB_SUMMARY);
    registry.publishSkill(SKILL_WEB_SUMMARY_V2);

    const latest = registry.getSkill('web-summary');
    expect(latest).not.toBeNull();
    expect(latest!.version).toBe('2.0.0');
  });

  it('returns a specific version when version is specified', () => {
    registry.publishSkill(SKILL_WEB_SUMMARY);
    registry.publishSkill(SKILL_WEB_SUMMARY_V2);

    const v1 = registry.getSkill('web-summary', '1.0.0');
    expect(v1).not.toBeNull();
    expect(v1!.version).toBe('1.0.0');
  });

  it('returns null for a nonexistent skill', () => {
    expect(registry.getSkill('ghost')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listSkills tests
// ---------------------------------------------------------------------------

describe('listSkills', () => {
  beforeEach(() => {
    registry.publishSkill(SKILL_WEB_SUMMARY);
    registry.publishSkill(SKILL_WEB_SUMMARY_V2);
    registry.publishSkill(SKILL_CODE_REVIEW);
  });

  it('lists all skills with pagination', () => {
    const result = registry.listSkills({ limit: 10, offset: 0 });
    // web-summary has 2 versions + code-review has 1 = 3 entries total
    expect(result.data.length).toBe(3);
    expect(result.total).toBe(3);
  });

  it('filters by author', () => {
    const result = registry.listSkills({ author: 'acme' });
    expect(result.data.every(s => s.author === 'acme')).toBe(true);
  });

  it('filters by category', () => {
    const result = registry.listSkills({ category: 'coding' });
    expect(result.data.every(s => s.category === 'coding')).toBe(true);
  });

  it('filters by tags', () => {
    const result = registry.listSkills({ tags: ['web'] });
    expect(result.data.every(s => s.tags.includes('web'))).toBe(true);
  });

  it('searches by query text', () => {
    const result = registry.listSkills({ query: 'code review' });
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.some(s => s.name === 'code-review')).toBe(true);
  });

  it('paginates with limit and offset', () => {
    const result = registry.listSkills({ limit: 1, offset: 0 });
    expect(result.data.length).toBe(1);
    expect(result.total).toBe(3);
  });

  it('sorts by name by default', () => {
    const result = registry.listSkills({ limit: 10 });
    const names = result.data.map(s => s.name);
    for (let i = 1; i < names.length; i++) {
      expect(names[i]! >= names[i - 1]!).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveSkill tests
// ---------------------------------------------------------------------------

describe('resolveSkill', () => {
  beforeEach(() => {
    registry.publishSkill(SKILL_WEB_SUMMARY);
    registry.publishSkill(SKILL_WEB_SUMMARY_V2);
  });

  it('resolves a sudo: URI to the latest skill version', () => {
    const resolved = registry.resolveSkill('sudo:acme/web-summary');
    expect(resolved.skill.name).toBe('web-summary');
    expect(resolved.skill.author).toBe('acme');
    expect(resolved.skill.version).toBe('2.0.0');
    expect(resolved.uri).toBe('sudo:acme/web-summary');
    expect(resolved.resolvedAt).toBeTruthy();
  });

  it('resolves a sudo: URI with a specific version', () => {
    const resolved = registry.resolveSkill('sudo:acme/web-summary@1.0.0');
    expect(resolved.skill.version).toBe('1.0.0');
  });

  it('throws for an invalid sudo: URI format', () => {
    expect(() => registry.resolveSkill('invalid-uri')).toThrow('invalid sudo: URI');
    expect(() => registry.resolveSkill('sudo:badsyntax')).toThrow('invalid sudo: URI');
  });

  it('throws when no skill matches the URI', () => {
    expect(() => registry.resolveSkill('sudo:nobody/missing')).toThrow('skill not found');
  });

  it('throws when author does not match', () => {
    // skill exists with author=acme, but we ask for author=other
    expect(() => registry.resolveSkill('sudo:other/web-summary')).toThrow('skill not found');
  });
});

// ---------------------------------------------------------------------------
// verifySkillSignature tests
// ---------------------------------------------------------------------------

describe('verifySkillSignature', () => {
  it('verifies a valid signature', () => {
    const skill = registry.publishSkill(SKILL_WEB_SUMMARY);
    expect(registry.verifySkillSignature(skill)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const skill = registry.publishSkill(SKILL_WEB_SUMMARY);
    const tampered: PublishedSkill = { ...skill, signature: 'deadbeef' };
    expect(registry.verifySkillSignature(tampered)).toBe(false);
  });

  it('rejects an empty signature', () => {
    const skill = registry.publishSkill(SKILL_WEB_SUMMARY);
    const empty: PublishedSkill = { ...skill, signature: '' };
    expect(registry.verifySkillSignature(empty)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ETag tests
// ---------------------------------------------------------------------------

describe('ETag caching', () => {
  it('generates an ETag for each published skill', () => {
    const skill = registry.publishSkill(SKILL_WEB_SUMMARY);
    const etag = registry.getEtag(skill.id);
    expect(etag).toBeTruthy();
    expect(etag).toMatch(/^"sha256:[a-f0-9]+"$/);
  });

  it('detects not-modified via If-None-Match', () => {
    const skill = registry.publishSkill(SKILL_WEB_SUMMARY);
    const etag = registry.getEtag(skill.id);
    expect(registry.isNotModified(skill.id, etag)).toBe(true);
    expect(registry.isNotModified(skill.id, '"old"')).toBe(false);
    expect(registry.isNotModified(skill.id, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting tests
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('allows requests under the limit', () => {
    const rl = registry.checkRateLimit('192.168.1.1');
    expect(rl.allowed).toBe(true);
    expect(rl.retryAfterSec).toBe(0);
  });

  it('blocks requests exceeding the limit', () => {
    // Exhaust the limit for a single IP
    for (let i = 0; i < 100; i++) {
      registry.checkRateLimit('10.0.0.1');
    }
    const rl = registry.checkRateLimit('10.0.0.1');
    expect(rl.allowed).toBe(false);
    expect(rl.retryAfterSec).toBeGreaterThan(0);
  });

  it('tracks rate limits per IP independently', () => {
    // Exhaust limit for one IP
    for (let i = 0; i < 100; i++) {
      registry.checkRateLimit('10.0.0.1');
    }
    // Different IP should still be allowed
    const rl = registry.checkRateLimit('10.0.0.2');
    expect(rl.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deleteSkill tests
// ---------------------------------------------------------------------------

describe('deleteSkill', () => {
  it('deletes all versions of a skill', () => {
    registry.publishSkill(SKILL_WEB_SUMMARY);
    registry.publishSkill(SKILL_WEB_SUMMARY_V2);
    const deleted = registry.deleteSkill('web-summary');
    expect(deleted).toBe(true);
    expect(registry.getSkill('web-summary')).toBeNull();
    expect(registry.getVersions('web-summary')).toEqual([]);
  });

  it('returns false for a nonexistent skill', () => {
    expect(registry.deleteSkill('ghost')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getVersions tests
// ---------------------------------------------------------------------------

describe('getVersions', () => {
  it('returns all versions sorted by creation time', () => {
    registry.publishSkill(SKILL_WEB_SUMMARY);
    registry.publishSkill(SKILL_WEB_SUMMARY_V2);
    const versions = registry.getVersions('web-summary');
    expect(versions.length).toBe(2);
    expect(versions[0]!.version).toBe('1.0.0');
    expect(versions[1]!.version).toBe('2.0.0');
  });

  it('returns empty array for nonexistent skill', () => {
    expect(registry.getVersions('ghost')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// YAML frontmatter parser tests
// ---------------------------------------------------------------------------

describe('parseYamlFrontmatter', () => {
  it('parses complete frontmatter correctly', () => {
    const { frontmatter, body } = parseYamlFrontmatter(SKILL_WEB_SUMMARY);
    expect(frontmatter.name).toBe('web-summary');
    expect(frontmatter.version).toBe('1.0.0');
    expect(frontmatter.description).toBe('Summarize web pages concisely');
    expect(frontmatter.author).toBe('acme');
    expect(frontmatter.category).toBe('research');
    expect(frontmatter.tags).toEqual(['research', 'web', 'summary']);
    expect(frontmatter.trust_tier).toBe('bundled');
    expect(body).toContain('Summarize any web page');
  });

  it('returns empty frontmatter when no delimiters present', () => {
    const { frontmatter, body } = parseYamlFrontmatter('Just a body, no frontmatter');
    expect(frontmatter.name).toBe('');
    expect(body).toBe('Just a body, no frontmatter');
  });

  it('defaults category to custom for unknown categories', () => {
    const raw = `---
name: test
version: 1.0.0
author: test
category: unknown-category
---

Body
`;
    const { frontmatter } = parseYamlFrontmatter(raw);
    expect(frontmatter.category).toBe('custom');
  });
});

// ---------------------------------------------------------------------------
// Stats tests
// ---------------------------------------------------------------------------

describe('getStats', () => {
  it('returns accurate registry statistics', () => {
    registry.publishSkill(SKILL_WEB_SUMMARY);
    registry.publishSkill(SKILL_WEB_SUMMARY_V2);
    registry.publishSkill(SKILL_CODE_REVIEW);

    const stats = registry.getStats();
    expect(stats.totalSkills).toBe(2);  // 2 unique skill names
    expect(stats.totalVersions).toBe(3); // 3 total version entries
    expect(stats.byCategory['research']).toBe(2);
    expect(stats.byCategory['coding']).toBe(1);
    expect(stats.byAuthor['acme']).toBe(2);
    expect(stats.byAuthor['devtools']).toBe(1);
  });
});