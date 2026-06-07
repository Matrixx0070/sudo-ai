/**
 * @file self-improvement-guard.ts
 * @description Self-Improvement Safety Guard for SUDO-AI v4.
 *
 * Hermes's #1 community complaint: self-evaluation is unreliable and
 * auto-generated skills overwrite hand-edited files without consent.
 * "It almost always thinks it did a good job even when it did not."
 *
 * This module prevents that failure mode by:
 *   1. Human confirmation gate before any auto-generated skill replaces existing content
 *   2. Diff viewer showing what would change
 *   3. Rollback capability for rejected auto-improvements
 *   4. Confidence threshold — only auto-apply if confidence > 95%
 *   5. Protected files list that can NEVER be auto-modified
 *   6. Rate limiting — max N auto-improvements per session
 *
 * This is SUDO-AI's key differentiator vs Hermes: self-improvement
 * that respects human authorship.
 */

import { createLogger } from '../shared/logger.js';
import { genId, contentHash } from '../shared/utils.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const log = createLogger('learning:self-improvement-guard');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Status of a proposed improvement. */
export type ImprovementStatus = 'pending' | 'approved' | 'rejected' | 'auto_applied' | 'rolled_back';

/** A proposed self-improvement awaiting review. */
export interface ProposedImprovement {
  id: string;
  type: 'skill_update' | 'config_change' | 'code_patch' | 'memory_update';
  description: string;
  targetFile: string;
  originalHash: string;
  proposedContent: string;
  confidence: number; // 0-100
  source: string; // what triggered this improvement
  status: ImprovementStatus;
  reviewedBy?: string;
  reviewNote?: string;
  createdAt: string;
  reviewedAt?: string;
}

/** Result of an improvement review. */
export interface ReviewResult {
  improvementId: string;
  action: 'approve' | 'reject' | 'defer';
  note?: string;
  reviewer: string;
}

/** Diff between original and proposed content. */
export interface ContentDiff {
  file: string;
  additions: number;
  deletions: number;
  changes: number;
  linesAdded: string[];
  linesRemoved: string[];
  summary: string;
}

/** Configuration for the safety guard. */
export interface SafetyGuardConfig {
  enabled: boolean;
  /** Minimum confidence (0-100) to auto-apply without human review. */
  autoApplyThreshold: number;
  /** Files that can NEVER be auto-modified (regex patterns). */
  protectedFiles: string[];
  /** Maximum auto-improvements per session. */
  maxAutoImprovementsPerSession: number;
  /** Maximum pending improvements to hold. */
  maxPendingImprovements: number;
  /** Whether to keep rollback snapshots. */
  keepRollbackSnapshots: boolean;
  /** Directory for storing rollback snapshots. */
  rollbackDir: string;
  /** Kill-switch: completely disable self-improvement. */
  killSwitch: boolean;
}

const DEFAULT_CONFIG: Readonly<SafetyGuardConfig> = {
  enabled: true,
  autoApplyThreshold: 95,
  protectedFiles: [
    'SOUL\\.md',
    'MEMORY\\.md',
    'HEARTBEAT\\.md',
    'KAIROS_ALERTS\\.md',
    '\\.env',
    '\\.env\\..*',
    'ecosystem\\.config\\..*',
    'config/sudo-ai\\.toml',
    'src/core/security/.*',
    'src/core/auth/.*',
  ],
  maxAutoImprovementsPerSession: 5,
  maxPendingImprovements: 50,
  keepRollbackSnapshots: true,
  rollbackDir: 'data/rollbacks',
  killSwitch: false,
};

// ---------------------------------------------------------------------------
// SelfImprovementGuard
// ---------------------------------------------------------------------------

/**
 * Safety guard for self-improvement operations.
 *
 * Prevents Hermes's #1 failure mode: auto-generated skills overwriting
 * hand-edited files without consent. In SUDO-AI, all self-improvements
 * either pass a 95% confidence threshold or require human confirmation.
 */
