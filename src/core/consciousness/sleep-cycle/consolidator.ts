/**
 * @file consolidator.ts
 * @description SleepCycle — orchestrates five-phase memory consolidation.
 *
 * Phase execution is delegated to phases.ts for modularity.
 * Between each phase the cycle checks _wakeRequested; if set, partial
 * results are persisted and returned immediately.
 *
 * Usage:
 * ```ts
 * const cycle = new SleepCycle({ cdb, brain, episodicMemory, ... });
 * if (cycle.shouldSleep(lastMs, isQuietHours)) {
 *   const report = await cycle.startSleep();
 * }
 * ```
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import { genId } from '../../shared/utils.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import {
  runPhase1ExperienceReplay,
  runPhase2PatternFinding,
  runPhase3Counterfactuals,
  runPhase4SelfUpdate,
  runPhase5DreamGeneration,
  type PhaseAccumulator,
} from './phases.js';
import { saveSleepSession, getDreamJournal as storeGetDreamJournal } from './store.js';
import {
  verifyAccumulatorIntegrity,
  parseAndCheckLockoutWindow,
  type IntegrityReport,
} from './integrity-verifier.js';
import type {
  SleepSession,
  SleepBrainLike,
  SleepEpisodicLike,
  SleepCounterfactualLike,
  SleepSelfModelLike,
  SleepTemporalSelfLike,
  SleepMetacognitionLike,
  SleepWisdomLike,
  PeerAuditSummary,
} from './types.js';
import type { CommitmentAuditReport } from '../../cognition/commitment-auditor.js';

// Duck-typed interface so we avoid a hard runtime dependency on the concrete class.
interface CommitmentAuditorLike {
  checkAndWarn(windowDays?: number): CommitmentAuditReport;
}

// Duck-typed TrustTierTracker interface for outcome recording.
interface TrustTrackerLike {
  recordOutcome(outcome: { timestamp: number; kind: string }): void;
}

// Duck-typed MistakePatternRecognizer interface — avoids hard dep on concrete class.
interface MistakePatternRecognizerLike {
  analyze(opts?: { windowDays?: number; minOccurrences?: number }): {
    totalMistakes: number;
    uniquePatterns: number;
    recurringPatterns: { length: number };
    analyzedAt: string;
  };
}

// Duck-typed AuditChainSync interface — avoids hard dep on concrete class..
interface AuditChainSyncLike {
  listPeers(): string[];
  fetchPeerTail(peerName: string, sinceMs: number, limit?: number): Promise<Array<{
    eventType: string;
    ts: number;
    id: string;
  }>>;
}

// ---------------------------------------------------------------------------
// Peer-tail pull helpers
// ---------------------------------------------------------------------------

const PEER_PULL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const PEER_PULL_LIMIT     = 100;
const PEER_PULL_TOTAL_TIMEOUT_MS = 15_000;

/**
 * Summarise one peer's fetched events into a PeerAuditSummary.
 * Fails-open: empty arrays produce eventCount:0.
 */
function summarisePeerTail(
  peerName: string,
  events: Array<{ eventType: string; ts: number; id: string }>,
  pulledAt: number,
): PeerAuditSummary {
  if (events.length === 0) {
    return { peerName, eventCount: 0, error: 'empty', pulledAt };
  }
  const byEventType: Record<string, number> = {};
  // undefined (not ±Infinity) sentinels: JSON.stringify(Infinity) === 'null',
  // which would give in-memory and persisted readers two different views.
  let newestTs: number | undefined;
  let oldestTs: number | undefined;
  for (const ev of events) {
    byEventType[ev.eventType] = (byEventType[ev.eventType] ?? 0) + 1;
    if (Number.isFinite(ev.ts)) {
      if (newestTs === undefined || ev.ts > newestTs) newestTs = ev.ts;
      if (oldestTs === undefined || ev.ts < oldestTs) oldestTs = ev.ts;
    }
  }
  const firstInstanceIds = events.slice(0, 10).map(e => e.id);
  return {
    peerName,
    eventCount: events.length,
    newestTs,
    oldestTs,
    byEventType,
    firstInstanceIds,
    pulledAt,
  };
}

