/**
 * @file bridge-session.ts
 * @description Connection state machine and heartbeat management for IDE Bridge.
 *
 * Manages the lifecycle of bridge connections: phase transitions, heartbeat
 * enforcement, AbortController management, and epoch tracking for reconnection.
 *
 * @module ide-bridge-session
 */

import type { WebSocket } from 'ws';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import type {
  BridgeConnection,
  PendingToolApproval,
} from './bridge-types.js';
import type { BridgeConnectionPhase, BridgeClientCapabilities, BridgeMultiplexMode } from '../../../shared-types/bridge-protocol.js';

const log = createLogger('ide:bridge-session');

// ---------------------------------------------------------------------------
// Connection Factory
// ---------------------------------------------------------------------------

/**
 * Create a new BridgeConnection from an accepted WebSocket.
 *
 * Starts in 'connecting' phase; transitions to 'initializing' when the
 * client sends an initialize message, then 'ready' after successful handshake.
 */
export function createConnection(ws: WebSocket): BridgeConnection {
  const connection: BridgeConnection = {
    peerId: genId(),
    ws,
    phase: 'connecting',
    epoch: 0,
    sessionJwt: '',
    tokenExpiresAt: 0,
    capabilities: null,
    multiplexMode: 'single-session',
    lastHeartbeat: Date.now(),
    pendingApprovals: new Map(),
    abortController: null,
    primarySessionId: null,
    sessions: new Map(),
    connectedAt: Date.now(),
  };

  log.debug({ peerId: connection.peerId }, 'New bridge connection created');
  return connection;
}

// ---------------------------------------------------------------------------
// Phase Transitions
// ---------------------------------------------------------------------------

/** Valid phase transitions. */
const VALID_TRANSITIONS: Record<BridgeConnectionPhase, BridgeConnectionPhase[]> = {
  connecting: ['initializing'],
  initializing: ['ready', 'closing'],
  ready: ['reconnecting', 'closing'],
  reconnecting: ['ready', 'closing'],
  closing: [],
};

/**
 * Transition a connection to a new phase.
 * Throws if the transition is invalid.
 */
export function transitionPhase(
  connection: BridgeConnection,
  newPhase: BridgeConnectionPhase,
): void {
  const current = connection.phase;
  const allowed = VALID_TRANSITIONS[current];

  if (!allowed.includes(newPhase)) {
    log.warn({ peerId: connection.peerId, from: current, to: newPhase }, 'Invalid phase transition');
    throw new Error(`Invalid phase transition: ${current} → ${newPhase}`);
  }

  log.debug({ peerId: connection.peerId, from: current, to: newPhase }, 'Phase transition');
  connection.phase = newPhase;
}

/**
 * Initialize a connection after successful handshake.
 * Transitions from 'connecting' to 'initializing' (if needed) then to 'ready'.
 */
export function initializeConnection(
  connection: BridgeConnection,
  params: {
    epoch: number;
    sessionJwt: string;
    tokenExpiresAt: number;
    capabilities: BridgeClientCapabilities;
    multiplexMode: BridgeMultiplexMode;
    primarySessionId: string;
  },
): void {
  // Transition to initializing if still in connecting
  if (connection.phase === 'connecting') {
    transitionPhase(connection, 'initializing');
  }

  // Apply params
  connection.epoch = params.epoch;
  connection.sessionJwt = params.sessionJwt;
  connection.tokenExpiresAt = params.tokenExpiresAt;
  connection.capabilities = params.capabilities;
  connection.multiplexMode = params.multiplexMode;
  connection.primarySessionId = params.primarySessionId;
  connection.sessions.set('primary', params.primarySessionId);
  connection.lastHeartbeat = Date.now();

  // Transition to ready
  transitionPhase(connection, 'ready');

  log.info({
    peerId: connection.peerId,
    sessionId: params.primarySessionId,
    multiplexMode: params.multiplexMode,
  }, 'Bridge connection initialized');
}

// ---------------------------------------------------------------------------
// Heartbeat Management
// ---------------------------------------------------------------------------

/**
 * Check if a connection's heartbeat has timed out.
 * @param connection - The connection to check.
 * @param timeoutMs - Heartbeat timeout in milliseconds.
 * @returns True if the connection has timed out.
 */
export function isHeartbeatTimedOut(connection: BridgeConnection, timeoutMs: number): boolean {
  const elapsed = Date.now() - connection.lastHeartbeat;
  return elapsed > timeoutMs;
}

