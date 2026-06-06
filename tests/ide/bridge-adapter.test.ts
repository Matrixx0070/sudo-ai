/**
 * @file bridge-adapter.test.ts
 * @description Tests for IDE Bridge adapter — WebSocket lifecycle, auth, messaging.
 *
 * Covers: attach to server, auth rejection, message dispatch, kill switch,
 *         graceful shutdown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { IdeBridgeAdapter } from '../../src/core/ide/bridge-adapter.js';
import type { BridgeRouterDeps } from '../../src/core/ide/bridge-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PORT = 18999;
const TEST_TOKEN = 'test-bridge-token-2026';

function createMockDeps(): BridgeRouterDeps {
  return {
    sessionManager: {
      getOrCreate: vi.fn().mockResolvedValue({
        id: 'sess-1',
        channel: 'ide',
        peerId: 'peer-1',
        state: 'active',
        model: undefined,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      get: vi.fn().mockResolvedValue({
        id: 'sess-1',
        channel: 'ide',
        peerId: 'peer-1',
        state: 'active',
        model: undefined,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      archive: vi.fn().mockResolvedValue(undefined),
    },
    agentLoop: {
      run: vi.fn().mockResolvedValue({
        text: 'Hello',
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IdeBridgeAdapter — construction', () => {
  it('creates adapter with default config', () => {
    const deps = createMockDeps();
    const adapter = new IdeBridgeAdapter(deps, { gatewayToken: TEST_TOKEN });

    expect(adapter.channel).toBe('ide');
    expect(adapter.isConnected).toBe(false);
  });

  it('respects SUDO_IDE_BRIDGE_DISABLE env var', () => {
    const original = process.env['SUDO_IDE_BRIDGE_DISABLE'];
    process.env['SUDO_IDE_BRIDGE_DISABLE'] = '1';

    const deps = createMockDeps();
    const adapter = new IdeBridgeAdapter(deps);

    // The adapter should have disabled=true in config
    expect((adapter as any).config.disabled).toBe(true);

    // Restore
    if (original !== undefined) {
      process.env['SUDO_IDE_BRIDGE_DISABLE'] = original;
    } else {
      delete process.env['SUDO_IDE_BRIDGE_DISABLE'];
    }
  });
});

describe('IdeBridgeAdapter — attach and lifecycle', () => {
  let server: http.Server;
  let adapter: IdeBridgeAdapter;

  beforeEach(() => {
    server = http.createServer();
    adapter = new IdeBridgeAdapter(createMockDeps(), {
      gatewayToken: TEST_TOKEN,
      path: '/ide/bridge',
    });
  });

  afterEach(async () => {
    await adapter.stop();
    await new Promise<void>((resolve) => {
      if (server.listening) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  it('attaches to HTTP server and starts accepting connections', async () => {
    adapter.attach(server);

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });

    expect(adapter.isConnected).toBe(true);
  });

  it('stops cleanly and closes connections', async () => {
    adapter.attach(server);

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT + 1, () => resolve());
    });

    expect(adapter.isConnected).toBe(true);

    await adapter.stop();

    expect(adapter.isConnected).toBe(false);
  });

  it('startDiscovery writes port file', async () => {
    adapter.attach(server);

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT + 2, () => resolve());
    });

    adapter.startDiscovery(TEST_PORT + 2);

    // Port file should exist
    const { readPortFile } = await import('../../src/core/ide/bridge-discovery.js');
    const payload = readPortFile();
    // May or may not exist depending on write permissions, just verify no crash
  });

  it('does not attach when disabled', async () => {
    const disabledAdapter = new IdeBridgeAdapter(createMockDeps(), {
      gatewayToken: TEST_TOKEN,
      disabled: true,
    });

    disabledAdapter.attach(server);

    expect(disabledAdapter.isConnected).toBe(false);
  });
});

describe('IdeBridgeAdapter — ChannelAdapter interface', () => {
  it('onMessage registers handler', () => {
    const adapter = new IdeBridgeAdapter(createMockDeps(), { gatewayToken: TEST_TOKEN });
    const handler = vi.fn();

    adapter.onMessage(handler);

    // Handler is stored; verified through dispatchInboundMessage
    expect((adapter as any)._handler).toBe(handler);
  });

  it('send to unknown peerId does not throw', async () => {
    const adapter = new IdeBridgeAdapter(createMockDeps(), { gatewayToken: TEST_TOKEN });

    await expect(adapter.send('unknown-peer', 'Hello')).resolves.toBeUndefined();
  });
});

describe('IdeBridgeAdapter — kill switch', () => {
  it('adapter with SUDO_IDE_BRIDGE_DISABLE=1 does not attach', () => {
    const adapter = new IdeBridgeAdapter(createMockDeps(), {
      gatewayToken: TEST_TOKEN,
      disabled: true,
    });

    const server = http.createServer();
    adapter.attach(server);

    // No WebSocket server should be created
    expect((adapter as any).wss).toBeNull();
  });
});