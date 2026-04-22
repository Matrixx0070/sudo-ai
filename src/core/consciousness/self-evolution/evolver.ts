/**
 * @file evolver.ts
 * @description SelfEvolution — top-level orchestrator for the self-evolution subsystem.
 *
 * Coordinates failure detection, capability gap detection, fix proposals,
 * soul updates, proposal application, and DNA management.
 *
 * Proposal construction is delegated to proposal-builder.ts.
 * DNA management is delegated to dna.ts.
 *
 * IMPORTANT: No proposal is ever applied automatically. Owner approval is
 * required before applyProposal() will write any file.
 */

import { writeFile } from 'node:fs/promises';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type {
  DigitalDNA,
  EvoBrainLike,
  EvolutionProposal,
  EvoSelfModelLike,
  FailurePattern,
} from './types.js';
import { getProposals, recordFailure, updateProposalStatus } from './store.js';
import { detectCapabilityGaps, detectFailurePatterns } from './detector.js';
import { addGrowthEvent, initializeDNA } from './dna.js';
import {
  buildFixProposal,
  buildSoulUpdateProposal,
  type WisdomStoreLike,
} from './proposal-builder.js';

const log = createLogger('self-evolution:evolver');

// ---------------------------------------------------------------------------
// SelfEvolution
// ---------------------------------------------------------------------------

export class SelfEvolution {
  private readonly brain: EvoBrainLike;
  private readonly cdb: ConsciousnessDB;
  private readonly selfModel: EvoSelfModelLike;

  constructor(
    brain: EvoBrainLike,
    consciousnessDB: ConsciousnessDB,
    selfModel: EvoSelfModelLike,
  ) {
    if (!brain || typeof brain.call !== 'function') {
      throw new ConsciousnessError(
        'SelfEvolution: brain must implement EvoBrainLike',
        'consciousness_evolution_invalid_brain',
        {},
      );
    }
    if (!consciousnessDB || typeof consciousnessDB.getDb !== 'function') {
      throw new ConsciousnessError(
        'SelfEvolution: consciousnessDB must be a ConsciousnessDB instance',
        'consciousness_evolution_invalid_db',
        {},
      );
    }
    if (!selfModel || typeof selfModel.getWeaknesses !== 'function') {
      throw new ConsciousnessError(
        'SelfEvolution: selfModel must implement EvoSelfModelLike',
        'consciousness_evolution_invalid_self_model',
        {},
      );
    }

    this.brain = brain;
    this.cdb = consciousnessDB;
    this.selfModel = selfModel;

    log.info('SelfEvolution initialised');
  }

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  /**
   * Surface recurring unresolved error patterns from the database.
   * Only patterns with occurrence_count >= 3 are returned.
   */
  detectFailurePatterns(): FailurePattern[] {
    const db = this.cdb.getDb();
    return detectFailurePatterns(db);
  }

  /**
   * Identify capability domains where the self-model reports weak competency.
   */
  detectCapabilityGaps(): string[] {
    return detectCapabilityGaps(this.selfModel);
  }

  // -------------------------------------------------------------------------
  // Proposals
  // -------------------------------------------------------------------------

  /**
   * Ask the brain to propose a code fix for a known issue in a target file.
   *
   * @param target - Absolute path of the file to fix.
   * @param issue  - Plain-text description of the problem to address.
   */
  async proposeFix(target: string, issue: string): Promise<EvolutionProposal> {
    const db = this.cdb.getDb();
    return buildFixProposal(db, this.brain, target, issue);
  }

  /**
   * Generate a soul update proposal based on recent experience.
   *
   * Reads SOUL.md, collects context, asks the brain to propose changes.
   * The proposal is saved with status 'proposed' — never applied automatically.
   * Owner must call applyProposal(id) after reviewing.
   *
   * @param currentSoulPath - Absolute path to the current SOUL.md file.
   * @param wisdomStore     - Optional wisdom store for recent insights.
   */
  async updateSoulFromExperience(
    currentSoulPath: string,
    wisdomStore?: WisdomStoreLike,
  ): Promise<EvolutionProposal> {
    const db = this.cdb.getDb();
    return buildSoulUpdateProposal(db, this.brain, this.selfModel, currentSoulPath, wisdomStore);
  }

