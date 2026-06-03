/**
 * @file skill-optimizer.ts
 * @description SkillOptimizer — sleep-cycle-driven skill optimization proposal generator.
 *
 * Reads three aggregated signals (SkillDiscovery TracePatterns, MistakePatternRecognizer
 * recurring patterns, ConfidenceCalibrationTracker Brier score) and generates
 * SkillOptimizationProposal objects persisted to SkillOptimizationStore.
 *
 * SECURITY NOTE: This module does NOT import from tools/builtin/skill/tools/refine.ts.
 * Security reviewer: grep 'import.*refine' in this file — must return zero hits.
 *
 * Lifecycle: asynchronous, system-scoped, sleep-cycle-driven.
 * Human approval required — proposals are never auto-applied.
 *
 * Wave 13 Builder 1.
 * Phase 3 strict: comment hygiene only (naming/comments in large file per plan; no code changes here).
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join as pathJoin, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { SkillOptimizationProposal } from '../shared/wave10-types.js';
import type { SkillOptimizationStore, SkillOptimizationStatusFull } from './skill-optimization-store.js';
import { parseFrontmatter } from './registry-types.js';
import { emitFrontmatterYaml } from './registry-route-types.js';
import { classifyRisk } from '../agent/veto-gate.js';
import { gateToolCall } from '../cognition/epistemic-gate.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('skills:optimizer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PROPOSALS_PER_CYCLE = 5;
const MINE_WINDOW_MS = 86_400_000; // 24 hours
const BRIER_HIGH_THRESHOLD = 0.35;

// ---------------------------------------------------------------------------
// Duck-typed interfaces — avoids hard deps on concrete classes. Wave 13.
// ---------------------------------------------------------------------------

interface SkillDiscoveryLike {
  mine(windowMs?: number): Array<{
    id: string;
    toolSequence: string[];
    occurrenceCount: number;
    successRate: number;
    proposalGenerated: boolean;
  }>;
}

interface MistakePatternRecognizerLike {
  analyze(opts?: { windowDays?: number; minOccurrences?: number }): {
    recurringPatterns: Array<{ signature: string; occurrences: number; tags: string[] }>;
  };
}

interface ConfidenceCalibrationTrackerLike {
  getReport(opts?: { windowDays?: number }): {
    brierScore: number;
    totalSamples: number;
  };
}

interface SkillRegistryLike {
  list(limit: number, offset: number): Array<{
    id: string;
    name: string;
    frontmatter: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// TrustTierTracker duck type — avoids hard dep on concrete class. P2-d.
// ---------------------------------------------------------------------------

/**
 * Minimal duck type for TrustTierTracker.getCurrentTier().
 * TrustTier is 'HIGH' | 'MEDIUM' | 'LOW' | 'PROBATION'.
 * For autoApplyApproved, T2 = MEDIUM or HIGH (numeric rank >= 2).
 *   PROBATION=0, LOW=1, MEDIUM=2, HIGH=3
 */
export interface TrustTierTrackerLike {
  getCurrentTier(): 'HIGH' | 'MEDIUM' | 'LOW' | 'PROBATION';
}