/**
 * Pull audit tails from all peers with a hard 15s total timeout.
 * Each peer already has a 3s per-peer timeout inside fetchPeerTail.
 * Fails-open on any individual peer error.
 */
async function pullAllPeerAudits(
  sync: AuditChainSyncLike,
  log: ReturnType<typeof import('../../shared/logger.js').createLogger>,
): Promise<PeerAuditSummary[]> {
  const peers = sync.listPeers();
  if (peers.length === 0) return [];

  const sinceMs  = Date.now() - PEER_PULL_WINDOW_MS;
  const pulledAt = Date.now();

  // Per-peer timeout: a slow peer fabricates a timeout summary for ITSELF only.
  // The old all-or-nothing Promise.race marked every peer (incl. ones that had
  // already succeeded) as timed-out when a total deadline fired — corrupting the
  // audit record. fetchPeerTail has no abort signal, so each peer self-limits here.
  const withPerPeerTimeout = (
    p: Promise<PeerAuditSummary>,
    peerName: string,
  ): Promise<PeerAuditSummary> =>
    new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) { done = true; resolve({ peerName, eventCount: 0, error: 'timeout', pulledAt }); }
      }, PEER_PULL_TOTAL_TIMEOUT_MS);
      p.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
       .catch(() => { if (!done) { done = true; clearTimeout(t); resolve({ peerName, eventCount: 0, error: 'unreachable', pulledAt }); } });
    });

  const peerPromises = peers.map((peerName) =>
    withPerPeerTimeout(
      (async (): Promise<PeerAuditSummary> => {
        try {
          const events = await sync.fetchPeerTail(peerName, sinceMs, PEER_PULL_LIMIT);
          return summarisePeerTail(peerName, events, pulledAt);
        } catch (err: unknown) {
          log.warn({ peerName, err: String(err) }, 'peer-audit pull failed (fail-open)');
          return { peerName, eventCount: 0, error: 'unreachable', pulledAt };
        }
      })(),
      peerName,
    ),
  );

  const results = await Promise.allSettled(peerPromises);
  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    // Wrapped promises resolve rather than reject, but stay defensive.
    log.warn({ peerName: peers[i], reason: String(r.reason) }, 'peer-audit settled rejected');
    return { peerName: peers[i] ?? 'unknown', eventCount: 0, error: 'unreachable', pulledAt };
  });
}

// Duck-typed SkillDiscovery interface — avoids hard dep on concrete class..
interface SkillDiscoveryLike {
  mine(windowMs?: number): unknown[];
}

// Duck-typed AgentConfigEvolver interface — avoids hard dep on concrete class..
interface AgentConfigEvolverLike {
  emit(event: string, ...args: unknown[]): boolean;
  listenerCount(event: string): number;
}

// Duck-typed SkillOptimizer interface — avoids hard dep on concrete class..
interface SkillOptimizerLike {
  propose(): unknown[];
}

// Duck-typed ReAnchorMonitor interface — avoids hard dep on concrete class.
interface ReAnchorMonitorLike {
  getStats(opts?: { windowDays?: number }): {
    total: number;
    byTrigger: Record<string, number>;
    windowDays: number;
    computedAt: string;
    lastReAnchorAt?: number;
  };
}

// Duck-typed CrossSignalDiagnostics interface — avoids hard dep on concrete class.
interface CrossSignalDiagnosticsLike {
  analyze(opts?: {
    windowDays?: number;
    spikeBucketMinutes?: number;
    correlationWindowMinutes?: number;
  }): {
    trustSpikes: Array<{ count: number; kind: string; ts: number; source: string }>;
    epistemicBlockSpikes: Array<{ count: number; kind: string; ts: number; source: string }>;
    vetoSpikes: Array<{ count: number; kind: string; ts: number; source: string }>;
    commitmentExpirySpikes: Array<{ count: number; kind: string; ts: number; source: string }>;
    correlations: Array<{
      leadingSpike: { kind: string };
      trailingSpike: { kind: string };
      deltaMs: number;
      confidence: number;
    }>;
    totalEventsScanned: number;
    analyzedAt: string;
  };
}

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('sleep-cycle:consolidator');

