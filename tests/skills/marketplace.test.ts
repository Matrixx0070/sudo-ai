/**
 * Tests for the Skills Marketplace.
 * Network effects from shared skills compound growth.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillsMarketplace } from '../../src/core/skills/marketplace.js';
import type { SkillManifest } from '../../src/core/skills/marketplace.js';
import { mkdirSync, rmSync } from 'fs';

const TEST_DIR = 'test-data-marketplace';

describe('SkillsMarketplace', () => {
  let marketplace: SkillsMarketplace;

  beforeEach(() => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
    mkdirSync(TEST_DIR, { recursive: true });

    marketplace = new SkillsMarketplace({ dataDir: TEST_DIR });
  });

  function makeManifest(overrides?: Partial<SkillManifest>): SkillManifest {
    return {
      name: 'test-skill',
      version: '1.0.0',
      description: 'A test skill',
      author: 'test',
      category: 'automation',
      tags: ['test'],
      requires: [],
      provides: ['testing'],
      inputs: [],
      compatibility: { sudoAiVersion: '>=4.0.0', platforms: ['linux'] },
      ...overrides,
    };
  }

  it('should initialize with default config', () => {
    expect(marketplace).toBeDefined();
  });

  it('should publish a skill', () => {
    const skill = marketplace.publish(makeManifest(), '# Test Skill\n\nBody content');

    expect(skill).toBeDefined();
    expect(skill.name).toBe('test-skill');
    expect(skill.author).toBe('test');
    expect(skill.downloads).toBe(0);
    expect(skill.rating).toBe(0);
    expect(skill.source).toBe('local');
  });

  it('should search skills by name', () => {
    marketplace.publish(makeManifest({ name: 'web-scraper' }), 'Content');
    marketplace.publish(makeManifest({ name: 'data-analyzer' }), 'Content');
    marketplace.publish(makeManifest({ name: 'web-monitor' }), 'Content');

    const results = marketplace.search({ query: 'web' });
    // At least the 2 we published with "web" in the name
    const webResults = results.filter(r => r.name.includes('web'));
    expect(webResults.length).toBeGreaterThanOrEqual(2);
    expect(results.every(r => r.name.includes('web') || r.description.includes('web') || r.tags.some(t => t.includes('web')))).toBe(true);
  });

  it('should search skills by category', () => {
    marketplace.publish(makeManifest({ name: 'sk1', category: 'coding' }), 'C1');
    marketplace.publish(makeManifest({ name: 'sk2', category: 'research' }), 'C2');
    marketplace.publish(makeManifest({ name: 'sk3', category: 'coding' }), 'C3');

    const coding = marketplace.search({ category: 'coding' });
    expect(coding.length).toBe(2);
  });

  it('should search skills by tag', () => {
    marketplace.publish(makeManifest({ name: 'sk1', tags: ['python', 'ml'] }), 'C1');
    marketplace.publish(makeManifest({ name: 'sk2', tags: ['javascript'] }), 'C2');

    const python = marketplace.search({ tags: ['python'] });
    expect(python.length).toBe(1);
    expect(python[0].name).toBe('sk1');
  });

  it('should sort skills by downloads', () => {
    marketplace.publish(makeManifest({ name: 'popular' }), 'C1');
    marketplace.publish(makeManifest({ name: 'unpopular' }), 'C2');

    // Simulate downloads
    marketplace.download(marketplace.search({ query: 'popular' })[0].id);

    const results = marketplace.search({ sortBy: 'downloads' });
    expect(results[0].name).toBe('popular');
  });

  it('should download a skill and increment count', () => {
    const skill = marketplace.publish(makeManifest(), 'Content');

    marketplace.download(skill.id);
    marketplace.download(skill.id);
    marketplace.download(skill.id);

    const downloaded = marketplace.download(skill.id);
    expect(downloaded?.downloads).toBe(4);
  });

  it('should rate a skill', () => {
    const skill = marketplace.publish(makeManifest(), 'Content');

    marketplace.rateSkill(skill.id, 'user1', 5, 'Excellent!');
    marketplace.rateSkill(skill.id, 'user2', 3);

    const updated = marketplace.getSkill(skill.id);
    expect(updated?.rating).toBe(4);
    expect(updated?.ratingCount).toBe(2);
  });

  it('should reject invalid ratings', () => {
    const skill = marketplace.publish(makeManifest(), 'Content');

    expect(() => marketplace.rateSkill(skill.id, 'user1', 0)).toThrow();
    expect(() => marketplace.rateSkill(skill.id, 'user1', 6)).toThrow();
  });

  it('should feature a skill', () => {
    const sk1 = marketplace.publish(makeManifest({ name: 'featured' }), 'C1');
    const sk2 = marketplace.publish(makeManifest({ name: 'regular' }), 'C2');

    marketplace.setFeatured(sk1.id);

    const featured = marketplace.getFeatured();
    expect(featured).not.toBeNull();
    expect(featured!.name).toBe('featured');

    // Replace featured
    marketplace.setFeatured(sk2.id);
    const newFeatured = marketplace.getFeatured();
    expect(newFeatured!.name).toBe('regular');

    // Previous is no longer featured
    const prev = marketplace.getSkill(sk1.id);
    expect(prev?.featured).toBe(false);
  });

  it('should get trending skills', () => {
    marketplace.publish(makeManifest({ name: 'hot' }), 'C1');
    marketplace.publish(makeManifest({ name: 'cold' }), 'C2');

    // Download the "hot" skill many times
    const hot = marketplace.search({ query: 'hot' })[0];
    for (let i = 0; i < 10; i++) marketplace.download(hot.id);

    const trending = marketplace.getTrending(10);
    expect(trending[0].name).toBe('hot');
  });

  it('should import from ClawHub format', () => {
    const skill = marketplace.importFromClawHub({
      name: 'claw-skill',
      description: 'From ClawHub',
      author: 'community',
      version: '2.0.0',
      category: 'automation',
      tags: ['clawhub', 'automation'],
      body: 'Skill content from ClawHub',
      sourceUrl: 'https://clawhub.example.com/skills/claw-skill',
    });

    expect(skill.source).toBe('clawhub');
    expect(skill.name).toBe('claw-skill');
    expect(skill.sourceUrl).toBeTruthy();
  });

  it('should import from agentskills.io format', () => {
    const skill = marketplace.importFromAgentSkills({
      name: 'hermes-skill',
      description: 'From agentskills.io',
      author: 'community',
      version: '1.5.0',
      skills: ['memory', 'persistence'],
      body: 'Hermes skill content',
      sourceUrl: 'https://agentskills.io/skills/hermes-skill',
    });

    expect(skill.source).toBe('agentskills');
    expect(skill.name).toBe('hermes-skill');
  });

  it('should return marketplace statistics', () => {
    marketplace.publish(makeManifest({ name: 'sk1', category: 'coding' }), 'C1');
    marketplace.publish(makeManifest({ name: 'sk2', category: 'research' }), 'C2');

    const stats = marketplace.getStats();
    expect(stats.totalSkills).toBeGreaterThanOrEqual(2);
    expect(stats.totalDownloads).toBeDefined();
    expect(stats.byCategory).toBeDefined();
  });

  it('should return skill categories', () => {
    const categories = marketplace.getCategories();
    expect(categories.length).toBeGreaterThan(0);
    expect(categories).toContain('automation');
    expect(categories).toContain('coding');
  });
});