  /**
   * Apply an approved proposal by writing its proposed content to the target path.
   *
   * Only proposals in 'approved' status are eligible. On success the proposal
   * status is updated to 'applied' and a DNA growth event is recorded.
   *
   * @param id - The proposal id to apply.
   * @returns true on success, false if the proposal was not found.
   * @throws ConsciousnessError if the proposal is not in 'approved' status.
   */
  async applyProposal(id: string): Promise<boolean> {
    if (!id) {
      throw new ConsciousnessError(
        'applyProposal: id is required',
        'consciousness_evolution_invalid_proposal',
        {},
      );
    }

    const db = this.cdb.getDb();

    const proposals = getProposals(db);
    const proposal = proposals.find((p) => p.id === id);

    if (!proposal) {
      log.warn({ id }, 'applyProposal: proposal not found');
      return false;
    }

    if (proposal.status !== 'approved') {
      throw new ConsciousnessError(
        `applyProposal: proposal ${id} has status '${proposal.status}' — only 'approved' proposals can be applied`,
        'consciousness_evolution_proposal_not_approved',
        { id, status: proposal.status },
      );
    }

    if (!proposal.proposedCode) {
      throw new ConsciousnessError(
        `applyProposal: proposal ${id} has no proposedCode to write`,
        'consciousness_evolution_invalid_proposal',
        { id },
      );
    }

    log.info({ id, target: proposal.target, type: proposal.type }, 'Applying proposal');

    // Only soul-update and code-fix write files. Other types are not yet supported.
    if (proposal.type !== 'soul-update' && proposal.type !== 'code-fix') {
      updateProposalStatus(db, id, 'failed');
      log.warn({ id, type: proposal.type }, 'applyProposal: unsupported type — marked failed');
      return false;
    }

    try {
      await writeFile(proposal.target, proposal.proposedCode, 'utf8');
      log.info({ target: proposal.target }, 'File written');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateProposalStatus(db, id, 'failed');
      throw new ConsciousnessError(
        `applyProposal: failed to write file: ${msg}`,
        'consciousness_evolution_apply_error',
        { id, target: proposal.target, cause: msg },
      );
    }

    updateProposalStatus(db, id, 'applied');

    // Record as a DNA growth event (non-fatal on failure).
    try {
      addGrowthEvent(
        db,
        `Applied ${proposal.type} proposal ${id}: ${proposal.description.slice(0, 100)}`,
      );
    } catch (err) {
      log.warn({ id, error: String(err) }, 'Could not record DNA growth event after apply');
    }

    log.info({ id, target: proposal.target }, 'Proposal applied successfully');

    return true;
  }

  // -------------------------------------------------------------------------
  // DNA
  // -------------------------------------------------------------------------

  /**
   * Return the current DigitalDNA, initialising it if this is the first call.
   */
  getDNA(): DigitalDNA {
    const db = this.cdb.getDb();
    return initializeDNA(db);
  }

  // -------------------------------------------------------------------------
  // Queries & recording
  // -------------------------------------------------------------------------

  /**
   * Retrieve proposals, optionally filtered by status.
   *
   * @param status - Optional status filter ('proposed', 'approved', etc.).
   */
  getProposals(status?: string): EvolutionProposal[] {
    const db = this.cdb.getDb();
    return getProposals(db, status);
  }

  /**
   * Record an error signature occurrence in the failure_patterns table.
   *
   * @param errorSignature - Normalised string representing the error class.
   */
  recordFailure(errorSignature: string): void {
    const db = this.cdb.getDb();
    recordFailure(db, errorSignature);
  }
}