// ---------------------------------------------------------------------------
// Timing constants (milliseconds)
// ---------------------------------------------------------------------------

const IDLE_QUIET_HOURS_MS = 30 * 60 * 1000;      // 30 min
const IDLE_ACTIVE_HOURS_MS = 2 * 60 * 60 * 1000;  // 2 h

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Given a lockout-window spec (e.g. "02:00-06:00"), compute the UTC ISO
 * string at which the window ends (i.e., when sleep becomes eligible again).
 *
 * Returns 'unknown' if the spec cannot be parsed.
 * Does NOT log — caller is responsible for operator visibility.
 */
function computeNextEligibleAt(spec: string): string {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (!match) return 'unknown';

  const endH = parseInt(match[3], 10);
  const endM = parseInt(match[4], 10);

  if (endH > 23 || endM > 59) return 'unknown';

  const now = new Date();
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    endH,
    endM,
    0,
    0,
  ));

  // If end time has already passed today, the window ends tomorrow.
  if (candidate.getTime() <= Date.now()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }

  return candidate.toISOString();
}

// ---------------------------------------------------------------------------
// SleepCycle
// ---------------------------------------------------------------------------

export class SleepCycle {
  private readonly cdb: ConsciousnessDB;
  private readonly brain: SleepBrainLike;
  private readonly episodicMemory: SleepEpisodicLike;
  private readonly counterfactualEngine: SleepCounterfactualLike;
  private readonly selfModel: SleepSelfModelLike;
  private readonly temporalSelf: SleepTemporalSelfLike;
  private readonly metacognition: SleepMetacognitionLike;
  private readonly wisdomStore: SleepWisdomLike;

  private _sleeping = false;
  private _wakeRequested = false;
  private _lastResult: SleepSession | null = null;
  /** True when sleep was blocked by the active lockout window. */
  private _restrained = false;
  /** True when the most recently completed cycle had integrity failures. */
  private _degraded = false;
  private readonly commitmentAuditor: CommitmentAuditorLike | undefined;
  private readonly trustTracker: TrustTrackerLike | undefined;
  private readonly mistakePatternRecognizer: MistakePatternRecognizerLike | undefined;
  private readonly crossSignalDiagnostics: CrossSignalDiagnosticsLike | undefined;
  private readonly reanchorMonitor: ReAnchorMonitorLike | undefined;
  /** Optional skill discovery hook — mines trace patterns during sleep. */
  private readonly skillDiscovery: SkillDiscoveryLike | undefined;
  /** Optional agent config evolver hook — notified on sleep-cycle-complete. */
  private readonly agentConfigEvolver: AgentConfigEvolverLike | undefined;
  /** Optional skill optimizer hook — generates proposals during sleep. */
  private skillOptimizer: SkillOptimizerLike | undefined;
  /** Optional audit-chain sync for peer tail pulls. */
  private auditChainSync: AuditChainSyncLike | undefined;

