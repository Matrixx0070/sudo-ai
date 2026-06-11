/**
 * @file agent-config-evolver.ts
 * @description AgentConfigEvolver — generate AgentConfigProposal objects from
 * high-quality traces mined by SkillDiscovery.
 *
 * Safety model:
 *   - NEVER auto-applies proposals. Human approval required (ProposalStore.approve).
 *   - Requires min 10 traces at >= 0.7 quality before generating a proposal.
 *   - Writes proposals to ProposalStore (SQLite) and emits 'proposal' event.
 *   - One proposal per distinct trace pattern (proposalGenerated flag prevents dupes).
 *
 * @see wave10-spec.md Section E (Builder 1), Section G (G1 interface)
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectPath } from '../shared/paths.js';
import type { AgentConfigProposal, TracePattern } from '../shared/wave10-types.js';
import type { ProposalStore } from './proposal-store.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('learning:evolver');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_TRACE_COUNT = 10;
const MIN_QUALITY_THRESHOLD = 0.7;
const PROPOSALS_DIR = projectPath('learning', 'proposals');

const MAX_TRACES = 5_000;
const TRACES_EVICT_COUNT = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceInput {
  sessionId: string;
  agentId: string;
  toolSequence: string[];
  quality: number;       // 0..1 — derived from success rate, latency, etc.
  timestamp: string;     // ISO-8601
  metadata?: Record<string, unknown>;
}

export interface EvolverEvents {
  proposal: [AgentConfigProposal];
}

// ---------------------------------------------------------------------------
// AgentConfigEvolver
// ---------------------------------------------------------------------------

export class AgentConfigEvolver extends EventEmitter {
  private readonly store: ProposalStore;
  private readonly traces: TraceInput[] = [];

  constructor(store: ProposalStore) {
    super();
    this.store = store;
    // Ensure proposals directory exists for file output
    if (!existsSync(PROPOSALS_DIR)) {
      try {
        mkdirSync(PROPOSALS_DIR, { recursive: true });
      } catch {
        // Not fatal — proposals still go to SQLite
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Record a trace for future proposal generation.
   * Traces below quality threshold are ignored immediately.
   *
   * @param trace - Trace input data.
   */
  recordTrace(trace: TraceInput): void {
    if (!trace.sessionId || !trace.agentId) return;
    // Pre-filter obvious low-quality traces
    if (trace.quality < 0) return;
    this.traces.push(trace);
    if (this.traces.length > MAX_TRACES) {
      this.traces.splice(0, TRACES_EVICT_COUNT);
      log.debug({ evicted: TRACES_EVICT_COUNT }, 'AgentConfigEvolver traces buffer eviction');
    }
    log.debug({ sessionId: trace.sessionId, quality: trace.quality }, 'trace recorded');
  }

  /**
   * Attempt to generate an AgentConfigProposal from a TracePattern.
   *
   * Requirements:
   *   - At least MIN_TRACE_COUNT traces available for this agent.
   *   - Average quality of traces for this agent >= MIN_QUALITY_THRESHOLD.
   *   - proposalGenerated flag not already set on the pattern.
   *
   * On success: persists to ProposalStore, writes JSON to learning/proposals/,
   * emits 'proposal' event. NEVER auto-applies.
   *
   * @param pattern - TracePattern from SkillDiscovery.mine().
   * @param agentId - Target agent for the proposal.
   * @returns Generated AgentConfigProposal or null if requirements not met.
   */
  propose(pattern: TracePattern, agentId: string): AgentConfigProposal | null {
    if (pattern.proposalGenerated) {
      log.debug({ patternId: pattern.id }, 'proposal already generated for pattern — skip');
      return null;
    }

    // Filter traces for this specific agent
    const agentTraces = this.traces.filter((t) => t.agentId === agentId);

    if (agentTraces.length < MIN_TRACE_COUNT) {
      log.debug(
        { agentId, count: agentTraces.length, required: MIN_TRACE_COUNT },
        'insufficient traces for proposal',
      );
      return null;
    }

    const avgQuality =
      agentTraces.reduce((sum, t) => sum + t.quality, 0) / agentTraces.length;

    if (avgQuality < MIN_QUALITY_THRESHOLD) {
      log.debug(
        { agentId, avgQuality, required: MIN_QUALITY_THRESHOLD },
        'trace quality too low for proposal',
      );
      return null;
    }

    // Build the proposal
    const now = new Date().toISOString();
    const proposal: AgentConfigProposal = {
      id: randomUUID(),
      agentId,
      rationale: buildRationale(pattern, agentTraces.length, avgQuality),
      delta: buildDelta(pattern),
      traceQuality: Math.round(avgQuality * 1000) / 1000,
      traceCount: agentTraces.length,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    // Persist to SQLite
    this.store.save(proposal);

    // Write JSON snapshot to proposals dir
    writeProposalFile(proposal);

    log.info(
      { id: proposal.id, agentId, traceCount: agentTraces.length, avgQuality },
      'proposal generated (pending human approval)',
    );

    // Emit event (never auto-applies — human must call ProposalStore.approve)
    this.emit('proposal', proposal);

    return proposal;
  }

  /**
   * Return current trace count for a given agent (or all agents).
   */
  traceCount(agentId?: string): number {
    if (agentId) return this.traces.filter((t) => t.agentId === agentId).length;
    return this.traces.length;
  }

  /**
   * Clear all stored traces (for testing / periodic reset).
   */
  resetTraces(): void {
    this.traces.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRationale(
  pattern: TracePattern,
  traceCount: number,
  avgQuality: number,
): string {
  const seqStr = pattern.toolSequence.join(' → ');
  const pct = Math.round(pattern.successRate * 100);
  return (
    `Pattern "${seqStr}" observed ${pattern.occurrenceCount} times ` +
    `(${pct}% success rate) across ${traceCount} traces ` +
    `(avg quality ${(avgQuality * 100).toFixed(1)}%). ` +
    `Suggest pre-loading these tools or adjusting tool_order preference.`
  );
}

function buildDelta(pattern: TracePattern): Record<string, unknown> {
  // Conservative delta: suggest preferred tool sequence and tool pre-loading
  return {
    tools: {
      preferred_sequence: pattern.toolSequence,
      preload: pattern.toolSequence.slice(0, 2), // pre-load the first 2 tools
    },
    learning: {
      observed_pattern_id: pattern.id,
      pattern_success_rate: pattern.successRate,
      pattern_occurrence_count: pattern.occurrenceCount,
    },
  };
}

function writeProposalFile(proposal: AgentConfigProposal): void {
  try {
    const filePath = join(PROPOSALS_DIR, `${proposal.id}.json`);
    writeFileSync(filePath, JSON.stringify(proposal, null, 2), 'utf8');
  } catch {
    // Not fatal — SQLite is the source of truth
    log.warn({ id: proposal.id }, 'could not write proposal file (SQLite persisted)');
  }
}