/**
 * Record a heartbeat from the client.
 */
export function recordHeartbeat(connection: BridgeConnection): void {
  connection.lastHeartbeat = Date.now();
}

/**
 * Start heartbeat monitoring for a connection.
 * Sends ping frames at the configured interval and checks for timeouts.
 *
 * @param connection - The connection to monitor.
 * @param intervalMs - Ping interval in milliseconds.
 * @param timeoutMs - Timeout threshold in milliseconds.
 * @param onTimeout - Callback when the connection times out.
 * @returns A cleanup function that stops heartbeat monitoring.
 */
export function startHeartbeatMonitor(
  connection: BridgeConnection,
  intervalMs: number,
  timeoutMs: number,
  onTimeout: (connection: BridgeConnection) => void,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;

  timer = setInterval(() => {
    // Check for timeout
    if (isHeartbeatTimedOut(connection, timeoutMs)) {
      log.warn({ peerId: connection.peerId }, 'Bridge heartbeat timeout');
      if (timer) clearInterval(timer);
      onTimeout(connection);
      return;
    }

    // Send ping
    if (connection.ws.readyState === connection.ws.OPEN) {
      connection.ws.ping();
    }
  }, intervalMs);

  // Unref the timer so it doesn't keep the process alive
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// ---------------------------------------------------------------------------
// AbortController Management
// ---------------------------------------------------------------------------

/**
 * Create a new AbortController for a chat.send operation.
 * Replaces any existing controller (aborts previous if still active).
 */
export function createAbortController(connection: BridgeConnection): AbortController {
  // Abort any previous operation
  if (connection.abortController && !connection.abortController.signal.aborted) {
    connection.abortController.abort();
  }

  const controller = new AbortController();
  connection.abortController = controller;
  return controller;
}

/**
 * Abort the current operation on a connection.
 * @returns True if there was an active operation to abort.
 */
export function abortCurrentOperation(connection: BridgeConnection): boolean {
  if (connection.abortController && !connection.abortController.signal.aborted) {
    connection.abortController.abort();
    connection.abortController = null;
    log.debug({ peerId: connection.peerId }, 'Aborted current operation');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pending Approvals
// ---------------------------------------------------------------------------

/**
 * Add a pending tool approval request.
 */
export function addPendingApproval(connection: BridgeConnection, approval: PendingToolApproval): void {
  connection.pendingApprovals.set(approval.id, approval);
  log.debug({ peerId: connection.peerId, approvalId: approval.id, tool: approval.toolName }, 'Added pending approval');
}

/**
 * Resolve a pending tool approval request.
 * @returns True if the approval was found and resolved.
 */
export function resolvePendingApproval(
  connection: BridgeConnection,
  approvalId: string,
  approved: boolean,
  reason?: string,
): boolean {
  const approval = connection.pendingApprovals.get(approvalId);
  if (!approval) {
    log.debug({ peerId: connection.peerId, approvalId }, 'Pending approval not found');
    return false;
  }

  connection.pendingApprovals.delete(approvalId);
  approval.resolve(approved, reason);
  log.debug({ peerId: connection.peerId, approvalId, approved }, 'Resolved pending approval');
  return true;
}

/**
 * Reject all pending approvals on a connection (e.g., during disconnect).
 */
export function rejectAllPendingApprovals(connection: BridgeConnection, reason: string): void {
  for (const [id, approval] of connection.pendingApprovals) {
    approval.reject(new Error(reason));
  }
  const count = connection.pendingApprovals.size;
  connection.pendingApprovals.clear();
  if (count > 0) {
    log.debug({ peerId: connection.peerId, count }, 'Rejected all pending approvals');
  }
}

// ---------------------------------------------------------------------------
// Connection Cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up a connection: abort operations, reject approvals, close WebSocket.
 */
export function cleanupConnection(connection: BridgeConnection): void {
  // Abort any running operation
  abortCurrentOperation(connection);

  // Reject all pending approvals
  rejectAllPendingApprovals(connection, 'Connection closed');

  // Close WebSocket if still open
  if (connection.ws.readyState === connection.ws.OPEN || connection.ws.readyState === connection.ws.CLOSING) {
    try {
      connection.ws.close(1000, 'Bridge connection cleanup');
    } catch {
      // Ignore errors during close
    }
  }

  log.info({ peerId: connection.peerId }, 'Bridge connection cleaned up');
}