/**
 * @file bridge-protocol.test.ts
 * @description Tests for IDE Bridge protocol — method routing and dispatch.
 *
 * Covers: initialize handshake, chat.send (stream/non-stream), abort,
 *         set_model, interrupt, session CRUD, unknown methods, phase guards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildBridgeRouter, dispatchMessage } from '../../src/core/ide/bridge-protocol.js';
import { createConnection, initializeConnection } from '../../src/core/ide/bridge-session.js';
import { getServerEpoch, resetServerEpoch } from '../../src/core/ide/bridge-auth.js';
import { BridgeErrorCode, BRIDGE_PROTOCOL_VERSION } from '../../shared-types/bridge-protocol.js';
import type { BridgeConnection, BridgeRouterDeps } from '../../src/core/ide/bridge-types.js';
import type { BridgeClientMessage, BridgeServerEvent } from '../../shared-types/bridge-protocol.js';

// ---------------------------------------------------------------------------
// Mock Dependencies
// ---------------------------------------------------------------------------

function createMockSession(sessionId: string) {
  const session: any = {
    id: sessionId,
    channel: 'ide',
    peerId: 'peer-1',
    state: 'active',
    model: undefined,
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  // save() returns the session object
  session.save = vi.fn().mockResolvedValue(session);
  return session;
}

function createMockDeps(): BridgeRouterDeps {
  const mockSession = createMockSession('sess-1');
  return {
    sessionManager: {
      getOrCreate: vi.fn().mockResolvedValue(mockSession),
      get: vi.fn().mockResolvedValue(mockSession),
      save: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
    },
    agentLoop: {
      run: vi.fn().mockResolvedValue({
        text: 'Hello from agent',
        attachments: [],
      }),
    },
    progressBroadcaster: {
      subscribe: vi.fn().mockReturnValue(() => {}),
      emit: vi.fn(),
    },
    hookManager: {
      emit: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createMockConnection(): BridgeConnection {
  const ws = {
    readyState: 1, // OPEN
    ping: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
  };
  const conn = createConnection(ws as any);
  // Initialize the connection so it's in 'ready' phase
  initializeConnection(conn, {
    epoch: getServerEpoch(),
    sessionJwt: 'test-jwt',
    tokenExpiresAt: Date.now() + 3600000,
    capabilities: { streaming: true, toolApproval: true },
    multiplexMode: 'single-session',
    primarySessionId: 'sess-1',
  });
  return conn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BridgeProtocol — initialize', () => {
  let deps: BridgeRouterDeps;
  let events: BridgeServerEvent[];

  beforeEach(() => {
    resetServerEpoch();
    deps = createMockDeps();
    events = [];
  });

  it('handles initialize handshake', async () => {
    const router = buildBridgeRouter(deps, { gatewayToken: 'test-token', jwtTtlMs: 3600000 }, (e) => events.push(e));
    const conn = createConnection(wsMock());
    // Initialize needs to be called on a connection in 'connecting' phase
    // Actually, our dispatchMessage checks phase, so let's use the mock connection which is already 'ready'
    // But initialize should work on 'connecting' connections too
    // The phase check in dispatchMessage allows 'initialize' regardless of phase

    const msg: BridgeClientMessage = {
      id: '1',
      method: 'initialize',
      params: {
        clientInfo: { name: 'vscode', version: '1.92.0' },
        capabilities: { streaming: true, toolApproval: true },
        multiplexMode: 'single-session',
      },
    };

    const response = await dispatchMessage(msg, conn, router, deps);

    expect(response.id).toBe('1');
    expect(response.result).toBeTruthy();
    const result = response.result as any;
    expect(result.sessionId).toBeTruthy();
    expect(result.sessionJwt).toBeTruthy();
    expect(result.serverInfo.name).toBe('sudo-ai');
    expect(result.capabilities.streaming).toBe(true);
    expect(result.epoch).toBeTruthy();
  });
});

describe('BridgeProtocol — chat.send', () => {
  let deps: BridgeRouterDeps;
  let conn: BridgeConnection;
  let events: BridgeServerEvent[];

  beforeEach(() => {
    resetServerEpoch();
    deps = createMockDeps();
    conn = createMockConnection();
    events = [];
  });

  it('chat.send (non-streaming) returns full result', async () => {
    const router = buildBridgeRouter(deps, { gatewayToken: 'test-token', jwtTtlMs: 3600000 }, (e) => events.push(e));

    const msg: BridgeClientMessage = {
      id: '2',
      method: 'chat.send',
      params: {
        sessionId: 'sess-1',
        message: 'Hello',
        stream: false,
      },
    };

    const response = await dispatchMessage(msg, conn, router, deps);

    expect(response.id).toBe('2');
    expect(response.result).toBeTruthy();
    const result = response.result as any;
    expect(result.text).toBe('Hello from agent');
    expect(deps.agentLoop.run).toHaveBeenCalledWith('sess-1', 'Hello', undefined);
  });

  it('chat.send (streaming) emits stream events', async () => {
    // Make agentLoop.run call the onEvent handler
    (deps.agentLoop.run as any).mockImplementation(
      (sid: string, msg: string, onEvent?: Function) => {
        if (onEvent) {
          onEvent({ type: 'stream-chunk', chunk: 'Hello' });
          onEvent({ type: 'stream-chunk', chunk: ' world' });
          onEvent({ type: 'done' });
        }
        return { text: 'Hello world', attachments: [] };
      },
    );

    const router = buildBridgeRouter(deps, { gatewayToken: 'test-token', jwtTtlMs: 3600000 }, (e) => events.push(e));

    const msg: BridgeClientMessage = {
      id: '3',
      method: 'chat.send',
      params: {
        sessionId: 'sess-1',
        message: 'Hello',
        stream: true,
      },
    };

    const response = await dispatchMessage(msg, conn, router, deps);

    expect(response.id).toBe('3');
    expect(response.result).toBeTruthy();
    // Should have emitted stream.start and stream.complete events
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].event).toBe('stream.start');
    expect(events[events.length - 1].event).toBe('stream.complete');
  });

  it('chat.send returns error for missing sessionId', async () => {
    const router = buildBridgeRouter(deps, { gatewayToken: 'test-token', jwtTtlMs: 3600000 }, (e) => events.push(e));

    const msg: BridgeClientMessage = {
      id: '4',
      method: 'chat.send',
      params: { message: 'Hello' },
    };

    const response = await dispatchMessage(msg, conn, router, deps);

    expect(response.error).toBeTruthy();
    expect(response.error!.code).toBe(BridgeErrorCode.INVALID_REQUEST);
  });
});

describe('BridgeProtocol — control methods', () => {
  let deps: BridgeRouterDeps;
  let conn: BridgeConnection;
  let events: BridgeServerEvent[];

  beforeEach(() => {
    resetServerEpoch();
    deps = createMockDeps();
    conn = createMockConnection();
    events = [];
  });

  it('set_model updates session model', async () => {
    // Create a mutable session mock that the set_model handler can modify
    const mutableSession = createMockSession('sess-1');
    (deps.sessionManager.get as any).mockResolvedValue(mutableSession);

    const router = buildBridgeRouter(deps, { gatewayToken: 'test-token', jwtTtlMs: 3600000 }, (e) => events.push(e));

    const msg: BridgeClientMessage = {
      id: '5',
      method: 'set_model',
      params: { sessionId: 'sess-1', model: 'gpt-4' },
    };

    const response = await dispatchMessage(msg, conn, router, deps);

    expect(response.result).toBeTruthy();
    const result = response.result as any;
    expect(result.model).toBe('gpt-4');
  });

  it('interrupt aborts running operation', async () => {
    // Set up an active abort controller on the connection
    const controller = new AbortController();
    conn.abortController = controller;

    const router = buildBridgeRouter(deps, { gatewayToken: 'test-token', jwtTtlMs: 3600000 }, (e) => events.push(e));

    const msg: BridgeClientMessage = {
      id: '6',
      method: 'interrupt',
      params: { sessionId: 'sess-1' },
    };

    const response = await dispatchMessage(msg, conn, router, deps);

    expect(response.result).toBeTruthy();
    const result = response.result as any;
    expect(result.interrupted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('interrupt returns error when no operation running', async () => {
    const router = buildBridgeRouter(deps, { gatewayToken: 'test-token', jwtTtlMs: 3600000 }, (e) => events.push(e));

    // No abort controller set
    conn.abortController = null;

    const msg: BridgeClientMessage = {
      id: '7',
      method: 'interrupt',
      params: { sessionId: 'sess-1' },
    };

    const response = await dispatchMessage(msg, conn, router, deps);

    expect(response.error).toBeTruthy();
    expect(response.error!.code).toBe(BridgeErrorCode.INTERRUPT_FAILED);
  });
});

describe('BridgeProtocol — session methods', () => {
  let deps: BridgeRouterDeps;
  let conn: BridgeConnection;
  let events: BridgeServerEvent[];

  beforeEach(() => {
    resetServerEpoch();
    deps = createMockDeps();
    conn = createMockConnection();
    events = [];
  });

  it('session.create creates a new session', async () => {
    (deps.sessionManager.getOrCreate as any).mockResolvedValue(createMockSession('sess-new'));

    const router = buildBridgeRouter(deps, { gatewayToken: 'test-token', jwtTtlMs: 3600000 }, (e) => events.push(e));

    const msg: BridgeClientMessage = {
      id: '8',
      method: 'session.create',
      params: { tabId: 'tab-1' },
    };

    const response = await dispatchMessage(msg, conn, router, deps);

    expect(response.result).toBeTruthy();
    const result = response.result as any;
    expect(result.sessionId).toBeTruthy();
    expect(result.peerId).toBeTruthy();
  });

  it('session.list returns sessions for connection', async () => {
    const router = buildBridgeRouter(deps, { gatewayToken: 'test-token', jwtTtlMs: 3600000 }, (e) => events.push(e));

    const msg: BridgeClientMessage = {
      id: '9',
      method: 'session.list',
      params: {},
    };

    const response = await dispatchMessage(msg, conn, router, deps);

    expect(response.result).toBeTruthy();
    const result = response.result as any;
    expect(result.sessions).toBeInstanceOf(Array);
  });

  it('session.archive archives a session', async () => {
    const router = buildBridgeRouter(deps, { gatewayToken: 'test-token', jwtTtlMs: 3600000 }, (e) => events.push(e));

    const msg: BridgeClientMessage = {
      id: '10',
      method: 'session.archive',
      params: { sessionId: 'sess-1' },
    };

    const response = await dispatchMessage(msg, conn, router, deps);

    expect(response.result).toBeTruthy();
    const result = response.result as any;
    expect(result.archived).toBe(true);
    expect(deps.sessionManager.archive).toHaveBeenCalledWith('sess-1');
  });
});

describe('BridgeProtocol — error cases', () => {
  let deps: BridgeRouterDeps;
  let conn: BridgeConnection;
  let events: BridgeServerEvent[];

  beforeEach(() => {
    resetServerEpoch();
    deps = createMockDeps();
    conn = createMockConnection();
    events = [];
  });

  it('returns METHOD_NOT_FOUND for unknown methods', async () => {
    const router = buildBridgeRouter(deps, { gatewayToken: 'test-token', jwtTtlMs: 3600000 }, (e) => events.push(e));

    const msg: BridgeClientMessage = {
      id: '99',
      method: 'unknown.method' as any,
      params: {},
    };

    const response = await dispatchMessage(msg, conn, router, deps);

    expect(response.error).toBeTruthy();
    expect(response.error!.code).toBe(BridgeErrorCode.METHOD_NOT_FOUND);
  });

  it('returns AUTH_FAILED for non-initialize methods on uninitialized connection', async () => {
    const ws = { readyState: 1, ping: vi.fn(), close: vi.fn(), send: vi.fn() };
    const uninitializedConn = createConnection(ws as any);
    // Connection is still in 'connecting' phase (not initialized)

    const router = buildBridgeRouter(deps, { gatewayToken: 'test-token', jwtTtlMs: 3600000 }, (e) => events.push(e));

    const msg: BridgeClientMessage = {
      id: '100',
      method: 'chat.send',
      params: { sessionId: 'sess-1', message: 'Hello' },
    };

    const response = await dispatchMessage(msg, uninitializedConn, router, deps);

    expect(response.error).toBeTruthy();
    expect(response.error!.code).toBe(BridgeErrorCode.AUTH_FAILED);
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function wsMock() {
  return {
    readyState: 1,
    ping: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
  };
}