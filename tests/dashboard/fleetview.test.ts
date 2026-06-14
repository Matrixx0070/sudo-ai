/**
 * @file tests/dashboard/fleetview.test.ts
 * @description Tests for the FleetView dashboard slice (gap #25 slice 1).
 *
 * Covers:
 *   - AgentSwarm.snapshot() — shape + idle flag + task truncation
 *   - DashboardServer.getLiveAgents() — empty default when no source registered,
 *     pass-through when source registered, throw-safe (empty default on error)
 *   - /api/agents/live route — 401 without auth, 200 with auth
 *   - Prometheus metrics — sudo_agents_* keys present
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
  DashboardServer,
  registerDashboardGlobals,
} from '../../src/core/dashboard/dashboard-server.js';
import { registerRoutes } from '../../src/core/dashboard/dashboard-routes.js';
import type {
  DashboardConfig,
  LiveAgentsData,
  AgentSwarmSource,
} from '../../src/core/dashboard/dashboard-types.js';
import { AgentSwarm } from '../../src/core/agent/swarm.js';

// ---------------------------------------------------------------------------
// Test scaffolding (mirrors dashboard-server.test.ts patterns)
// ---------------------------------------------------------------------------

let testPortCounter = 19300;

function getTestConfig(overrides?: Partial<DashboardConfig>): DashboardConfig {
  return {
    port: testPortCounter++,
    authToken: 'fleetview-test-token-xyz',
    refreshIntervalMs: 30000,
    ...overrides,
  };
}

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
  dashboardServer: DashboardServer;
}

function startTestServer(config?: DashboardConfig): Promise<TestServer> {
  const cfg = config ?? getTestConfig();
  return new Promise((resolve, reject) => {
    const server = new DashboardServer(cfg);
    const httpServer = http.createServer((req, res) => registerRoutes(req, res, server, cfg));
    httpServer.listen(cfg.port, '127.0.0.1', () => {
      const addr = httpServer.address() as import('node:net').AddressInfo;
      const close = (): Promise<void> =>
        new Promise((res, rej) => httpServer.close((err) => (err ? rej(err) : res())));
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, close, dashboardServer: server });
    });
    httpServer.on('error', reject);
  });
}

interface RawResponse {
  status: number;
  body: string;
}

function rawGet(url: string, opts: { token?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Minimal duck-typed deps for AgentSwarm.
 *
 * IMPORTANT: this duck-type intentionally satisfies the constructor's
 * `.get`/`.call`/`.execute` smoke checks but does NOT implement the wider
 * surface (`getOrCreate`, `save`, `pushCompletionBus`, etc.) — these tests
 * exercise `snapshot()` only, which reads the private `active` map and
 * `queue`. NEVER call `swarm.spawn()` from this file; if a future test needs
 * to, build a richer mock or use the existing tests/agent/ fixtures.
 */
function makeSwarm(): AgentSwarm {
  const brain = { call: () => Promise.resolve('') };
  const toolRegistry = { execute: () => Promise.resolve({ success: true }) };
  const sessionManager = { get: () => Promise.resolve(null) };
  return new AgentSwarm(brain, toolRegistry, sessionManager);
}

/** Reach into AgentSwarm's private `active` map to inject a fake agent for snapshot testing. */
function injectActiveAgent(
  swarm: AgentSwarm,
  fields: { id: string; task: string; startedAt: Date; lastHeartbeat: number },
): void {
  const internal = swarm as unknown as {
    active: Map<string, { id: string; task: string; startedAt: Date; controller: AbortController; lastHeartbeat: number }>;
  };
  internal.active.set(fields.id, {
    id: fields.id,
    task: fields.task,
    startedAt: fields.startedAt,
    controller: new AbortController(),
    lastHeartbeat: fields.lastHeartbeat,
  });
}

// ---------------------------------------------------------------------------
// AgentSwarm.snapshot() — unit
// ---------------------------------------------------------------------------

