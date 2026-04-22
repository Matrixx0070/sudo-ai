/**
 * @file timeline.ts
 * @description TemporalSelf — the AI's sense of growth, change, and aspiration over time.
 * DB I/O → store.ts; level arithmetic → level-utils.ts. Synchronous throughout.
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import { genId } from '../../shared/utils.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { EmotionTag } from '../types.js';
import type { SelfSnapshot, Aspiration, SelfModelLike } from './types.js';
import {
  saveSnapshot,
  getTimeline as storeGetTimeline,
  saveAspiration,
  getAspirations as storeGetAspirations,
  updateAspirationStatus,
} from './store.js';
import { nextLevel, numericToLabel, compareLevels } from './level-utils.js';

const log = createLogger('temporal-self:timeline');

// ---------------------------------------------------------------------------
// TemporalSelf
// ---------------------------------------------------------------------------

export class TemporalSelf {
  private readonly db: ReturnType<ConsciousnessDB['getDb']>;
  private readonly selfModel: SelfModelLike;

  /**
   * @param cdb       - Open ConsciousnessDB instance.
   * @param selfModel - Duck-typed SelfModel-compatible object.
   * @throws ConsciousnessError if either dependency is falsy.
   */
  constructor(cdb: ConsciousnessDB, selfModel: SelfModelLike) {
    if (!cdb) {
      throw new ConsciousnessError(
        'TemporalSelf: cdb must be a ConsciousnessDB instance',
        'consciousness_temporal_self_invalid_db',
      );
    }
    if (!selfModel) {
      throw new ConsciousnessError(
        'TemporalSelf: selfModel must be a SelfModelLike instance',
        'consciousness_temporal_self_invalid_self_model',
      );
    }
    this.db = cdb.getDb();
    this.selfModel = selfModel;
    log.info('TemporalSelf initialised');
  }

  // -------------------------------------------------------------------------
  // takeSnapshot
  // -------------------------------------------------------------------------

  /**
   * Capture the current self-model state and persist it.
   *
   * @param emotionalState - Object containing the current dominantEmotion.
   * @param goals          - Active goal descriptions at snapshot time.
   */
  takeSnapshot(
    emotionalState: { dominantEmotion: EmotionTag },
    goals: string[],
  ): SelfSnapshot {
    if (!emotionalState?.dominantEmotion) {
      throw new ConsciousnessError(
        'takeSnapshot: emotionalState.dominantEmotion is required',
        'consciousness_temporal_self_invalid_emotion',
        { emotionalState },
      );
    }
    if (!Array.isArray(goals)) {
      throw new ConsciousnessError(
        'takeSnapshot: goals must be an array',
        'consciousness_temporal_self_invalid_goals',
      );
    }

    const strengths = this.selfModel.getStrengths(10);
    const weaknesses = this.selfModel.getWeaknesses(10);
    const personality = this.selfModel.getPersonalityTraits();

    const capabilities: Record<string, string> = {};
    for (const cap of [...strengths, ...weaknesses]) {
      capabilities[cap.domain] = numericToLabel(cap.level);
    }

    const snapshot: SelfSnapshot = {
      id: genId(),
      capabilities,
      personality,
      dominantEmotion: emotionalState.dominantEmotion,
      activeGoals: [...goals],
      snapshotAt: new Date().toISOString(),
    };

    saveSnapshot(this.db, snapshot);
    log.info({ id: snapshot.id, domains: Object.keys(capabilities).length }, 'Snapshot taken');
    return snapshot;
  }

  // -------------------------------------------------------------------------
  // getTimeline / getAspirations / markAspiration
  // -------------------------------------------------------------------------

  /** Return the N most recent snapshots in descending order. */
  getTimeline(count: number = 10): SelfSnapshot[] {
    if (typeof count !== 'number' || count < 1 || !Number.isFinite(count)) {
      throw new ConsciousnessError(
        'getTimeline: count must be a positive finite number',
        'consciousness_temporal_self_invalid_count',
        { count },
      );
    }
    return storeGetTimeline(this.db, count);
  }

  /** Return all persisted aspirations (all statuses). */
  getAspirations(): Aspiration[] { return storeGetAspirations(this.db); }

  // -------------------------------------------------------------------------
  // generateAspirations
  // -------------------------------------------------------------------------

  /**
   * Derive new aspirations from weaknesses and growth areas, persist and return them.
   * Skips domains that already have an 'active' aspiration.
   */
  generateAspirations(): Aspiration[] {
    const existingActive = storeGetAspirations(this.db, 'active');
    const activeDomains = new Set(existingActive.map((a) => a.domain));
    const now = new Date().toISOString();
    const created: Aspiration[] = [];

    for (const cap of this.selfModel.getWeaknesses(5)) {
      if (activeDomains.has(cap.domain)) continue;
      const currentLabel = numericToLabel(cap.level);
      const targetLabel = nextLevel(currentLabel);
      if (currentLabel === targetLabel) continue;
      const asp = this._buildAspiration(cap.domain, currentLabel, targetLabel, '3 months', now);
      saveAspiration(this.db, asp);
      activeDomains.add(cap.domain);
      created.push(asp);
      log.debug({ domain: cap.domain, currentLabel, targetLabel }, 'Aspiration from weakness');
    }

    for (const cap of this.selfModel.getGrowthAreas()) {
      if (activeDomains.has(cap.domain)) continue;
      const currentLabel = numericToLabel(cap.level);
      if (currentLabel === 'expert') continue;
      const asp = this._buildAspiration(cap.domain, currentLabel, 'expert', '6 months', now);
      saveAspiration(this.db, asp);
      activeDomains.add(cap.domain);
      created.push(asp);
      log.debug({ domain: cap.domain, currentLabel }, 'Aspiration from growth area');
    }

    log.info({ generated: created.length }, 'Aspirations generated');
    return created;
  }

  // -------------------------------------------------------------------------
  // comparePastToPresent
  // -------------------------------------------------------------------------

  /**
   * Compare the snapshot closest to `daysAgo` days ago against current state.
   *
   * @param daysAgo - Look-back window in days (positive integer).
   */
  comparePastToPresent(
    daysAgo: number,
  ): { improved: string[]; declined: string[]; stable: string[] } {
    if (typeof daysAgo !== 'number' || daysAgo < 1 || !Number.isFinite(daysAgo)) {
      throw new ConsciousnessError(
        'comparePastToPresent: daysAgo must be a positive finite number',
        'consciousness_temporal_self_invalid_days',
        { daysAgo },
      );
    }

    const allSnapshots = storeGetTimeline(this.db, 100);
    const targetMs = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
    const past = this._closestSnapshot(allSnapshots, targetMs);

    const currentCaps: Record<string, string> = {};
    for (const cap of [
      ...this.selfModel.getStrengths(20),
      ...this.selfModel.getWeaknesses(20),
    ]) {
      currentCaps[cap.domain] = numericToLabel(cap.level);
    }

    if (!past) {
      return { improved: [], declined: [], stable: Object.keys(currentCaps) };
    }

    const improved: string[] = [];
    const declined: string[] = [];
    const stable: string[] = [];
    const allDomains = new Set([...Object.keys(past.capabilities), ...Object.keys(currentCaps)]);

    for (const domain of allDomains) {
      const pastLevel = past.capabilities[domain];
      const nowLevel = currentCaps[domain];
      if (!pastLevel || !nowLevel) {
        if (nowLevel && !pastLevel) improved.push(domain);
        continue;
      }
      const diff = compareLevels(nowLevel, pastLevel);
      if (diff > 0) improved.push(domain);
      else if (diff < 0) declined.push(domain);
      else stable.push(domain);
    }

    log.debug({ daysAgo, improved: improved.length, declined: declined.length }, 'Comparison done');
    return { improved, declined, stable };
  }

  // -------------------------------------------------------------------------
  // toPromptSummary
  // -------------------------------------------------------------------------

  /**
   * Produce a concise narrative for system-prompt injection.
   * Format: "Past: [...]. Present: [...]. Future: [...]."
   */
  toPromptSummary(): string {
    const past = this._pastSummary();
    const present = this._presentSummary();
    const future = this._futureSummary();
    return `${past} ${present} ${future}`;
  }

  /** Mark an aspiration as achieved or abandoned. */
  markAspiration(id: string, status: 'active' | 'achieved' | 'abandoned'): void {
    updateAspirationStatus(this.db, id, status);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _buildAspiration(
    domain: string,
    currentLevel: string,
    targetLevel: string,
    timeframe: string,
    now: string,
  ): Aspiration {
    return {
      id: genId(),
      description: `Improve ${domain} from ${currentLevel} to ${targetLevel}`,
      currentLevel,
      targetLevel,
      domain,
      estimatedTimeframe: timeframe,
      status: 'active',
      createdAt: now,
    };
  }

  private _closestSnapshot(snapshots: SelfSnapshot[], targetMs: number): SelfSnapshot | null {
    return snapshots.reduce<SelfSnapshot | null>((best, s) => {
      const diff = Math.abs(new Date(s.snapshotAt).getTime() - targetMs);
      if (!best) return s;
      return diff < Math.abs(new Date(best.snapshotAt).getTime() - targetMs) ? s : best;
    }, null);
  }

  private _pastSummary(): string {
    try {
      const { improved, declined } = this.comparePastToPresent(7);
      const parts: string[] = [];
      if (improved.length > 0) parts.push(`improved in ${improved.slice(0, 3).join(', ')}`);
      if (declined.length > 0) parts.push(`declined in ${declined.slice(0, 3).join(', ')}`);
      return `Past: ${parts.length > 0 ? parts.join('; ') : 'no significant changes'}.`;
    } catch { return 'Past: no history available.'; }
  }

  private _presentSummary(): string {
    const s = this.selfModel.getStrengths(3);
    const p = this.selfModel.getPersonalityTraits();
    const sStr = s.length > 0 ? s.map((x) => `${x.domain} (${numericToLabel(x.level)})`).join(', ') : 'none recorded';
    const pStr = Object.entries(p).slice(0, 4).map(([t, v]) => `${t}: ${v.toFixed(2)}`).join(', ') || 'undetermined';
    return `Present: strengths — ${sStr}; personality — ${pStr}.`;
  }

  private _futureSummary(): string {
    const asp = storeGetAspirations(this.db, 'active');
    const str = asp.length > 0 ? asp.slice(0, 3).map((a) => `${a.domain} → ${a.targetLevel}`).join(', ') : 'no active aspirations';
    return `Future: ${str}.`;
  }
}
