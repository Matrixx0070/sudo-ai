/**
 * @file soul-card.test.ts
 * @description TX25 — /soul renders a read-only SUMMARY of the frozen
 * identity surfaces with per-file provenance hashes. Pure functions tested;
 * the module never writes (invariant 4 — verified by API surface: only
 * readFile is imported).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { summariseIdentityFile, renderSoulCard, buildSoulCard } from '../../src/core/channels/soul-card.js';

describe('TX25 soul card', () => {
  it('SOUL-1: summarises title, H2 headings, and a stable short hash', () => {
    const s = summariseIdentityFile('Soul', '# SOUL — Core\n\n## Values\nx\n## Style\ny\n');
    expect(s.title).toBe('SOUL — Core');
    expect(s.headings).toEqual(['Values', 'Style']);
    expect(s.sha).toMatch(/^[0-9a-f]{12}$/);
    // Deterministic: same bytes, same hash.
    expect(summariseIdentityFile('Soul', '# SOUL — Core\n\n## Values\nx\n## Style\ny\n').sha).toBe(s.sha);
  });

  it('SOUL-2: renders sections + missing files + read-only note', () => {
    const card = renderSoulCard(
      [{ label: 'Soul', title: 'T', headings: ['A'], sha: 'abcdefabcdef' }],
      ['User'],
    );
    expect(card).toContain('read-only');
    expect(card).toContain('**Soul** — T');
    expect(card).toContain('sha256 abcdefabcdef');
    expect(card).toContain('missing: User');
  });

  it('SOUL-3: buildSoulCard reads the trio from a workspace dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx25-'));
    try {
      writeFileSync(join(dir, 'SOUL.md'), '# S\n## V\n');
      writeFileSync(join(dir, 'IDENTITY.md'), '# I\n');
      const card = await buildSoulCard(dir);
      expect(card).toContain('**Soul** — S');
      expect(card).toContain('**Identity** — I');
      expect(card).toContain('missing: User');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