describe('AgentSwarm.snapshot() (gap #25 slice 1)', () => {
  it('returns empty shape when no agents are active', () => {
    const swarm = makeSwarm();
    const snap = swarm.snapshot();
    expect(snap.spawned).toEqual([]);
    expect(snap.slotsUsed).toBe(0);
    expect(snap.slotsMax).toBeGreaterThan(0);
    expect(snap.queueWaiting).toBe(0);
  });

  it('renders one injected agent with elapsed + heartbeat + non-idle', () => {
    const swarm = makeSwarm();
    const now = Date.now();
    injectActiveAgent(swarm, {
      id: 'agent-001',
      task: 'do a thing',
      startedAt: new Date(now - 3_000),
      lastHeartbeat: now - 1_000,
    });

    const snap = swarm.snapshot();
    expect(snap.spawned).toHaveLength(1);
    expect(snap.spawned[0]!.id).toBe('agent-001');
    expect(snap.spawned[0]!.task).toBe('do a thing');
    expect(snap.spawned[0]!.elapsedMs).toBeGreaterThanOrEqual(3_000);
    expect(snap.spawned[0]!.sinceHeartbeatMs).toBeGreaterThanOrEqual(1_000);
    expect(snap.spawned[0]!.idle).toBe(false);
  });

  it('flags an agent as idle when sinceHeartbeatMs crosses the threshold', () => {
    const swarm = makeSwarm();
    const now = Date.now();
    injectActiveAgent(swarm, {
      id: 'agent-002',
      task: 'silent agent',
      startedAt: new Date(now - 60_000),
      // 31s back (idle threshold is 30s)
      lastHeartbeat: now - 31_000,
    });
    const snap = swarm.snapshot();
    expect(snap.spawned[0]!.idle).toBe(true);
  });

  it('truncates long tasks with an ellipsis suffix', () => {
    const swarm = makeSwarm();
    const longTask = 'x'.repeat(300);
    injectActiveAgent(swarm, {
      id: 'agent-003',
      task: longTask,
      startedAt: new Date(),
      lastHeartbeat: Date.now(),
    });
    const snap = swarm.snapshot();
    const task = snap.spawned[0]!.task;
    expect(task.length).toBeLessThan(longTask.length);
    expect(task.endsWith('…')).toBe(true);
  });

  it('orders spawned by startedAt ascending', () => {
    const swarm = makeSwarm();
    const now = Date.now();
    injectActiveAgent(swarm, {
      id: 'newer',
      task: 'newer',
      startedAt: new Date(now - 1_000),
      lastHeartbeat: now,
    });
    injectActiveAgent(swarm, {
      id: 'older',
      task: 'older',
      startedAt: new Date(now - 10_000),
      lastHeartbeat: now,
    });
    const snap = swarm.snapshot();
    expect(snap.spawned.map((a) => a.id)).toEqual(['older', 'newer']);
  });
});

// ---------------------------------------------------------------------------
// DashboardServer.getLiveAgents() — unit + integration
// ---------------------------------------------------------------------------

