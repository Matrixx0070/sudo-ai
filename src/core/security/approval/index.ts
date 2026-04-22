/**
 * Public API barrel for the exec approval gate.
 *
 * Import from this file to access all approval functionality:
 *
 *   import { isAllowlisted, requestApproval, waitForDecision, approve, deny, listPending } from '.../security/approval/index.js';
 */

export { isAllowlisted } from './allowlist.js';
export {
  requestApproval,
  waitForDecision,
  approve,
  deny,
  listPending,
  APPROVAL_EXPIRY_MS,
} from './approval-registry.js';
export { approveCommand, denyCommand, listPendingCommand } from './cli.js';
export type { ApprovalRecord, ApprovalDecision, ApprovalMode } from './types.js';
export { isValidUuid, parseApprovalMode } from './types.js';