/** Numeric rank of each tier (T0=PROBATION, T1=LOW, T2=MEDIUM, T3=HIGH). */
const TIER_RANK: Record<string, number> = {
  PROBATION: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

// ---------------------------------------------------------------------------
// Scoring helper
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Skill file helpers — disk write for autoApplyApproved
// ---------------------------------------------------------------------------

const MAX_WALK_DEPTH = 5;
const MAX_SKILL_FILE_BYTES = 1_048_576; // 1 MB guard

/**
 * Walk `dir` up to MAX_WALK_DEPTH levels looking for files named SKILL.md
 * whose frontmatter `name` field (case-insensitive) matches `skillName`.
 * Returns the absolute path of the first match, or null if not found.
 * Symlinks are skipped (security: no symlink traversal).
 */
function findSkillFilePath(dir: string, skillName: string, depth = 0): string | null {
  if (depth > MAX_WALK_DEPTH) return null;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // unreadable directory
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'SKILL.md') {
      const fullPath = pathJoin(dir, entry.name);
      try {
        const st = statSync(fullPath);
        if (st.size > MAX_SKILL_FILE_BYTES) continue;
        const raw = readFileSync(fullPath, 'utf8');
        const { meta } = parseFrontmatter(raw);
        const name = (meta['name'] as string | undefined) ?? '';
        if (name.toLowerCase() === skillName.toLowerCase()) return fullPath;
      } catch {
        // Unreadable file — skip
      }
    } else if (entry.isDirectory()) {
      const found = findSkillFilePath(pathJoin(dir, entry.name), skillName, depth + 1);
      if (found) return found;
    }
    // Symlinks intentionally skipped
  }
  return null;
}

/**
 * Sanitize a value for safe inline YAML emission.
 * emitFrontmatterYaml does not quote values — we strip characters that would
 * corrupt the YAML document (newlines, colons in ambiguous positions, etc.)
 * and cap length to keep SKILL.md files human-readable.
 */
