/**
 * @file security/audit-chain.ts
 * @description Cryptographic hash chain primitives for tamper-evident audit logs.
 *
 * Each audit record links to its predecessor via SHA-256 hash chaining.
 * verifyChainRows detects any gap or tamper in the recorded sequence.
 *
 * Uses node:crypto — no external dependencies.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('security:audit-chain');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single row as required by the chain verifier.
 * `payload` must be reconstructed identically to what was hashed at insert time.
 */
export interface ChainEntry {
  id: string;
  timestamp: string;
  payload: string;
  prev_hash: string;
  hash: string;
}

/** Result returned by verifyChainRows. */
export interface ChainVerifyResult {
  ok: boolean;
  breakAt?: string;   // id of the first row whose hash does not match
  rowsChecked: number;
}

/**
 * A structured commitment triple that gets persisted via recordTriple().
 * Captures a mistake acknowledged, the lesson learned, and the forward
 * commitment with an optional TTL.
 */
export interface CommitmentTriple {
  mistake: string;
  learned: string;
  commitment: string;
  ttl_days: number;
  resource?: string;
}

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hex digest that links one row to its predecessor.
 *
 * Concatenation order: prevHash || timestamp || payload
 * This order must be used identically in record(), backfillHashes(), and
 * verifyChain() — it is the single canonical definition.
 *
 * @param prevHash  - Hash of the preceding row, or '' for the first row.
 * @param timestamp - ISO-8601 timestamp of the current row (stored in DB).
 * @param payload   - Canonically serialised JSON string of the row content.
 * @returns Lowercase hex SHA-256 digest.
 */
export function computeHash(
  prevHash: string,
  timestamp: string,
  payload: string,
): string {
  if (typeof prevHash !== 'string') throw new TypeError('computeHash: prevHash must be a string');
  if (typeof timestamp !== 'string' || !timestamp) throw new TypeError('computeHash: timestamp must be a non-empty string');
  if (typeof payload !== 'string') throw new TypeError('computeHash: payload must be a string');

  return createHash('sha256')
    .update(prevHash + timestamp + payload)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------

/**
 * Verify an ordered sequence of ChainEntry rows (oldest-first).
 *
 * For each row the function recomputes:
 *   expected = SHA-256(row.prev_hash || row.timestamp || row.payload)
 * and compares it against the stored row.hash.
 *
 * The first mismatch terminates the walk and is reported via breakAt.
 * An empty rows array is considered a valid (trivially intact) chain.
 *
 * @param rows - Chain entries in ascending rowid order.
 * @returns ChainVerifyResult with ok=true if chain is intact.
 */
export function verifyChainRows(rows: ChainEntry[]): ChainVerifyResult {
  if (rows.length === 0) {
    log.debug('verifyChainRows: empty chain — trivially ok');
    return { ok: true, rowsChecked: 0 };
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const expected = computeHash(row.prev_hash, row.timestamp, row.payload);

    if (expected !== row.hash) {
      log.warn(
        { rowId: row.id, index: i, expected: expected.slice(0, 16), stored: row.hash.slice(0, 16) },
        'verifyChainRows: hash mismatch detected',
      );
      return { ok: false, breakAt: row.id, rowsChecked: i + 1 };
    }
  }

  log.debug({ rowsChecked: rows.length }, 'verifyChainRows: chain intact');
  return { ok: true, rowsChecked: rows.length };
}
