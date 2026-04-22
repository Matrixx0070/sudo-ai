/**
 * @file store.ts
 * @description SQLite persistence for evolution_proposals and failure_patterns.
 *
 * All functions accept a raw `Database.Database` instance (obtained via
 * `ConsciousnessDB.getDb()`) and operate synchronously using better-sqlite3.
 *
 * Digital DNA storage lives in store-dna.ts.
 * Tables used (defined in consciousness-db.ts):
 *   - evolution_proposals
 *   - failure_patterns
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { EvolutionProposal, FailurePattern } from './types.js';

const log = createLogger('self-evolution:store');

// ---------------------------------------------------------------------------
// Row types (raw SQLite rows)
// ---------------------------------------------------------------------------

interface ProposalRow {
  id: string;
  type: string;
  target: string;
  description: string;
  current_code: string | null;
  proposed_code: string | null;
  reasoning: string;
  confidence: number;
  status: string;
  created_at: string;
}

interface FailureRow {
  id: number;
  error_signature: string;
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  resolved: number;
}

// ---------------------------------------------------------------------------
// Row converters
// ---------------------------------------------------------------------------

function rowToProposal(row: ProposalRow): EvolutionProposal {
  return {
    id: row.id,
    type: row.type as EvolutionProposal['type'],
    target: row.target,
    description: row.description,
    currentCode: row.current_code,
    proposedCode: row.proposed_code,
    reasoning: row.reasoning,
    confidence: row.confidence,
    status: row.status as EvolutionProposal['status'],
    createdAt: row.created_at,
  };
}

function rowToFailure(row: FailureRow): FailurePattern {
  return {
    id: row.id,
    errorSignature: row.error_signature,
    occurrenceCount: row.occurrence_count,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    resolved: row.resolved === 1,
  };
}

// ---------------------------------------------------------------------------
// Evolution proposals
// ---------------------------------------------------------------------------

/**
 * Persist a new or updated evolution proposal (INSERT OR REPLACE).
 */
export function saveProposal(db: Database.Database, proposal: EvolutionProposal): void {
  if (!proposal.id || !proposal.type || !proposal.target) {
    throw new ConsciousnessError(
      'saveProposal: proposal must have id, type, and target',
      'consciousness_evolution_invalid_proposal',
      { id: proposal.id, type: proposal.type },
    );
  }

  try {
    db.prepare(`
      INSERT OR REPLACE INTO evolution_proposals
        (id, type, target, description, current_code, proposed_code,
         reasoning, confidence, status, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      proposal.id,
      proposal.type,
      proposal.target,
      proposal.description,
      proposal.currentCode ?? null,
      proposal.proposedCode ?? null,
      proposal.reasoning,
      proposal.confidence,
      proposal.status,
      proposal.createdAt,
    );

    log.debug({ id: proposal.id, type: proposal.type, status: proposal.status }, 'Proposal saved');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to save evolution proposal: ${msg}`,
      'consciousness_evolution_store_error',
      { id: proposal.id, cause: msg },
    );
  }
}

/**
 * Retrieve proposals, optionally filtered by status, ordered by created_at DESC.
 */
export function getProposals(db: Database.Database, status?: string): EvolutionProposal[] {
  try {
    let rows: ProposalRow[];

    if (status !== undefined) {
      rows = db.prepare(`
        SELECT * FROM evolution_proposals
        WHERE status = ?
        ORDER BY created_at DESC
      `).all(status) as ProposalRow[];
    } else {
      rows = db.prepare(`
        SELECT * FROM evolution_proposals
        ORDER BY created_at DESC
      `).all() as ProposalRow[];
    }

    return rows.map(rowToProposal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to get evolution proposals: ${msg}`,
      'consciousness_evolution_store_error',
      { status, cause: msg },
    );
  }
}

/**
 * Update the status of an existing proposal and bump its updated_at timestamp.
 */
export function updateProposalStatus(db: Database.Database, id: string, status: string): void {
  if (!id || !status) {
    throw new ConsciousnessError(
      'updateProposalStatus: id and status are required',
      'consciousness_evolution_invalid_proposal',
      { id, status },
    );
  }

  try {
    const info = db.prepare(`
      UPDATE evolution_proposals
      SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(status, id);

    if (info.changes === 0) {
      log.warn({ id, status }, 'updateProposalStatus: no row updated (unknown id?)');
    } else {
      log.debug({ id, status }, 'Proposal status updated');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to update proposal status: ${msg}`,
      'consciousness_evolution_store_error',
      { id, status, cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// Failure patterns
// ---------------------------------------------------------------------------

/**
 * UPSERT a failure signature — increments occurrence_count and updates
 * last_seen when the signature already exists.
 */
export function recordFailure(db: Database.Database, errorSignature: string): void {
  if (!errorSignature || typeof errorSignature !== 'string') {
    throw new ConsciousnessError(
      'recordFailure: errorSignature must be a non-empty string',
      'consciousness_evolution_invalid_failure',
      { errorSignature },
    );
  }

  try {
    db.prepare(`
      INSERT INTO failure_patterns
        (error_signature, occurrence_count, first_seen, last_seen, resolved)
      VALUES
        (?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0)
      ON CONFLICT(error_signature) DO UPDATE SET
        occurrence_count = occurrence_count + 1,
        last_seen        = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(errorSignature);

    log.debug({ errorSignature }, 'Failure pattern recorded');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to record failure pattern: ${msg}`,
      'consciousness_evolution_store_error',
      { errorSignature, cause: msg },
    );
  }
}

/**
 * Retrieve unresolved failure patterns with occurrence_count >= minCount.
 *
 * @param minCount - Minimum occurrence_count threshold (default 1).
 */
export function getUnresolvedFailures(db: Database.Database, minCount: number = 1): FailurePattern[] {
  try {
    const rows = db.prepare(`
      SELECT * FROM failure_patterns
      WHERE resolved = 0 AND occurrence_count >= ?
      ORDER BY occurrence_count DESC
    `).all(minCount) as FailureRow[];

    return rows.map(rowToFailure);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to get unresolved failures: ${msg}`,
      'consciousness_evolution_store_error',
      { minCount, cause: msg },
    );
  }
}

/**
 * Mark a failure pattern as resolved.
 */
export function resolveFailure(db: Database.Database, id: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new ConsciousnessError(
      'resolveFailure: id must be a positive integer',
      'consciousness_evolution_invalid_failure',
      { id },
    );
  }

  try {
    const info = db.prepare(`
      UPDATE failure_patterns SET resolved = 1 WHERE id = ?
    `).run(id);

    if (info.changes === 0) {
      log.warn({ id }, 'resolveFailure: no row updated (unknown id?)');
    } else {
      log.debug({ id }, 'Failure pattern resolved');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to resolve failure pattern: ${msg}`,
      'consciousness_evolution_store_error',
      { id, cause: msg },
    );
  }
}