describe('DashboardServer.getLiveAgents() (gap #25 slice 1)', () => {
  afterEach(() => {
    // Clean any source registration so cross-test pollution is impossible.
    // registerDashboardGlobals guards against undefined writes (intentional, so
    // partial updates don't clobber prior registrations), so we clear by
    // writing directly to the globalThis slot. Same pattern as the other two
    // afterEach blocks in this file.
    (globalThis as unknown as { __sudoAgentSwarm?: AgentSwarmSource }).__sudoAgentSwarm = undefined;
  });

  it('returns the zero default when no source is registered', () => {
    // Force a clean slate by re-registering with an explicit undefined.
    (globalThis as unknown as { __sudoAgentSwarm?: AgentSwarmSource }).__sudoAgentSwarm = undefined;
    const server = new DashboardServer(getTestConfig());
    const data = server.getLiveAgents();
    expect(data.spawned).toEqual([]);
    expect(data.slotsUsed).toBe(0);
    expect(data.slotsMax).toBe(0);
    expect(data.queueWaiting).toBe(0);
  });

  it('pass-through to a registered source', () => {
    const fake: LiveAgentsData = {
      spawned: [
        {
          id: 'a-1',
          task: 'fake task',
          startedAt: new Date().toISOString(),
          elapsedMs: 100,
          sinceHeartbeatMs: 50,
          idle: false,
        },
      ],
      slotsUsed: 1,
      slotsMax: 4,
      queueWaiting: 2,
    };
    registerDashboardGlobals({ agentSwarm: { getSnapshot: () => fake } });

    const server = new DashboardServer(getTestConfig());
    const data = server.getLiveAgents();
    expect(data).toEqual(fake);
  });

  it('returns the zero default when the source throws (never 500s the endpoint)', () => {
    registerDashboardGlobals({
      agentSwarm: {
        getSnapshot: () => {
          throw new Error('boom');
        },
      },
    });
    const server = new DashboardServer(getTestConfig());
    const data = server.getLiveAgents();
    expect(data.spawned).toEqual([]);
    expect(data.slotsMax).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// /api/agents/live route — integration
// ---------------------------------------------------------------------------

describe('/api/agents/live route (gap #25 slice 1)', () => {
  const servers: TestServer[] = [];
  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
    (globalThis as unknown as { __sudoAgentSwarm?: AgentSwarmSource }).__sudoAgentSwarm = undefined;
  });

  it('returns 401 without auth', async () => {
    const s = await startTestServer();
    servers.push(s);
    const r = await rawGet(`${s.baseUrl}/api/agents/live`);
    expect(r.status).toBe(401);
  });

  it('returns 200 with auth and zero-default body when no source registered', async () => {
    (globalThis as unknown as { __sudoAgentSwarm?: AgentSwarmSource }).__sudoAgentSwarm = undefined;
    const cfg = getTestConfig();
    const s = await startTestServer(cfg);
    servers.push(s);
    const r = await rawGet(`${s.baseUrl}/api/agents/live`, { token: cfg.authToken });
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body) as LiveAgentsData;
    expect(data.spawned).toEqual([]);
    expect(data.slotsMax).toBe(0);
    expect(data.queueWaiting).toBe(0);
  });

  it('returns 200 with the registered source payload', async () => {
    const fake: LiveAgentsData = {
      spawned: [
        {
          id: 'live-1',
          task: 'integration task',
          startedAt: new Date().toISOString(),
          elapsedMs: 1500,
          sinceHeartbeatMs: 200,
          idle: false,
        },
      ],
      slotsUsed: 1,
      slotsMax: 4,
      queueWaiting: 0,
    };
    registerDashboardGlobals({ agentSwarm: { getSnapshot: () => fake } });

    const cfg = getTestConfig();
    const s = await startTestServer(cfg);
    servers.push(s);
    const r = await rawGet(`${s.baseUrl}/api/agents/live`, { token: cfg.authToken });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual(fake);
  });
});

// ---------------------------------------------------------------------------
// Prometheus metrics — gap #25 keys present
// ---------------------------------------------------------------------------

describe('Prometheus metrics include FleetView keys (gap #25 slice 1)', () => {
  afterEach(() => {
    (globalThis as unknown as { __sudoAgentSwarm?: AgentSwarmSource }).__sudoAgentSwarm = undefined;
  });

  it('exports sudo_agents_* keys even without a registered source (zeros)', () => {
    (globalThis as unknown as { __sudoAgentSwarm?: AgentSwarmSource }).__sudoAgentSwarm = undefined;
    const server = new DashboardServer(getTestConfig());
    const m = server.getMetrics();
    expect(m['sudo_agents_spawned']).toBe(0);
    expect(m['sudo_agents_idle']).toBe(0);
    expect(m['sudo_agents_slots_used']).toBe(0);
    expect(m['sudo_agents_slots_max']).toBe(0);
    expect(m['sudo_agents_queue_waiting']).toBe(0);
  });

  it('reflects the registered source in Prometheus keys', () => {
    const fake: LiveAgentsData = {
      spawned: [
        {
          id: 'm1',
          task: 't',
          startedAt: new Date().toISOString(),
          elapsedMs: 1,
          sinceHeartbeatMs: 1,
          idle: true,
        },
        {
          id: 'm2',
          task: 't',
          startedAt: new Date().toISOString(),
          elapsedMs: 1,
          sinceHeartbeatMs: 1,
          idle: false,
        },
      ],
      slotsUsed: 2,
      slotsMax: 4,
      queueWaiting: 1,
    };
    registerDashboardGlobals({ agentSwarm: { getSnapshot: () => fake } });

    const server = new DashboardServer(getTestConfig());
    const m = server.getMetrics();
    expect(m['sudo_agents_spawned']).toBe(2);
    expect(m['sudo_agents_idle']).toBe(1);
    expect(m['sudo_agents_slots_used']).toBe(2);
    expect(m['sudo_agents_slots_max']).toBe(4);
    expect(m['sudo_agents_queue_waiting']).toBe(1);
  });
});
