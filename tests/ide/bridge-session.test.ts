/**
 * @file bridge-session.test.ts
 * @description Tests for IDE Bridge connection state machine and heartbeat.
 *
 * Covers: createConnection, phase transitions, heartbeat timeout, abort controller,
 *         pending approvals, cleanup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BridgeConnection } from '../../src/core/ide/bridge-types.js';
import {
  createConnection,
  transitionPhase,
  initializeConnection,
  isHeartbeatTimedOut,
  recordHeartbeat,
  startHeartbeatMonitor,
  createAbortController,
  abortCurrentOperation,
  addPendingApproval,
  resolvePendingApproval,
  rejectAllPendingApprovals,
  cleanupConnection,
} from '../../src/core/ide/bridge-session.js';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

function createMockWs(): any {
  const ws = {
    readyState: 1, // WebSocket.OPEN
    OPEN: 1,       // WebSocket.OPEN constant
    CLOSING: 2,    // WebSocket.CLOSING constant
    ping: vi.fn(),
    close: vi.fn(),
  };
  return ws;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BridgeSession — createConnection', () => {
  it('creates a connection in connecting phase', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);

    expect(conn.peerId).toBeTruthy();
    expect(conn.phase).toBe('connecting');
    expect(conn.epoch).toBe(0);
    expect(conn.capabilities).toBeNull();
    expect(conn.primarySessionId).toBeNull();
    expect(conn.pendingApprovals.size).toBe(0);
    expect(conn.sessions.size).toBe(0);
    expect(conn.abortController).toBeNull();
  });
});

describe('BridgeSession — phase transitions', () => {
  it('transitions connecting → initializing → ready', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);

    // Manual transition to initializing
    transitionPhase(conn, 'initializing');
    expect(conn.phase).toBe('initializing');

    // initializeConnection transitions to ready
    initializeConnection(conn, {
      epoch: 12345,
      sessionJwt: 'jwt-token',
      tokenExpiresAt: Date.now() + 3600000,
      capabilities: { streaming: true, toolApproval: true },
      multiplexMode: 'single-session',
      primarySessionId: 'sess-1',
    });

    expect(conn.phase).toBe('ready');
    expect(conn.epoch).toBe(12345);
    expect(conn.primarySessionId).toBe('sess-1');
    expect(conn.capabilities).toEqual({ streaming: true, toolApproval: true });
  });

  it('rejects invalid phase transitions', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);

    // Cannot go from connecting directly to ready
    expect(() => transitionPhase(conn, 'ready')).toThrow('Invalid phase transition');

    // Cannot go from connecting to closing
    expect(() => transitionPhase(conn, 'closing')).toThrow('Invalid phase transition');
  });

  it('allows ready → reconnecting → ready cycle', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);

    initializeConnection(conn, {
      epoch: 100,
      sessionJwt: 'jwt',
      tokenExpiresAt: Date.now() + 3600000,
      capabilities: { streaming: true },
      multiplexMode: 'single-session',
      primarySessionId: 'sess-1',
    });

    expect(conn.phase).toBe('ready');

    transitionPhase(conn, 'reconnecting');
    expect(conn.phase).toBe('reconnecting');

    transitionPhase(conn, 'ready');
    expect(conn.phase).toBe('ready');
  });
});

describe('BridgeSession — heartbeat', () => {
  it('detects timed-out heartbeats', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);
    conn.lastHeartbeat = Date.now() - 120000; // 2 minutes ago

    expect(isHeartbeatTimedOut(conn, 60000)).toBe(true);
  });

  it('detects fresh heartbeats as not timed out', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);
    conn.lastHeartbeat = Date.now();

    expect(isHeartbeatTimedOut(conn, 60000)).toBe(false);
  });

  it('records heartbeat timestamps', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);
    const before = Date.now();

    recordHeartbeat(conn);

    expect(conn.lastHeartbeat).toBeGreaterThanOrEqual(before);
  });

  it('starts and stops heartbeat monitor', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);
    const onTimeout = vi.fn();

    const cleanup = startHeartbeatMonitor(conn, 50, 5000, onTimeout);

    // Should not have timed out yet
    expect(onTimeout).not.toHaveBeenCalled();

    // Stop monitoring
    cleanup();

    // After cleanup, no more timer should fire
    // (We can't easily test the timer firing without waiting, so just verify cleanup works)
  });
});

describe('BridgeSession — AbortController', () => {
  it('creates a new AbortController for a connection', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);

    const controller = createAbortController(conn);

    expect(controller).toBeInstanceOf(AbortController);
    expect(conn.abortController).toBe(controller);
    expect(controller.signal.aborted).toBe(false);
  });

  it('aborts previous controller when creating a new one', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);

    const controller1 = createAbortController(conn);
    expect(controller1.signal.aborted).toBe(false);

    const controller2 = createAbortController(conn);
    expect(controller1.signal.aborted).toBe(true);
    expect(controller2.signal.aborted).toBe(false);
    expect(conn.abortController).toBe(controller2);
  });

  it('abortCurrentOperation aborts and clears the controller', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);

    createAbortController(conn);
    const result = abortCurrentOperation(conn);

    expect(result).toBe(true);
    expect(conn.abortController).toBeNull();
  });

  it('abortCurrentOperation returns false when no operation is active', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);

    const result = abortCurrentOperation(conn);
    expect(result).toBe(false);
  });
});

describe('BridgeSession — pending approvals', () => {
  it('adds and resolves a pending approval (approved)', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);

    const approvalPromise = new Promise<boolean>((resolve, reject) => {
      addPendingApproval(conn, {
        id: 'approval-1',
        toolName: 'bash',
        toolArgs: { command: 'ls' },
        sessionId: 'sess-1',
        createdAt: Date.now(),
        resolve,
        reject,
      });
    });

    expect(conn.pendingApprovals.size).toBe(1);

    const resolved = resolvePendingApproval(conn, 'approval-1', true);
    expect(resolved).toBe(true);
    expect(conn.pendingApprovals.size).toBe(0);

    return expect(approvalPromise).resolves.toBe(true);
  });

  it('resolves a pending approval (denied)', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);

    let resolveValue: boolean | undefined;
    const approvalPromise = new Promise<boolean>((resolve) => {
      addPendingApproval(conn, {
        id: 'approval-2',
        toolName: 'bash',
        toolArgs: { command: 'rm -rf /' },
        sessionId: 'sess-1',
        createdAt: Date.now(),
        resolve: (v: boolean) => { resolveValue = v; resolve(v); },
        reject: () => {},
      });
    });

    // Resolve by tool name + session (using the simplified resolver)
    // Our resolvePendingApproval uses the ID-based resolver
    // For the simplified version, let's test resolvePendingApproval directly
    // Actually we need to test the resolvePendingApproval that takes the approval ID
    const result = resolvePendingApproval(conn, 'approval-2', false, 'dangerous command');
    expect(result).toBe(true);

    return expect(approvalPromise).resolves.toBe(false);
  });

  it('rejects all pending approvals on disconnect', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);

    let rejectionCount = 0;
    for (let i = 0; i < 3; i++) {
      addPendingApproval(conn, {
        id: `approval-${i}`,
        toolName: 'bash',
        toolArgs: {},
        sessionId: 'sess-1',
        createdAt: Date.now(),
        resolve: () => {},
        reject: () => { rejectionCount++; },
      });
    }

    expect(conn.pendingApprovals.size).toBe(3);

    rejectAllPendingApprovals(conn, 'Connection closed');

    expect(conn.pendingApprovals.size).toBe(0);
    expect(rejectionCount).toBe(3);
  });
});

describe('BridgeSession — cleanup', () => {
  it('cleans up connection: aborts operations, rejects approvals, closes ws', () => {
    const ws = createMockWs();
    const conn = createConnection(ws);

    // Set up some state
    createAbortController(conn);
    addPendingApproval(conn, {
      id: 'approval-1',
      toolName: 'bash',
      toolArgs: {},
      sessionId: 'sess-1',
      createdAt: Date.now(),
      resolve: () => {},
      reject: () => {},
    });

    cleanupConnection(conn);

    expect(conn.abortController).toBeNull();
    expect(conn.pendingApprovals.size).toBe(0);
    expect(ws.close).toHaveBeenCalled();
  });
});