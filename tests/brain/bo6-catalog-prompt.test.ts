/**
 * @file bo6-catalog-prompt.test.ts
 * @description BO6/S3 — the skill catalog rides the STABLE cached prefix.
 * Proves (e-adjacent) that injecting the catalog keeps BO2b's byte-stable
 * prefix intact: the <available_skills> block sits ABOVE the boundary, and two
 * assemblies that differ only in volatile fields still hash-match on the prefix.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { assembleSystemPrompt } from '../../src/core/brain/system-prompt.js';
import { buildPromptReport } from '../../src/core/brain/prompt-report.js';
import { buildAndRenderSkillCatalog } from '../../src/core/skills/skill-catalog.js';

const BOUNDARY = '<!-- __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ -->';

const catalog = buildAndRenderSkillCatalog([
  { name: 'tldr', description: 'Summarize a thread.', content: 'body-a', filePath: `${process.cwd()}/skills/tldr/SKILL.md` },
  { name: 'debug', description: 'Parse a stack trace.', content: 'body-b', filePath: `${process.cwd()}/skills/debug/SKILL.md` },
]);

afterEach(() => {
  delete process.env['SUDO_PROMPT_CACHE'];
});

describe('BO6/S3 catalog in the system prompt', () => {
  it('injects the <available_skills> block ABOVE the dynamic boundary (cacheable prefix)', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';
    const prompt = await assembleSystemPrompt({ skillCatalog: catalog });
    const boundaryIdx = prompt.indexOf(BOUNDARY);
    const catalogIdx = prompt.indexOf('<available_skills>');
    expect(catalogIdx).toBeGreaterThan(0);
    expect(boundaryIdx).toBeGreaterThan(0);
    expect(catalogIdx).toBeLessThan(boundaryIdx); // catalog is in the stable prefix
    // The body of a skill is NOT injected — only the catalog line.
    expect(prompt).not.toContain('body-a');
    expect(prompt).toContain('tldr:');
  });

  it('keeps the stable prefix byte-identical across turns that differ only in Recent Memory', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';
    const a = await assembleSystemPrompt({ skillCatalog: catalog, memoryContext: 'turn-1\n'.repeat(10) });
    const b = await assembleSystemPrompt({ skillCatalog: catalog, memoryContext: 'turn-2 different\n'.repeat(20) });
    const ra = buildPromptReport(a);
    const rb = buildPromptReport(b);
    expect(ra.stablePrefixSha256).toBe(rb.stablePrefixSha256);
    // And the catalog is inside that stable prefix.
    expect(a.slice(0, a.indexOf(BOUNDARY))).toContain('<available_skills>');
  });

  it('omitting skillCatalog leaves the prompt catalog-free (byte-identical default preserved)', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';
    const withOut = await assembleSystemPrompt({});
    expect(withOut).not.toContain('<available_skills>');
  });
});
