/**
 * @file skill-optimizer-auto-apply.test.ts
 * @description Unit tests for SkillOptimizer.autoApplyApproved() — P2-d.
 *
 * Tests:
 *  1. SUDO_SKILL_AUTO_APPLY unset → returns 0
 *  2. trust_tier < T2 (LOW / PROBATION) → returns 0
 *  3. Pending proposal + env=1 + T2 (MEDIUM) → applied, store marked auto-applied
 *  4. CRITICAL risk → skipped, not applied
 *  5. REPLAN from epistemic gate → skipped
 *  6. No TrustTierTracker → returns 0
 *  7. No pending proposals → returns 0
 *  8. HIGH risk → skipped, not applied
 *  9. [NEW] Disk write: skill YAML on disk updated when auto-apply fires
 * 10. [NEW] No skillsDir → proposals skipped (fail-safe)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SkillOptimizationStore } from '../../src/core/skills/skill-optimization-store.js';
import { SkillOptimizer, type TrustTierTrackerLike } from '../../src/core/skills/skill-optimizer.js';
import type { SkillOptimizationProposal } from '../../src/core/shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `skill-auto-apply-test-${randomUUID()}.db`);
}

const ISO_NOW = new Date().toISOString();

function makeProposal(overrides: Partial<SkillOptimizationProposal> = {}): SkillOptimizationProposal {
  return {
    id: randomUUID(),
    skillId: 'test-skill-id',
    skillName: 'test-skill',
    targetField: 'description',
    currentValue: 'old description',
    proposedValue: 'improved description',
    evidence: 'pattern seen 5x',
    confidence: 0.75,
    status: 'pending',
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    ...overrides,
  };
}

// Minimal stub signals (no patterns → propose() generates 0 proposals;
// we seed the store directly instead)
const emptyDiscovery = { mine: () => [] };
const emptyRegistry = { list: () => [] };

function makeTierTracker(tier: 'HIGH' | 'MEDIUM' | 'LOW' | 'PROBATION'): TrustTierTrackerLike {
  return { getCurrentTier: () => tier };
}

/**
 * Create a temporary skills directory containing a minimal SKILL.md for each
 * skill name provided. Returns the directory path; caller must clean up.
 *
 * The SKILL.md is written inside a subdirectory matching the skill name so
 * findSkillFilePath() discovers it via the recursive walk.
 */