export class SelfImprovementGuard {
  private readonly config: Readonly<SafetyGuardConfig>;
  private readonly pending: Map<string, ProposedImprovement> = new Map();
  private readonly history: ProposedImprovement[] = [];
  private sessionAutoImprovements: number = 0;

  constructor(config?: Partial<SafetyGuardConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.keepRollbackSnapshots) {
      try {
        mkdirSync(this.config.rollbackDir, { recursive: true });
      } catch {
        log.warn({ dir: this.config.rollbackDir }, 'Cannot create rollback directory');
      }
    }

    log.info(
      {
        enabled: this.config.enabled,
        autoApplyThreshold: this.config.autoApplyThreshold,
        protectedFiles: this.config.protectedFiles.length,
        killSwitch: this.config.killSwitch,
      },
      'SelfImprovementGuard initialized',
    );
  }

  // -------------------------------------------------------------------------
  // Core API
  // -------------------------------------------------------------------------

  /**
   * Propose a self-improvement. Returns the proposed improvement
   * with status 'pending' (needs human review) or 'auto_applied'
   * (confidence exceeds threshold and file is not protected).
   *
   * This is the gate that Hermes doesn't have. In Hermes, auto-generated
   * skills replace files without consent. Here, they wait for approval
   * unless confidence is extremely high AND the file is unprotected.
   */
  propose(improvement: Omit<ProposedImprovement, 'id' | 'status' | 'createdAt'>): ProposedImprovement {
    // Kill-switch check
    if (this.config.killSwitch || !this.config.enabled) {
      log.warn('Self-improvement is disabled via kill-switch or config');
      return {
        ...improvement,
        id: genId(),
        status: 'rejected',
        reviewNote: 'Self-improvement disabled via kill-switch',
        createdAt: new Date().toISOString(),
      };
    }

    // Protected file check
    if (this._isProtectedFile(improvement.targetFile)) {
      log.warn(
        { file: improvement.targetFile },
        'Proposed improvement targets a protected file — requires human review',
      );

      const proposed: ProposedImprovement = {
        ...improvement,
        id: genId(),
        status: 'pending',
        reviewNote: 'Protected file — human confirmation required',
        createdAt: new Date().toISOString(),
      };

      this._addToPending(proposed);
      return proposed;
    }

    // Session limit check
    if (this.sessionAutoImprovements >= this.config.maxAutoImprovementsPerSession) {
      const proposed: ProposedImprovement = {
        ...improvement,
        id: genId(),
        status: 'pending',
        reviewNote: `Session auto-apply limit reached (${this.config.maxAutoImprovementsPerSession})`,
        createdAt: new Date().toISOString(),
      };

      this._addToPending(proposed);
      return proposed;
    }

    // Confidence check — only auto-apply if very high confidence
    if (improvement.confidence >= this.config.autoApplyThreshold) {
      log.info(
        { file: improvement.targetFile, confidence: improvement.confidence },
        'Auto-applying high-confidence improvement',
      );

      const proposed: ProposedImprovement = {
        ...improvement,
        id: genId(),
        status: 'auto_applied',
        reviewedBy: 'auto_guard',
        reviewNote: `Auto-applied: confidence ${improvement.confidence}% >= threshold ${this.config.autoApplyThreshold}%`,
        createdAt: new Date().toISOString(),
        reviewedAt: new Date().toISOString(),
      };

      // Save rollback snapshot before applying
      if (this.config.keepRollbackSnapshots) {
        this._saveRollbackSnapshot(proposed);
      }

      this.sessionAutoImprovements++;
      this.history.push(proposed);
      return proposed;
    }

    // Below threshold — needs human review
    const proposed: ProposedImprovement = {
      ...improvement,
      id: genId(),
      status: 'pending',
      reviewNote: `Confidence ${improvement.confidence}% < threshold ${this.config.autoApplyThreshold}% — human review required`,
      createdAt: new Date().toISOString(),
    };

    this._addToPending(proposed);
    return proposed;
  }

  /**
   * Review a pending improvement.
   * Human-in-the-loop confirmation gate.
   */
  review(result: ReviewResult): ProposedImprovement | null {
    const improvement = this.pending.get(result.improvementId);
    if (!improvement) {
      log.warn({ id: result.improvementId }, 'Improvement not found for review');
      return null;
    }

    improvement.reviewedBy = result.reviewer;
    improvement.reviewNote = result.note;
    improvement.reviewedAt = new Date().toISOString();

    switch (result.action) {
      case 'approve':
        improvement.status = 'approved';

        // Save rollback snapshot before applying
        if (this.config.keepRollbackSnapshots) {
          this._saveRollbackSnapshot(improvement);
        }

        log.info(
          { id: improvement.id, file: improvement.targetFile, reviewer: result.reviewer },
          'Improvement approved',
        );
        break;

      case 'reject':
        improvement.status = 'rejected';
        log.info(
          { id: improvement.id, file: improvement.targetFile, reviewer: result.reviewer },
          'Improvement rejected',
        );
        break;

      case 'defer':
        // Keep in pending, just add note
        improvement.reviewNote = result.note ?? 'Deferred';
        log.info({ id: improvement.id }, 'Improvement deferred');
        return improvement;
    }

    this.pending.delete(result.improvementId);
    this.history.push(improvement);

    return improvement;
  }

  /**
   * Roll back an applied improvement.
   * Restores the original file content from the snapshot.
   */
  rollback(improvementId: string): boolean {
    const improvement = this.history.find(i => i.id === improvementId);
    if (!improvement) {
      log.warn({ id: improvementId }, 'Improvement not found for rollback');
      return false;
    }

    if (improvement.status !== 'approved' && improvement.status !== 'auto_applied') {
      log.warn({ id: improvementId, status: improvement.status }, 'Cannot rollback non-applied improvement');
      return false;
    }

    // Read rollback snapshot
    const snapshotPath = join(this.config.rollbackDir, `${improvementId}.json`);
    if (!existsSync(snapshotPath)) {
      log.warn({ id: improvementId }, 'No rollback snapshot found');
      return false;
    }

    try {
      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as {
        targetFile: string;
        originalContent: string;
        originalHash: string;
      };

      // Verify hash matches
      const currentHash = contentHash(readFileSync(improvement.targetFile, 'utf-8'));
      if (currentHash !== contentHash(snapshot.originalContent) && currentHash !== improvement.originalHash) {
        log.warn(
          { id: improvementId, file: improvement.targetFile },
          'File has been modified since improvement — rollback may lose changes',
        );
      }

      // Restore original content
      writeFileSync(improvement.targetFile, snapshot.originalContent, 'utf-8');

      improvement.status = 'rolled_back';
      improvement.reviewNote = `Rolled back at ${new Date().toISOString()}`;

      log.info({ id: improvementId, file: improvement.targetFile }, 'Improvement rolled back');
      return true;
    } catch (err) {
      log.error({ id: improvementId, err }, 'Rollback failed');
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Query API
  // -------------------------------------------------------------------------

  /**
   * Get all pending improvements awaiting review.
   */
  getPending(): ProposedImprovement[] {
    return Array.from(this.pending.values());
  }

  /**
   * Get improvement history.
   */
  getHistory(limit: number = 50): ProposedImprovement[] {
    return this.history.slice(-limit);
  }

  /**
   * Generate a diff between original and proposed content.
   */
  getDiff(improvementId: string): ContentDiff | null {
    const improvement = this.pending.get(improvementId) ?? this.history.find(i => i.id === improvementId);
    if (!improvement) return null;

    let originalContent: string;
    try {
      originalContent = readFileSync(improvement.targetFile, 'utf-8');
    } catch {
      originalContent = '';
    }

    return this._computeDiff(improvement.targetFile, originalContent, improvement.proposedContent);
  }

  /**
   * Get guard statistics.
   */
  getStats(): {
    totalProposed: number;
    pendingCount: number;
    autoApplied: number;
    humanApproved: number;
    rejected: number;
    rolledBack: number;
    protectedFilesCount: number;
  } {
    const statusCounts = {
      auto_applied: 0,
      approved: 0,
      rejected: 0,
      rolled_back: 0,
    };

    for (const imp of this.history) {
      if (imp.status in statusCounts) {
        (statusCounts as Record<string, number>)[imp.status]++;
      }
    }

    return {
      totalProposed: this.history.length + this.pending.size,
      pendingCount: this.pending.size,
      autoApplied: statusCounts.auto_applied,
      humanApproved: statusCounts.approved,
      rejected: statusCounts.rejected,
      rolledBack: statusCounts.rolled_back,
      protectedFilesCount: this.config.protectedFiles.length,
    };
  }

  /**
   * Check if the kill-switch is active.
   */
  isKillSwitchActive(): boolean {
    return this.config.killSwitch;
  }

  /**
   * Activate or deactivate the kill-switch.
   */
  setKillSwitch(active: boolean): void {
    (this.config as { killSwitch: boolean }).killSwitch = active;
    log.warn({ active }, 'Kill-switch toggled');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _isProtectedFile(filePath: string): boolean {
    for (const pattern of this.config.protectedFiles) {
      try {
        const regex = new RegExp(pattern);
        if (regex.test(filePath)) return true;
      } catch {
        // Invalid regex — skip
      }
    }

    // Also check exact filename matches
    const basename = filePath.split('/').pop() ?? filePath;
    const protectedNames = ['SOUL.md', 'MEMORY.md', '.env', 'HEARTBEAT.md', 'KAIROS_ALERTS.md'];
    if (protectedNames.includes(basename)) return true;

    return false;
  }

  private _addToPending(improvement: ProposedImprovement): void {
    if (this.pending.size >= this.config.maxPendingImprovements) {
      // Remove oldest pending
      const oldest = this.pending.keys().next().value;
      if (oldest) {
        const old = this.pending.get(oldest)!;
        old.status = 'rejected';
        old.reviewNote = 'Evicted: pending queue full';
        this.history.push(old);
        this.pending.delete(oldest);
      }
    }

    this.pending.set(improvement.id, improvement);
    log.info(
      { id: improvement.id, file: improvement.targetFile, confidence: improvement.confidence },
      'Improvement added to pending queue',
    );
  }

  private _saveRollbackSnapshot(improvement: ProposedImprovement): void {
    let originalContent = '';

    try {
      if (existsSync(improvement.targetFile)) {
        originalContent = readFileSync(improvement.targetFile, 'utf-8');
      }
    } catch {
      // File may not exist yet
    }

    const snapshot = {
      improvementId: improvement.id,
      targetFile: improvement.targetFile,
      originalContent,
      originalHash: contentHash(originalContent),
      timestamp: new Date().toISOString(),
    };

    const snapshotPath = join(this.config.rollbackDir, `${improvement.id}.json`);
    try {
      writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch (err) {
      log.warn({ id: improvement.id, err }, 'Failed to save rollback snapshot');
    }
  }

  private _computeDiff(file: string, original: string, proposed: string): ContentDiff {
    const originalLines = original.split('\n');
    const proposedLines = proposed.split('\n');

    const linesAdded: string[] = [];
    const linesRemoved: string[] = [];

    // Simple line-by-line diff
    const maxLen = Math.max(originalLines.length, proposedLines.length);
    for (let i = 0; i < maxLen; i++) {
      const oLine = originalLines[i] ?? '';
      const pLine = proposedLines[i] ?? '';

      if (oLine !== pLine) {
        if (i >= originalLines.length) {
          linesAdded.push(pLine);
        } else if (i >= proposedLines.length) {
          linesRemoved.push(oLine);
        } else {
          linesRemoved.push(oLine);
          linesAdded.push(pLine);
        }
      }
    }

    return {
      file,
      additions: linesAdded.length,
      deletions: linesRemoved.length,
      changes: linesAdded.length + linesRemoved.length,
      linesAdded,
      linesRemoved,
      summary: `+${linesAdded.length} -${linesRemoved.length} lines changed`,
    };
  }
}