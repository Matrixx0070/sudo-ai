/**
 * CLI helper functions for the exec approval gate.
 *
 * These are thin wrappers around the approval-registry that surface
 * human-readable output. They are wired into the sudo-ai CLI as:
 *
 *   sudo-ai approve <id>
 *   sudo-ai deny <id>
 *   sudo-ai approvals  (list pending)
 */

import { approve, deny, listPending } from './approval-registry.js';
import { isValidUuid } from './types.js';

// ---------------------------------------------------------------------------
// Exported CLI command handlers
// ---------------------------------------------------------------------------

/**
 * Approve a pending exec request by ID.
 * Prints a human-readable confirmation to stdout on success.
 *
 * @param id - UUID of the approval to approve.
 */
export async function approveCommand(id: string): Promise<void> {
  if (!isValidUuid(id)) {
    console.error(`Error: "${id}" is not a valid approval ID (must be a UUID).`);
    process.exitCode = 1;
    return;
  }

  try {
    await approve(id);
    console.log(`Approved: ${id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error approving ${id}: ${msg}`);
    process.exitCode = 1;
  }
}

/**
 * Deny a pending exec request by ID.
 * Prints a human-readable confirmation to stdout on success.
 *
 * @param id - UUID of the approval to deny.
 */
export async function denyCommand(id: string): Promise<void> {
  if (!isValidUuid(id)) {
    console.error(`Error: "${id}" is not a valid approval ID (must be a UUID).`);
    process.exitCode = 1;
    return;
  }

  try {
    await deny(id);
    console.log(`Denied: ${id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error denying ${id}: ${msg}`);
    process.exitCode = 1;
  }
}

/**
 * List all pending approval requests.
 * Prints a formatted table to stdout (or a message if none pending).
 */
export async function listPendingCommand(): Promise<void> {
  try {
    const records = await listPending();

    if (records.length === 0) {
      console.log('No pending approval requests.');
      return;
    }

    console.log(`\nPending approval requests (${records.length}):\n`);
    for (const r of records) {
      const age = Math.round((Date.now() - new Date(r.requestedAt).getTime()) / 1000);
      console.log(`  ID:      ${r.id}`);
      console.log(`  Command: ${r.command}`);
      if (r.reason) console.log(`  Reason:  ${r.reason}`);
      console.log(`  Age:     ${age}s ago`);
      console.log(`  Approve: sudo-ai approve ${r.id}`);
      console.log(`  Deny:    sudo-ai deny ${r.id}`);
      console.log('');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error listing pending approvals: ${msg}`);
    process.exitCode = 1;
  }
}
