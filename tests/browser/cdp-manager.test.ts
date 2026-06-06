import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CDPManager, type CDPManagerState } from '../../src/core/tools/builtin/browser/cdp-manager.js';

// -- Module-level mock for playwright-core -----------------------------------

vi.mock('playwright-core', () => {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
    mainFrame: vi.fn().mockReturnValue({ url: 'about:blank' }),
    route: vi.fn(),
    context: () => mockContext,
  };

  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    pages: vi.fn().mockReturnValue([mockPage]),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    newCDPSession: vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue({ target: { targetId: 'tid-1' } }),
      detach: vi.fn().mockResolvedValue(undefined),
    }),
  };

  const mockBrowser = {
    contexts: vi.fn().mockReturnValue([mockContext]),
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(mockBrowser),
      connectOverCDP: vi.fn().mockResolvedValue(mockBrowser),
    },
  };
});

// -- Tests -------------------------------------------------------------------

describe('CDPManager', () => {
  let manager: CDPManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CDPManager({ headless: true, exposeCDP: true, cdpPort: 9222 });
  });

  // 1. Connect
  it('connect: establishes CDP connection', async () => {
    await manager.connect();
    const state = manager.getState();
    expect(state.connectionState).toBe('connected');
    expect(state.endpoint).toBeTruthy();
  });

  // 2. Disconnect
  it('disconnect: cleans up properly', async () => {
    await manager.connect();
    await manager.createSession('https://a.com');
    await manager.disconnect();
    const state = manager.getState();
    expect(state.connectionState).toBe('disconnected');
    expect(state.sessions).toHaveLength(0);
    expect(state.activeSessionId).toBeUndefined();
    expect(state.endpoint).toBeUndefined();
  });

  // 3. Create session
  it('createSession: opens new tab', async () => {
    await manager.connect();
    const session = await manager.createSession('https://example.com');
    expect(session.id).toBeTruthy();
    expect(session.url).toBe('https://example.com');
    expect(session.state).toBe('connected');
    expect(manager.getActiveSession()?.id).toBe(session.id);
  });

  // 4. Switch session
  it('switchSession: changes active tab', async () => {
    await manager.connect();
    const s1 = await manager.createSession('https://a.com');
    const s2 = await manager.createSession('https://b.com');
    expect(manager.getActiveSession()?.id).toBe(s2.id);
    await manager.switchSession(s1.id);
    expect(manager.getActiveSession()?.id).toBe(s1.id);
  });

  it('switchSession: throws on unknown session', async () => {
    await manager.connect();
    await expect(manager.switchSession('no-such-id')).rejects.toThrow('Session not found');
  });

  // 5. Close session
  it('closeSession: closes tab', async () => {
    await manager.connect();
    const session = await manager.createSession('https://test.com');
    await manager.closeSession(session.id);
    expect(manager.listSessions().find((s) => s.id === session.id)).toBeUndefined();
    expect(manager.getActiveSession()).toBeUndefined();
  });

  it('closeSession: no-ops on missing session', async () => {
    await manager.connect();
    await expect(manager.closeSession('nonexistent')).resolves.toBeUndefined();
  });

  // 6. List sessions
  it('listSessions: returns all sessions', async () => {
    await manager.connect();
    await manager.createSession('https://a.com');
    await manager.createSession('https://b.com');
    await manager.createSession('https://c.com');
    expect(manager.listSessions()).toHaveLength(3);
  });

  // 7. State management
  it('state management: tracks connection lifecycle', async () => {
    let state: CDPManagerState = manager.getState();
    expect(state.connectionState).toBe('disconnected');

    await manager.connect();
    state = manager.getState();
    expect(state.connectionState).toBe('connected');

    await manager.disconnect();
    state = manager.getState();
    expect(state.connectionState).toBe('disconnected');
  });

  it('state management: rejects operations when disconnected', async () => {
    await expect(manager.createSession()).rejects.toThrow('not connected');
  });

  // 8. Stats tracking
  it('stats tracking: reports session count and endpoint', async () => {
    await manager.connect();
    await manager.createSession('https://x.com');
    await manager.createSession('https://y.com');
    const state = manager.getState();
    expect(state.sessions.length).toBe(2);
    expect(state.endpoint).toMatch(/localhost/);
    expect(state.activeSessionId).toBeTruthy();
  });
});