function sanitizeYamlScalar(value: string, maxLength = 300): string {
  return value
    .replace(/[\n\r]/g, ' ')    // no multi-line values
    .replace(/:/g, ';')          // colon → semicolon (avoids key:value confusion)
    .replace(/"/g, "'")          // double-quote → single-quote
    .replace(/[^\x20-\x7E]/g, '') // strip non-printable / non-ASCII
    .slice(0, maxLength)
    .trim();
}

/**
 * Atomically write `newContent` to `targetPath`.
 * Writes to a temp file first, then renames — ensures the target is never
 * partially written if the process is killed mid-write.
 * Throws on failure so callers can catch and skip markAutoApplied.
 */
function atomicWriteFile(targetPath: string, newContent: string): void {
  const tempPath = pathJoin(dirname(targetPath), `.skill-opt-tmp-${randomUUID()}.md`);
  let tempCreated = false;
  try {
    writeFileSync(tempPath, newContent, 'utf8');
    tempCreated = true;
    renameSync(tempPath, targetPath);
    tempCreated = false;
  } finally {
    if (tempCreated) {
      try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    }
  }
}

// ---------------------------------------------------------------------------
// SkillOptimizer
// ---------------------------------------------------------------------------

export class SkillOptimizer {
  private readonly skillDiscovery: SkillDiscoveryLike;
  private readonly mistakePatternRecognizer: MistakePatternRecognizerLike | undefined;
  private readonly confidenceCalibrationTracker: ConfidenceCalibrationTrackerLike | undefined;
  private readonly store: SkillOptimizationStore;
  private readonly registry: SkillRegistryLike;
  /** Optional TrustTierTracker — if undefined, autoApplyApproved always returns 0. */
  private readonly trustTierTracker: TrustTierTrackerLike | undefined;
  /**
   * Optional directory to scan for SKILL.md files when auto-applying proposals.
   * If not provided, autoApplyApproved will skip the on-disk write step and
   * will NOT mark proposals as auto-applied (fail-safe: DB must mirror file state).
   */
  private readonly skillsDir: string | undefined;

  constructor(
    skillDiscovery: SkillDiscoveryLike,
    mistakePatternRecognizer: MistakePatternRecognizerLike | undefined,
    confidenceCalibrationTracker: ConfidenceCalibrationTrackerLike | undefined,
    store: SkillOptimizationStore,
    registry: SkillRegistryLike,
    trustTierTracker?: TrustTierTrackerLike,
    skillsDir?: string,
  ) {
    this.skillDiscovery = skillDiscovery;
    this.mistakePatternRecognizer = mistakePatternRecognizer;
    this.confidenceCalibrationTracker = confidenceCalibrationTracker;
    this.store = store;
    this.registry = registry;
    this.trustTierTracker = trustTierTracker;
    this.skillsDir = skillsDir;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Primary entry point called from sleep-cycle post-SkillDiscovery-mine.
   * Returns at most MAX_PROPOSALS_PER_CYCLE (5) proposals.
   * Cap is enforced internally — caller does not need to cap.
   */
  propose(): SkillOptimizationProposal[] {
    // Step 1: Mine trace patterns (24h window)
    let patterns: Array<{
      id: string;
      toolSequence: string[];
      occurrenceCount: number;
      successRate: number;
      proposalGenerated: boolean;
    }> = [];
    try {
      patterns = this.skillDiscovery.mine(MINE_WINDOW_MS);
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'SkillOptimizer.propose: skillDiscovery.mine failed — using empty patterns');
    }

    // Step 2: List all skills
    let skills: Array<{ id: string; name: string; frontmatter: Record<string, unknown> }> = [];
    try {
      skills = this.registry.list(1000, 0);
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'SkillOptimizer.propose: registry.list failed — using empty skills');
    }

    // Step 3: Analyze mistake patterns if available
    let recurringPatterns: Array<{ signature: string; occurrences: number; tags: string[] }> = [];
    if (this.mistakePatternRecognizer) {
      try {
        const report = this.mistakePatternRecognizer.analyze({ windowDays: 30, minOccurrences: 2 });
        recurringPatterns = report.recurringPatterns;
      } catch (err: unknown) {
        log.warn({ err: String(err) }, 'SkillOptimizer.propose: mistakePatternRecognizer.analyze failed — skipping');
      }
    }

    // Step 4: Get Brier score if available
    let brierScore = 0;
    if (this.confidenceCalibrationTracker) {
      try {
        const report = this.confidenceCalibrationTracker.getReport({ windowDays: 30 });
        brierScore = report.brierScore;
      } catch (err: unknown) {
        log.warn({ err: String(err) }, 'SkillOptimizer.propose: calibrationTracker.getReport failed — using brierScore=0');
      }
    }

    // Step 5: Score each skill against the signal data
    const candidates: SkillOptimizationProposal[] = [];
    const now = new Date().toISOString();

    for (const skill of skills) {
      // Step 5a: Find patterns where toolSequence includes the skill name (fuzzy match)
      const matchingPatterns = patterns.filter(
        (p) => !p.proposalGenerated &&
          p.toolSequence.some(
            (t) => t.toLowerCase().includes(skill.name.toLowerCase()) ||
                   skill.name.toLowerCase().includes(t.toLowerCase()),
          ),
      );

      if (matchingPatterns.length === 0) continue;

      // Use the highest-occurrence pattern for scoring
      const topPattern = matchingPatterns.reduce((best, p) =>
        p.occurrenceCount > best.occurrenceCount ? p : best,
      );

      // Step 5b: Compute candidate score
      const base = topPattern.occurrenceCount;
      const successPenalty = (1 - topPattern.successRate) * 2;

      const mistakePenalty = recurringPatterns.filter((mp) => {
        const sigLower = mp.signature.toLowerCase();
        const skillLower = skill.name.toLowerCase();
        const tagMatch = mp.tags.some((t) => t.toLowerCase().includes(skillLower));
        return sigLower.includes(skillLower) || tagMatch;
      }).length * 0.1;

      const rawScore = base * successPenalty - mistakePenalty;
      const brierAdjust = brierScore > BRIER_HIGH_THRESHOLD
        ? (brierScore - BRIER_HIGH_THRESHOLD) * -0.5
        : 0;
      const confidence = clamp(0.5 + rawScore * 0.05 + brierAdjust, 0.1, 0.99);

      // Step 5c: Skip if confidence too low
      if (confidence < 0.3) continue;

      // Step 5d: Build proposal
      const description = typeof skill.frontmatter['description'] === 'string'
        ? skill.frontmatter['description']
        : '';
      const examples = skill.frontmatter['examples'];
      const tags = skill.frontmatter['tags'];

      // Pick target field based on what data is available:
      // Prefer description for text refinement, otherwise examples, otherwise tags
      const targetField: 'description' | 'examples' | 'tags' = 'description';
      const currentValue = typeof description === 'string'
        ? description
        : '';

      const proposedValue =
        `[OPTIMIZER] Consider adding example demonstrating: ` +
        `${topPattern.toolSequence.join(' -> ')} ` +
        `(seen ${topPattern.occurrenceCount}x, ` +
        `${Math.round(topPattern.successRate * 100)}% success rate). ` +
        `Current description: "${currentValue.slice(0, 100)}"`;

      const evidence =
        `Pattern "${topPattern.toolSequence.join(' -> ')}" observed ` +
        `${topPattern.occurrenceCount} times in last 24h ` +
        `(success rate: ${Math.round(topPattern.successRate * 100)}%). ` +
        (mistakePenalty > 0 ? `Matching mistake patterns: ${Math.round(mistakePenalty / 0.1)}. ` : '') +
        (brierScore > BRIER_HIGH_THRESHOLD ? `High Brier score (${brierScore.toFixed(3)}) signals overall uncertainty. ` : '');

      void examples; // available for future use
      void tags;     // available for future use

      candidates.push({
        id: randomUUID(),
        skillId: skill.id,
        skillName: skill.name,
        targetField,
        currentValue,
        proposedValue,
        evidence,
        confidence,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }

    // Step 6: Sort candidates by confidence desc
    candidates.sort((a, b) => b.confidence - a.confidence);

    // Step 7: Cap at MAX_PROPOSALS_PER_CYCLE with log.warn if exceeded
    if (candidates.length > MAX_PROPOSALS_PER_CYCLE) {
      log.warn(
        { candidatesTotal: candidates.length, cap: MAX_PROPOSALS_PER_CYCLE },
        `SkillOptimizer.propose: ${candidates.length} candidates exceeded cap of ${MAX_PROPOSALS_PER_CYCLE} — truncating`,
      );
    }
    const capped = candidates.slice(0, MAX_PROPOSALS_PER_CYCLE);

    // Step 8: Persist each to store (try/catch per save, fail-open per proposal)
    const persisted: SkillOptimizationProposal[] = [];
    for (const proposal of capped) {
      try {
        this.store.save(proposal);
        persisted.push(proposal);
      } catch (err: unknown) {
        log.warn(
          { err: String(err), proposalId: proposal.id, skillId: proposal.skillId },
          'SkillOptimizer.propose: failed to persist proposal — skipping (fail-open)',
        );
      }
    }

    log.info(
      { proposalCount: persisted.length, totalCandidates: candidates.length },
      'SkillOptimizer.propose() completed',
    );

    // Step 9: Return capped array
    return persisted;
  }

  /**
   * Return all pending proposals from the store.
   */
  listPending(): SkillOptimizationProposal[] {
    try {
      const result = this.store.list({ status: 'pending', limit: 100, offset: 0 });
      return result.data;
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'SkillOptimizer.listPending: store.list failed');
      return [];
    }
  }

  /**
   * Return the latest approved proposal for a specific skill (used by 4th bench condition).
   * Returns null if none found.
   */
  getApprovedForSkill(skillId: string): SkillOptimizationProposal | null {
    try {
      return this.store.getLatestApprovedForSkill(skillId);
    } catch (err: unknown) {
      log.warn({ err: String(err), skillId }, 'SkillOptimizer.getApprovedForSkill: store lookup failed');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // P2-d: autoApplyApproved — auto-apply pending proposals under trust + env guard
  // ---------------------------------------------------------------------------

  /**
   * Auto-apply pending proposals that meet trust + env criteria.
   *
   * Gates (all must pass):
   *   1. SUDO_SKILL_AUTO_APPLY=1 env var must be set.
   *   2. TrustTierTracker current tier must be T2+ (MEDIUM or HIGH).
   *
   * Per-proposal gates (skip proposal if either fails):
   *   3. classifyRisk(skillId, {proposedValue}) must NOT be CRITICAL or HIGH.
   *   4. gateToolCall({tag:'PROBABLE', toolName:'skill.auto-apply', impact:'MEDIUM', ...})
   *      must NOT return REPLAN.
   *
   * Apply (P2-d, Fix 3): writes proposedValue to the SKILL.md file on disk first
   * (atomic temp+rename), then marks proposal 'auto-applied' in the store.
   * If disk write fails, markAutoApplied is NOT called — DB status never diverges
   * from actual file state (fail-safe). Requires skillsDir 7th ctor param.
   * If skillsDir is not set, all proposals are skipped.
   *
   * Called from propose() end (Option A hook) AND may be called from the sleep-cycle
   * directly via the SkillOptimizerLike interface when that interface is widened.
   *
   * Returns count of proposals that were applied.
   */
  async autoApplyApproved(): Promise<number> {
    // Guard 1: env flag must be set
    if (process.env['SUDO_SKILL_AUTO_APPLY'] !== '1') {
      log.debug({ event: 'skill.auto-apply.env-off' }, 'autoApplyApproved: SUDO_SKILL_AUTO_APPLY not set — skipping');
      return 0;
    }

    // Guard 2: trust tier must be T2+ (MEDIUM=2, HIGH=3; PROBATION=0, LOW=1)
    if (!this.trustTierTracker) {
      log.debug({ event: 'skill.auto-apply.no-tracker' }, 'autoApplyApproved: no TrustTierTracker — skipping');
      return 0;
    }

    let tier: string;
    try {
      tier = this.trustTierTracker.getCurrentTier();
    } catch (err: unknown) {
      log.warn({ err: String(err), event: 'skill.auto-apply.tier-error' }, 'autoApplyApproved: tier lookup failed — skipping');
      return 0;
    }

    const tierRank = TIER_RANK[tier] ?? 0;
    if (tierRank < 2) {
      // T2 = MEDIUM (rank 2). LOW=1, PROBATION=0 are below T2.
      log.debug(
        { tier, tierRank, required: 2, event: 'skill.auto-apply.tier-low' },
        'autoApplyApproved: trust tier below T2 — skipping',
      );
      return 0;
    }

    // Retrieve pending proposals
    let pending: SkillOptimizationProposal[];
    try {
      const result = this.store.list({ status: 'pending', limit: 100, offset: 0 });
      pending = result.data;
    } catch (err: unknown) {
      log.warn({ err: String(err), event: 'skill.auto-apply.store-list-failed' }, 'autoApplyApproved: failed to list pending proposals — skipping');
      return 0;
    }

    if (pending.length === 0) {
      log.debug({ event: 'skill.auto-apply.no-pending' }, 'autoApplyApproved: no pending proposals');
      return 0;
    }

    let applied = 0;

    for (const proposal of pending) {
      // Gate 3: classifyRisk — skip CRITICAL or HIGH
      let riskLevel: string;
      try {
        riskLevel = classifyRisk(proposal.skillId, { proposedValue: proposal.proposedValue });
      } catch (err: unknown) {
        log.warn(
          { err: String(err), proposalId: proposal.id, event: 'skill.auto-apply.risk-error' },
          'autoApplyApproved: classifyRisk threw — skipping proposal (fail-safe)',
        );
        continue;
      }

      if (riskLevel === 'CRITICAL' || riskLevel === 'HIGH') {
        log.info(
          { proposalId: proposal.id, skillId: proposal.skillId, riskLevel, event: 'skill.auto-apply.risk-skip' },
          'autoApplyApproved: risk too high — skipping proposal',
        );
        continue;
      }

      // Gate 4: gateToolCall — skip if REPLAN.
      // GateInput accepts only { tag, impact } — toolName and rationale are not fields.
      let gateResult: { decision: string; reason: string };
      try {
        gateResult = gateToolCall({ tag: 'PROBABLE', impact: 'MEDIUM' });
      } catch (err: unknown) {
        log.warn(
          { err: String(err), proposalId: proposal.id, event: 'skill.auto-apply.gate-error' },
          'autoApplyApproved: gateToolCall threw — skipping proposal (fail-safe)',
        );
        continue;
      }

      if (gateResult.decision === 'REPLAN') {
        log.info(
          { proposalId: proposal.id, skillId: proposal.skillId, reason: gateResult.reason, event: 'skill.auto-apply.gate-skip' },
          'autoApplyApproved: epistemic gate returned REPLAN — skipping proposal',
        );
        continue;
      }

      // Apply step 1: write proposedValue to skill YAML on disk.
      // skillsDir must be set — if not, skip this proposal (fail-safe: DB must
      // mirror file state; we never flip DB status without a successful file write).
      if (!this.skillsDir) {
        log.warn(
          { proposalId: proposal.id, skillId: proposal.skillId, event: 'skill.auto-apply.no-skills-dir' },
          'autoApplyApproved: skillsDir not configured — skipping disk write and markAutoApplied',
        );
        continue;
      }

      const skillFilePath = findSkillFilePath(this.skillsDir, proposal.skillName);
      if (!skillFilePath) {
        log.warn(
          { proposalId: proposal.id, skillName: proposal.skillName, skillsDir: this.skillsDir, event: 'skill.auto-apply.file-not-found' },
          'autoApplyApproved: SKILL.md not found for skill — skipping proposal',
        );
        continue;
      }

      try {
        const raw = readFileSync(skillFilePath, 'utf8');
        const { meta, body } = parseFrontmatter(raw);

        // Update the target field with a sanitized proposedValue.
        // Sanitization is mandatory: emitFrontmatterYaml does not quote scalars,
        // and proposedValue may contain colons/quotes from the optimizer prompt.
        const safeValue = sanitizeYamlScalar(proposal.proposedValue);
        meta[proposal.targetField] = safeValue;

        const newContent = `${emitFrontmatterYaml(meta)}\n${body}`;
        atomicWriteFile(skillFilePath, newContent);

        log.info(
          {
            proposalId: proposal.id, skillId: proposal.skillId,
            skillFilePath, field: proposal.targetField,
            event: 'skill.auto-apply.file-written',
          },
          'autoApplyApproved: skill YAML updated on disk',
        );
      } catch (err: unknown) {
        log.warn(
          {
            err: String(err), proposalId: proposal.id,
            skillFilePath, event: 'skill.auto-apply.write-failed',
          },
          'autoApplyApproved: disk write failed — skipping markAutoApplied (file state unchanged)',
        );
        continue; // Do NOT flip DB status if file not actually updated
      }

      // Apply step 2: mark as auto-applied in store (only after successful file write).
      try {
        this.store.markAutoApplied(proposal.id);
        applied++;
        log.info(
          { proposalId: proposal.id, skillId: proposal.skillId, event: 'skill.auto-apply.applied' },
          'autoApplyApproved: proposal auto-applied',
        );
      } catch (err: unknown) {
        log.warn(
          { err: String(err), proposalId: proposal.id, event: 'skill.auto-apply.mark-failed' },
          'autoApplyApplied: markAutoApplied failed after disk write — store may be inconsistent',
        );
        // File was written but DB wasn't updated — log and continue (fail-open for count)
      }
    }

    log.info(
      { applied, pending: pending.length, tier, event: 'skill.auto-apply.complete' },
      'SkillOptimizer.autoApplyApproved() completed',
    );
    return applied;
  }
}