  constructor(opts: {
    cdb: ConsciousnessDB;
    brain: SleepBrainLike;
    episodicMemory: SleepEpisodicLike;
    counterfactualEngine: SleepCounterfactualLike;
    selfModel: SleepSelfModelLike;
    temporalSelf: SleepTemporalSelfLike;
    metacognition: SleepMetacognitionLike;
    wisdomStore: SleepWisdomLike;
    commitmentAuditor?: CommitmentAuditorLike;
    trustTracker?: TrustTrackerLike;
    mistakePatternRecognizer?: MistakePatternRecognizerLike;
    crossSignalDiagnostics?: CrossSignalDiagnosticsLike;
    reanchorMonitor?: ReAnchorMonitorLike;
    skillDiscovery?: SkillDiscoveryLike;
    agentConfigEvolver?: AgentConfigEvolverLike;
    skillOptimizer?: SkillOptimizerLike;
  }) {
    if (!opts.cdb || typeof opts.cdb.getDb !== 'function') {
      throw new ConsciousnessError(
        'SleepCycle: cdb must be a valid ConsciousnessDB instance',
        'consciousness_sleep_invalid_input',
        { received: typeof opts.cdb },
      );
    }
    if (!opts.brain || typeof opts.brain.call !== 'function') {
      throw new ConsciousnessError(
        'SleepCycle: brain must implement SleepBrainLike',
        'consciousness_sleep_invalid_input',
        { received: typeof opts.brain },
      );
    }

    this.cdb = opts.cdb;
    this.brain = opts.brain;
    this.episodicMemory = opts.episodicMemory;
    this.counterfactualEngine = opts.counterfactualEngine;
    this.selfModel = opts.selfModel;
    this.temporalSelf = opts.temporalSelf;
    this.metacognition = opts.metacognition;
    this.wisdomStore = opts.wisdomStore;
    this.commitmentAuditor = opts.commitmentAuditor;
    this.trustTracker = opts.trustTracker;
    this.mistakePatternRecognizer = opts.mistakePatternRecognizer;
    this.crossSignalDiagnostics = opts.crossSignalDiagnostics;
    this.reanchorMonitor = opts.reanchorMonitor;
    this.skillDiscovery = opts.skillDiscovery;
    this.agentConfigEvolver = opts.agentConfigEvolver;
    this.skillOptimizer = opts.skillOptimizer;

    log.info('SleepCycle initialised');
  }

  // -------------------------------------------------------------------------
  // shouldSleep
  // -------------------------------------------------------------------------