function makeSkillsDir(...skillNames: string[]): string {
  const root = path.join(os.tmpdir(), `skills-dir-${randomUUID()}`);
  for (const skillName of skillNames) {
    const skillDir = path.join(root, skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    const skillMd = [
      '---',
      `name: ${skillName}`,
      'version: 1.0.0',
      'description: original description',
      'trust_tier: bundled',
      '---',
      '',
      '## Body',
      'Original body content.',
    ].join('\n');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');
  }
  return root;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let dbPath: string;
let store: SkillOptimizationStore;
const skillsDirsToClean: string[] = [];

beforeEach(() => {
  dbPath = tmpDbPath();
  store = new SkillOptimizationStore(dbPath);
  // Clear env var before each test
  vi.unstubAllEnvs();
});

afterEach(() => {
  store.close();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  // Clean up any skill directories created during the test
  for (const dir of skillsDirsToClean.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillOptimizer.autoApplyApproved()', () => {

  it('returns 0 when SUDO_SKILL_AUTO_APPLY is not set', async () => {
    // No env stub → SUDO_SKILL_AUTO_APPLY is undefined
    const skillsDir = makeSkillsDir('test-skill');
    skillsDirsToClean.push(skillsDir);
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('HIGH'),
      skillsDir,
    );
    const proposal = makeProposal();
    store.save(proposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(0);

    // Verify proposal is still pending
    const stored = store.getById(proposal.id);
    expect(stored?.status).toBe('pending');
  });

  it('returns 0 when SUDO_SKILL_AUTO_APPLY=0', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '0');
    const skillsDir = makeSkillsDir('test-skill');
    skillsDirsToClean.push(skillsDir);
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('HIGH'),
      skillsDir,
    );
    const proposal = makeProposal();
    store.save(proposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(0);
  });

  it('returns 0 when trust tier is LOW (< T2)', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '1');
    const skillsDir = makeSkillsDir('test-skill');
    skillsDirsToClean.push(skillsDir);
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('LOW'),
      skillsDir,
    );
    const proposal = makeProposal();
    store.save(proposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(0);

    const stored = store.getById(proposal.id);
    expect(stored?.status).toBe('pending');
  });

  it('returns 0 when trust tier is PROBATION (< T2)', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '1');
    const skillsDir = makeSkillsDir('test-skill');
    skillsDirsToClean.push(skillsDir);
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('PROBATION'),
      skillsDir,
    );
    const proposal = makeProposal();
    store.save(proposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(0);
  });

  it('returns 0 when no TrustTierTracker provided', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '1');
    // 6th param (trustTierTracker) omitted — no skillsDir needed since tier check fires first
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
    );
    const proposal = makeProposal();
    store.save(proposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(0);
  });

  it('applies pending proposal when env=1 and tier is MEDIUM (T2)', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '1');
    const skillsDir = makeSkillsDir('safe-skill');
    skillsDirsToClean.push(skillsDir);
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('MEDIUM'),
      skillsDir,
    );
    const proposal = makeProposal({
      skillId: 'safe-skill', // 'safe' does not trigger CRITICAL/HIGH patterns
      skillName: 'safe-skill',
      proposedValue: 'a safe improved description',
    });
    store.save(proposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(1);

    // Verify store record is marked auto-applied
    const stored = store.getById(proposal.id);
    expect(stored?.status).toBe('auto-applied');
  });

  it('applies pending proposal when env=1 and tier is HIGH (T3)', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '1');
    const skillsDir = makeSkillsDir('safe-skill');
    skillsDirsToClean.push(skillsDir);
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('HIGH'),
      skillsDir,
    );
    const proposal = makeProposal({
      skillId: 'safe-skill',
      skillName: 'safe-skill',
      proposedValue: 'another safe improvement',
    });
    store.save(proposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(1);

    const stored = store.getById(proposal.id);
    expect(stored?.status).toBe('auto-applied');
  });

  it('skips proposal when classifyRisk returns CRITICAL (skillId contains "delete")', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '1');
    const skillsDir = makeSkillsDir('delete-skill');
    skillsDirsToClean.push(skillsDir);
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('MEDIUM'),
      skillsDir,
    );
    // classifyRisk(toolName, args): 'delete' in skillId matches CRITICAL_TOOL_RE
    const proposal = makeProposal({
      skillId: 'delete-skill',
      skillName: 'delete-skill',
      proposedValue: 'some value',
    });
    store.save(proposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(0);

    // Proposal should remain pending (not auto-applied)
    const stored = store.getById(proposal.id);
    expect(stored?.status).toBe('pending');
  });

  it('skips proposal when classifyRisk returns HIGH (skillId contains "write")', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '1');
    const skillsDir = makeSkillsDir('write-skill');
    skillsDirsToClean.push(skillsDir);
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('MEDIUM'),
      skillsDir,
    );
    // 'write' in skillId matches HIGH_TOOL_RE
    const proposal = makeProposal({ skillId: 'write-skill', skillName: 'write-skill' });
    store.save(proposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(0);

    const stored = store.getById(proposal.id);
    expect(stored?.status).toBe('pending');
  });

  it('returns 0 when no pending proposals exist', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '1');
    const skillsDir = makeSkillsDir('safe-skill');
    skillsDirsToClean.push(skillsDir);
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('MEDIUM'),
      skillsDir,
    );
    // Save an approved proposal — should not be processed
    const proposal = makeProposal({ status: 'approved' });
    store.save(proposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(0);
  });

  it('applies multiple pending proposals when all pass gates', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '1');
    const skillsDir = makeSkillsDir('safe-skill-one', 'safe-skill-two');
    skillsDirsToClean.push(skillsDir);
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('HIGH'),
      skillsDir,
    );

    const proposals = [
      makeProposal({ skillId: 'safe-skill-one', skillName: 'safe-skill-one', proposedValue: 'improvement one' }),
      makeProposal({ skillId: 'safe-skill-two', skillName: 'safe-skill-two', proposedValue: 'improvement two' }),
    ];
    for (const p of proposals) store.save(p);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(2);

    for (const p of proposals) {
      expect(store.getById(p.id)?.status).toBe('auto-applied');
    }
  });

  it('partially applies when some proposals fail risk gate', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '1');
    const skillsDir = makeSkillsDir('safe-skill', 'delete-risky-skill');
    skillsDirsToClean.push(skillsDir);
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('HIGH'),
      skillsDir,
    );

    const safeProposal = makeProposal({ skillId: 'safe-skill', skillName: 'safe-skill', proposedValue: 'safe value' });
    const riskyProposal = makeProposal({ skillId: 'delete-risky-skill', skillName: 'delete-risky-skill', proposedValue: 'risky' });
    store.save(safeProposal);
    store.save(riskyProposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(1);

    expect(store.getById(safeProposal.id)?.status).toBe('auto-applied');
    expect(store.getById(riskyProposal.id)?.status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // [NEW] Test 9 — disk write verification
  // Verifies that the SKILL.md on disk is actually updated when auto-apply fires.
  // -------------------------------------------------------------------------
  it('writes proposedValue to skill YAML on disk when auto-apply fires', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '1');
    const skillsDir = makeSkillsDir('my-disk-skill');
    skillsDirsToClean.push(skillsDir);
    const skillFilePath = path.join(skillsDir, 'my-disk-skill', 'SKILL.md');

    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('HIGH'),
      skillsDir,
    );

    const proposal = makeProposal({
      skillId: 'my-disk-skill',
      skillName: 'my-disk-skill',
      targetField: 'description',
      proposedValue: 'disk write verified description',
    });
    store.save(proposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(1);

    // Verify store record is marked auto-applied
    const stored = store.getById(proposal.id);
    expect(stored?.status).toBe('auto-applied');

    // Verify the SKILL.md file on disk was actually updated
    const updatedContent = fs.readFileSync(skillFilePath, 'utf8');
    expect(updatedContent).toContain('disk write verified description');

    // The body content must still be present (write didn't truncate the file)
    expect(updatedContent).toContain('Original body content.');
  });

  // -------------------------------------------------------------------------
  // [NEW] Test 10 — no skillsDir → proposals skipped (fail-safe)
  // Without a skillsDir, autoApplyApproved cannot write to disk and therefore
  // must NOT mark proposals as auto-applied in the DB either.
  // -------------------------------------------------------------------------
  it('skips all proposals when skillsDir is not provided (fail-safe)', async () => {
    vi.stubEnv('SUDO_SKILL_AUTO_APPLY', '1');
    // No skillsDir passed — 7th ctor param omitted
    const optimizer = new SkillOptimizer(
      emptyDiscovery, undefined, undefined, store, emptyRegistry,
      makeTierTracker('HIGH'),
      // skillsDir intentionally omitted
    );
    const proposal = makeProposal({
      skillId: 'safe-skill',
      skillName: 'safe-skill',
      proposedValue: 'would-be-applied',
    });
    store.save(proposal);

    const result = await optimizer.autoApplyApproved();
    expect(result).toBe(0);

    // DB status must remain pending — disk-first guarantee
    const stored = store.getById(proposal.id);
    expect(stored?.status).toBe('pending');
  });
});

describe('SkillOptimizationStore.markAutoApplied()', () => {
  it('transitions status from pending to auto-applied', () => {
    const proposal = makeProposal();
    store.save(proposal);

    const updated = store.markAutoApplied(proposal.id);
    expect(updated.status).toBe('auto-applied');
    expect(updated.updatedAt).not.toBe(ISO_NOW);
    expect(updated.id).toBe(proposal.id);

    const fetched = store.getById(proposal.id);
    expect(fetched?.status).toBe('auto-applied');
  });

  it('throws when proposal not found', () => {
    expect(() => store.markAutoApplied('nonexistent-id')).toThrow('Proposal not found');
  });

  it('can save a proposal with status auto-applied directly', () => {
    // Verifies the CHECK constraint includes 'auto-applied'
    const proposal = makeProposal({ status: 'auto-applied' as SkillOptimizationProposal['status'] });
    // Should not throw
    expect(() => store.save(proposal)).not.toThrow();
    const stored = store.getById(proposal.id);
    expect(stored?.status).toBe('auto-applied');
  });
});