  /**
   * Decide whether a sleep cycle should be initiated.
   *
   * @param lastInteractionMs - Milliseconds since the last interaction.
   * @param isQuietHours      - True if in a low-activity window.
   */
  shouldSleep(lastInteractionMs: number, isQuietHours: boolean): boolean {
    if (typeof lastInteractionMs !== 'number' || lastInteractionMs < 0) return false;
    if (this._sleeping) return false;

    // Check lockout window — operational boundary protecting principal resources.
    const lockoutSpec = process.env.SUDO_SLEEP_LOCKOUT_WINDOW;
    if (lockoutSpec && lockoutSpec.trim() !== '') {
      const inWindow = parseAndCheckLockoutWindow(lockoutSpec);
      if (inWindow) {
        this._restrained = true;
        const nextEligibleAt = computeNextEligibleAt(lockoutSpec);
        log.info(
          {
            module: 'sleep-cycle',
            window: '[configured]',
            nextEligibleAt,
          },
          'Sleep cycle skipped — lockout window active',
        );
        return false;
      }
    }
    this._restrained = false;

    if (isQuietHours && lastInteractionMs >= IDLE_QUIET_HOURS_MS) return true;
    if (!isQuietHours && lastInteractionMs >= IDLE_ACTIVE_HOURS_MS) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // startSleep
  // -------------------------------------------------------------------------

  /**
   * Execute a full five-phase memory consolidation cycle.
   *
   * Checks _wakeRequested between each phase. If set, saves partial results
   * and returns early. The finally block always clears _sleeping state.
   *
   * @throws ConsciousnessError if already sleeping.
   */
  async startSleep(): Promise<SleepSession> {
    if (this._sleeping) {
      throw new ConsciousnessError(
        'SleepCycle.startSleep: a cycle is already in progress',
        'consciousness_sleep_already_sleeping',
      );
    }

    this._sleeping = true;
    this._wakeRequested = false;

    const startedAt = new Date().toISOString();
    const sessionId = genId();
    log.info({ sessionId }, 'Sleep cycle started');

    // Snapshot degraded flag at start — phase-skip decision is stable even if
    // _runIntegrityCheck() clears _degraded mid-cycle.
    const startedDegraded = this._degraded;
    if (startedDegraded) {
      log.warn(
        { degraded: true, sessionId },
        'Sleep-cycle starting in DEGRADED state — Phase 3 (Counterfactuals) and Phase 5 (Dream) will be skipped',
      );
    }

    const acc: PhaseAccumulator = {
      episodesReplayed: 0,
      patternsFound: 0,
      memoriesStrengthened: 0,
      memoriesWeakened: 0,
      insightsGenerated: 0,
      counterfactualsRun: 0,
      dreamJournalEntry: '',
      summaries: [],
      insightTexts: [],
    };

    // Declared outside try so they are in scope at the normal-exit _finalise call.
    let integrityReport: IntegrityReport | undefined;
    let commitmentSummary: SleepSession['commitmentAudit'];
    let patternSummary: SleepSession['patternAnalysis'];
    let diagnosticsSummary: SleepSession['diagnostics'];
    let reanchorSummary: SleepSession['reanchor'];
    let peerAuditSummaries: PeerAuditSummary[] | undefined;

    try {
      // Phase 1
      log.debug({ sessionId }, 'Phase 1: Experience Replay');
      runPhase1ExperienceReplay(this.episodicMemory, acc);
      if (this._wakeRequested) {
        integrityReport = this._runIntegrityCheck(sessionId, acc);
        return this._finalise(sessionId, startedAt, acc, integrityReport, commitmentSummary);
      }

      // Phase 2
      log.debug({ sessionId }, 'Phase 2: Pattern Finding');
      await runPhase2PatternFinding(this.brain, this.wisdomStore, acc);
      if (this._wakeRequested) {
        integrityReport = this._runIntegrityCheck(sessionId, acc);
        return this._finalise(sessionId, startedAt, acc, integrityReport, commitmentSummary);
      }

      // Phase 3 — skip when degraded (counterfactuals are non-critical)
      if (!startedDegraded) {
        log.debug({ sessionId }, 'Phase 3: Counterfactual Simulation');
        await runPhase3Counterfactuals(this.counterfactualEngine, this.wisdomStore, acc);
        if (this._wakeRequested) {
          integrityReport = this._runIntegrityCheck(sessionId, acc);
          return this._finalise(sessionId, startedAt, acc, integrityReport, commitmentSummary);
        }
      }

      // Phase 4
      log.debug({ sessionId }, 'Phase 4: Self-Update');
      await runPhase4SelfUpdate(this.temporalSelf, this.metacognition);
      if (this._wakeRequested) {
        integrityReport = this._runIntegrityCheck(sessionId, acc);
        return this._finalise(sessionId, startedAt, acc, integrityReport, commitmentSummary);
      }

      // Phase 5 — skip when degraded (dream generation is non-critical)
      if (!startedDegraded) {
        log.debug({ sessionId }, 'Phase 5: Dream Generation');
        await runPhase5DreamGeneration(this.brain, acc);
      }

      // Integrity check between Phase 5 completion and commitment audit.
      integrityReport = this._runIntegrityCheck(sessionId, acc);

      // Commitment audit — runs on all cycles including degraded; cheap read-only.
      if (this.commitmentAuditor) {
        try {
          const report = this.commitmentAuditor.checkAndWarn(3);
          commitmentSummary = {
            totalFlagged: report.expiringSoon.length + report.alreadyExpired.length,
            expiring: report.expiringSoon.length,
            expired: report.alreadyExpired.length,
            checkedAt: report.checkedAt,
          };
          if (startedDegraded) {
            log.warn(
              { event: 'commitment.audit.on-degraded-cycle' },
              'Commitment audit ran on degraded cycle — operator attention may be required',
            );
          }
          // Record trust outcome for each expired commitment (fail-open).
          if (this.trustTracker && report.alreadyExpired.length > 0) {
            const now = Date.now();
            for (const _row of report.alreadyExpired) {
              try {
                this.trustTracker.recordOutcome({ timestamp: now, kind: 'commitment-expired' });
              } catch { /* fail-open */ }
            }
          }
        } catch (err: unknown) {
          log.error(
            { err, event: 'commitment.audit.error' },
            'Commitment audit threw — skipping summary (fail-open)',
          );
        }
      }

      // Pattern analysis — runs on all cycles including degraded; cheap read-only.
      if (this.mistakePatternRecognizer) {
        try {
          const report = this.mistakePatternRecognizer.analyze({ windowDays: 30, minOccurrences: 2 });
          patternSummary = {
            totalMistakes: report.totalMistakes,
            uniquePatterns: report.uniquePatterns,
            recurringCount: report.recurringPatterns.length,
            analyzedAt: report.analyzedAt,
          };
          if (startedDegraded) {
            log.warn(
              { event: 'pattern.analysis.on-degraded-cycle' },
              'Pattern analysis ran on degraded cycle — operator attention may be required',
            );
          }
        } catch (err: unknown) {
          log.error(
            { err, event: 'pattern.analysis.error' },
            'Pattern analysis threw — skipping summary (fail-open)',
          );
        }
      }

      // Cross-signal diagnostics — runs on all cycles including degraded; read-only.
      if (this.crossSignalDiagnostics) {
        if (startedDegraded) {
          log.warn(
            { event: 'cross-signal.diagnostics.on-degraded-cycle' },
            'Cross-signal diagnostics ran on degraded cycle — operator attention may be required',
          );
        }
        try {
          const report = this.crossSignalDiagnostics.analyze({
            windowDays: 7,
            spikeBucketMinutes: 15,
            correlationWindowMinutes: 30,
          });
          diagnosticsSummary = {
            trustSpikeCount: report.trustSpikes.length,
            epistemicBlockSpikeCount: report.epistemicBlockSpikes.length,
            vetoSpikeCount: report.vetoSpikes.length,
            commitmentExpirySpikeCount: report.commitmentExpirySpikes.length,
            topCorrelations: report.correlations.slice(0, 3).map(c => ({
              from: c.leadingSpike.kind,
              to: c.trailingSpike.kind,
              deltaMs: c.deltaMs,
              confidence: c.confidence,
            })),
            totalEventsScanned: report.totalEventsScanned,
            analyzedAt: report.analyzedAt,
          };
        } catch (err: unknown) {
          log.error(
            { err, event: 'cross-signal.diagnostics.error' },
            'Cross-signal diagnostics threw — skipping summary (fail-open)',
          );
        }
      }

      // Re-anchor analysis — runs on all cycles including degraded; pure read-only DB scan.
      if (this.reanchorMonitor) {
        if (startedDegraded) {
          log.warn(
            { event: 'reanchor.analysis.on-degraded-cycle' },
            'Re-anchor analysis ran on degraded cycle — operator attention may be required',
          );
        }
        try {
          const stats = this.reanchorMonitor.getStats({ windowDays: 30 });
          reanchorSummary = {
            total: stats.total,
            byTrigger: stats.byTrigger,
            analyzedAt: stats.computedAt,
          };
          if (stats.lastReAnchorAt !== undefined) {
            reanchorSummary.lastReAnchorAt = stats.lastReAnchorAt;
          }
          log.debug(
            { event: 'reanchor.analysis.done', total: stats.total },
            'Re-anchor analysis completed in sleep cycle',
          );
        } catch (err: unknown) {
          log.warn(
            { err, event: 'reanchor.analysis.error' },
            'Re-anchor analysis threw — skipping summary (fail-open)',
          );
        }
      }

      // SkillDiscovery hook — mines trace patterns during sleep. Fail-open.
      if (this.skillDiscovery) {
        try {
          const patterns = this.skillDiscovery.mine(24 * 60 * 60 * 1000);
          log.debug(
            { event: 'skill.discovery.mined', patternCount: patterns.length },
            'SkillDiscovery.mine completed in sleep cycle',
          );
        } catch (err: unknown) {
          log.warn(
            { err, event: 'skill.discovery.error' },
            'SkillDiscovery.mine threw — skipping (fail-open)',
          );
        }
      }

      // SkillOptimizer hook — generates skill optimization proposals during sleep. Fail-open.
      if (this.skillOptimizer) {
        try {
          const proposals = this.skillOptimizer.propose();
          log.debug(
            { event: 'skill.optimizer.proposed', proposalCount: proposals.length },
            'SkillOptimizer.propose() completed in sleep cycle',
          );
        } catch (err: unknown) {
          log.warn(
            { err, event: 'skill.optimizer.error' },
            'SkillOptimizer.propose() threw — skipping (fail-open)',
          );
        }
      }

      // AgentConfigEvolver hook — emits sleep-cycle-complete when listeners registered. Fail-open.
      if (this.agentConfigEvolver) {
        try {
          if (this.agentConfigEvolver.listenerCount('sleep-cycle-complete') > 0) {
            this.agentConfigEvolver.emit('sleep-cycle-complete', { sessionId });
            log.debug(
              { event: 'agent-config-evolver.emit', sessionId },
              'AgentConfigEvolver sleep-cycle-complete emitted',
            );
          }
        } catch (err: unknown) {
          log.warn(
            { err, event: 'agent-config-evolver.error' },
            'AgentConfigEvolver emit threw — skipping (fail-open)',
          );
        }
      }

      // Peer-audit tail pull — runs on all cycles including degraded; fail-open.
      if (this.auditChainSync) {
        try {
          peerAuditSummaries = await pullAllPeerAudits(this.auditChainSync, log);
          log.debug(
            { event: 'peer-audit.done', peerCount: peerAuditSummaries.length },
            'Peer-audit tail pull completed in sleep cycle',
          );
        } catch (err: unknown) {
          log.warn(
            { err, event: 'peer-audit.error' },
            'Peer-audit tail pull threw unexpectedly — skipping (fail-open)',
          );
        }
      }

    } finally {
      this._sleeping = false;
      this._wakeRequested = false;
    }

    return this._finalise(sessionId, startedAt, acc, integrityReport, commitmentSummary, patternSummary, diagnosticsSummary, reanchorSummary, peerAuditSummaries);
  }

  // -------------------------------------------------------------------------
  // Skill optimizer injection
  // -------------------------------------------------------------------------

  /**
   * Inject a SkillOptimizer instance for proposal generation during sleep.
   * Safe to call at any time — the next sleep cycle will use the provided instance.
   * If not set (or set to undefined), the skill optimizer phase is skipped.
   */
  setSkillOptimizer(optimizer: SkillOptimizerLike | undefined): void {
    this.skillOptimizer = optimizer;
    log.info(
      { hasOptimizer: optimizer !== undefined },
      'SleepCycle: skillOptimizer set',
    );
  }

  // -------------------------------------------------------------------------
  // Peer-audit sync injection
  // -------------------------------------------------------------------------

  /**
   * Inject an AuditChainSync instance for peer tail pulls during sleep.
   * Safe to call at any time — the next sleep cycle will use the provided instance.
   * If not set (or set to undefined), the peer-audit phase is skipped.
   */
  setAuditChainSync(sync: AuditChainSyncLike | undefined): void {
    this.auditChainSync = sync;
    log.info(
      { hasPeers: sync ? sync.listPeers().length > 0 : false },
      'SleepCycle: auditChainSync set',
    );
  }

  // -------------------------------------------------------------------------
  // Public state accessors
  // -------------------------------------------------------------------------

  /** True if a sleep cycle is currently executing. */
  isAsleep(): boolean {
    return this._sleeping;
  }

  /**
   * Request a graceful early exit from the active sleep cycle.
   * Safe to call when no cycle is running — it is a no-op.
   */
  wakeUp(): void {
    if (this._sleeping) {
      this._wakeRequested = true;
      log.info('Wake-up requested');
    }
  }

  /** Return the result of the most recently completed cycle, or null. */
  getLastSleepReport(): SleepSession | null {
    return this._lastResult;
  }

  /**
   * Return the current operational mode.
   * 'restrained' when the last shouldSleep() call was blocked by a lockout window.
   * 'normal' otherwise.
   */
  getMode(): 'normal' | 'restrained' {
    return this._restrained ? 'restrained' : 'normal';
  }

  /** True when the most recently completed cycle was flagged degraded. */
  isDegraded(): boolean {
    return this._degraded;
  }

  /**
   * Manually clear the degraded flag.
   * Called by the REST reset endpoint. Safe to call at any time — no-op if not degraded.
   */
  clearDegraded(): void {
    if (this._degraded) {
      this._degraded = false;
      log.info({ module: 'sleep-cycle' }, 'Sleep-cycle degraded flag cleared by operator');
    }
  }

  /**
   * Return the N most recent dream journal entries from the database.
   *
   * @param count - Number of entries to return (must be >= 1).
   * @throws ConsciousnessError on invalid input.
   */
  getDreamJournal(count: number): string[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new ConsciousnessError(
        'SleepCycle.getDreamJournal: count must be a positive integer',
        'consciousness_sleep_invalid_input',
        { count },
      );
    }
    return storeGetDreamJournal(this.cdb.getDb(), count);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Run the integrity verifier and update `_degraded` accordingly.
   * Extracted to avoid code duplication across all five early-wake sites.
   */
  private _runIntegrityCheck(sessionId: string, acc: PhaseAccumulator): IntegrityReport {
    const report = verifyAccumulatorIntegrity(acc);
    if (!report.coherent) {
      log.warn(
        { sessionId, failures: report.failures, score: report.score },
        'Sleep-cycle integrity check failed — session flagged degraded',
      );
      this._degraded = true;
    } else {
      this._degraded = false;
    }
    return report;
  }

  /**
   * Compute duration, build the final SleepSession, persist it, cache it.
   *
   * @param integrityReport  - Optional report from the verifier.
   * @param commitmentSummary - Optional summary from the CommitmentAuditor.
   * @param patternSummary - Optional summary from the MistakePatternRecognizer.
   */
  private _finalise(
    sessionId: string,
    startedAt: string,
    acc: PhaseAccumulator,
    integrityReport?: IntegrityReport,
    commitmentSummary?: SleepSession['commitmentAudit'],
    patternSummary?: SleepSession['patternAnalysis'],
    diagnosticsSummary?: SleepSession['diagnostics'],
    reanchorSummary?: SleepSession['reanchor'],
    peerAudits?: PeerAuditSummary[],
  ): SleepSession {
    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();

    const session: SleepSession = {
      id: sessionId,
      episodesReplayed: acc.episodesReplayed,
      patternsFound: acc.patternsFound,
      memoriesStrengthened: acc.memoriesStrengthened,
      memoriesWeakened: acc.memoriesWeakened,
      insightsGenerated: acc.insightsGenerated,
      counterfactualsRun: acc.counterfactualsRun,
      dreamJournalEntry: acc.dreamJournalEntry,
      durationMs,
      startedAt,
      endedAt,
      degraded: this._degraded || acc.episodesReplayed === 0,
      mode: this._restrained ? 'restrained' : 'normal',
      integrityScore: integrityReport?.score,
      commitmentAudit: commitmentSummary,
      patternAnalysis: patternSummary,
      diagnostics: diagnosticsSummary,
      reanchor: reanchorSummary,
      peerAudits,
    };

    try {
      saveSleepSession(this.cdb.getDb(), session);
    } catch (err: unknown) {
      log.error({ err }, 'Sleep session persistence failed — session returned without save');
    }
    this._lastResult = session;

    log.info(
      {
        sessionId,
        durationMs,
        episodesReplayed: session.episodesReplayed,
        insightsGenerated: session.insightsGenerated,
        degraded: session.degraded,
        mode: session.mode,
        integrityScore: session.integrityScore,
      },
      'Sleep session finalised',
    );

    return session;
  }
}
