/**
 * @file session-outcome-listener.test.ts
 * @description Tests for SessionOutcomeListener, schema migration, and AgentConfig fields.
 * Covers spec §7 Builder C tests 11–27.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import {
  SessionOutcomeListener,
  type SessionOutcomeListenerOptions,
} from '../../src/core/outcomes/session-outcome-listener.js';
import {
  HeuristicGoalEvaluator,
  type GoalEvalResult,
} from '../../src/core/outcomes/goal-evaluator.js';
import {
  migrateSchema,
  type AgentConfig,
  type AgentRow,
  type CreateAgentInput,
  type UpdateAgentInput,
} from '../../src/core/agents/config-types.js';

// ---------------------------------------------------------------------------
// Mock OutcomesLedger
// ---------------------------------------------------------------------------

interface MockLedger {
  record: ReturnType<typeof vi.fn>;
}

function makeMockLedger(): MockLedger {
  return { record: vi.fn() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStateMachine(): EventEmitter {
  return new EventEmitter();
}

function makeListenerOpts(
  overrides: Partial<SessionOutcomeListenerOptions> = {},
): SessionOutcomeListenerOptions & { ledger: MockLedger } {
  const ledger = makeMockLedger();
  return {
    stateMachine: makeStateMachine(),
    ledger: ledger as unknown as SessionOutcomeListenerOptions['ledger'],
    evaluator: new HeuristicGoalEvaluator(),
    getSessionGoal: (_id: string) => 'Complete the task',
    getRecentMessages: (_id: string, _n: number) => [
      { role: 'assistant', content: 'done' },
    ],
    getToolStats: (_id: string) => ({ successCount: 8, failureCount: 2 }),
    ...overrides,
  } as SessionOutcomeListenerOptions & { ledger: MockLedger };
}

// ---------------------------------------------------------------------------
// 11–15: SessionOutcomeListener construction and event handling
// ---------------------------------------------------------------------------

describe('SessionOutcomeListener — attach/detach', () => {
  it('11: attaches listeners for both terminal events on construction', () => {
    const stateMachine = makeStateMachine();
    const opts = makeListenerOpts({ stateMachine });
    new SessionOutcomeListener(opts as unknown as SessionOutcomeListenerOptions);
    expect(stateMachine.listenerCount('session:status:terminated')).toBe(1);
    expect(stateMachine.listenerCount('session:status:archived')).toBe(1);
  });

  it('12: _onTerminal called when "terminated" event fires', async () => {
    const stateMachine = makeStateMachine();
    const opts = makeListenerOpts({ stateMachine });
    new SessionOutcomeListener(opts as unknown as SessionOutcomeListenerOptions);

    stateMachine.emit('session:status:terminated', {
      sessionId: 'sess-1',
      from: 'running',
      to: 'terminated',
    });

    // Give async handler time to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(opts.ledger.record).toHaveBeenCalledOnce();
  });

  it('13: _onTerminal called when "archived" event fires', async () => {
    const stateMachine = makeStateMachine();
    const opts = makeListenerOpts({ stateMachine });
    new SessionOutcomeListener(opts as unknown as SessionOutcomeListenerOptions);

    stateMachine.emit('session:status:archived', {
      sessionId: 'sess-2',
      from: 'idle',
      to: 'archived',
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(opts.ledger.record).toHaveBeenCalledOnce();
  });

  it('14: duplicate sessionId is skipped (idempotency)', async () => {
    const stateMachine = makeStateMachine();
    const opts = makeListenerOpts({ stateMachine });
    new SessionOutcomeListener(opts as unknown as SessionOutcomeListenerOptions);

    // Fire both terminal events for the same session
    stateMachine.emit('session:status:terminated', {
      sessionId: 'sess-dup',
      from: 'running',
      to: 'terminated',
    });
    stateMachine.emit('session:status:archived', {
      sessionId: 'sess-dup',
      from: 'running',
      to: 'archived',
    });

    await new Promise((r) => setTimeout(r, 50));
    // Should only have been recorded once
    expect(opts.ledger.record).toHaveBeenCalledOnce();
  });

  it('15: destroy() detaches both listeners', () => {
    const stateMachine = makeStateMachine();
    const opts = makeListenerOpts({ stateMachine });
    const listener = new SessionOutcomeListener(
      opts as unknown as SessionOutcomeListenerOptions,
    );

    expect(stateMachine.listenerCount('session:status:terminated')).toBe(1);
    expect(stateMachine.listenerCount('session:status:archived')).toBe(1);

    listener.destroy();

    expect(stateMachine.listenerCount('session:status:terminated')).toBe(0);
    expect(stateMachine.listenerCount('session:status:archived')).toBe(0);
  });

  it('destroy() is idempotent — calling twice does not throw', () => {
    const stateMachine = makeStateMachine();
    const opts = makeListenerOpts({ stateMachine });
    const listener = new SessionOutcomeListener(
      opts as unknown as SessionOutcomeListenerOptions,
    );
    listener.destroy();
    expect(() => listener.destroy()).not.toThrow();
  });

  it('skips session with no goal set', async () => {
    const stateMachine = makeStateMachine();
    const opts = makeListenerOpts({
      stateMachine,
      getSessionGoal: (_id: string) => null,
    });
    new SessionOutcomeListener(opts as unknown as SessionOutcomeListenerOptions);

    stateMachine.emit('session:status:terminated', {
      sessionId: 'sess-no-goal',
      from: 'running',
      to: 'terminated',
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(opts.ledger.record).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 16–20: Ledger integration (mock ledger)
// ---------------------------------------------------------------------------

describe('SessionOutcomeListener — ledger integration', () => {
  it('16: records type=goal_completed on success outcome', async () => {
    const stateMachine = makeStateMachine();
    const opts = makeListenerOpts({
      stateMachine,
      getRecentMessages: () => [{ role: 'assistant', content: 'done' }],
      getToolStats: () => ({ successCount: 8, failureCount: 2 }),
    });
    new SessionOutcomeListener(opts as unknown as SessionOutcomeListenerOptions);

    stateMachine.emit('session:status:terminated', {
      sessionId: 'sess-success',
      from: 'running',
      to: 'terminated',
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(opts.ledger.record).toHaveBeenCalledOnce();
    const callArg = opts.ledger.record.mock.calls[0][0];
    expect(callArg.type).toBe('goal_completed');
  });

  it('17: records type=error on failure outcome', async () => {
    const stateMachine = makeStateMachine();
    const opts = makeListenerOpts({
      stateMachine,
      getRecentMessages: () => [{ role: 'assistant', content: 'error occurred' }],
      getToolStats: () => ({ successCount: 1, failureCount: 9 }),
    });
    new SessionOutcomeListener(opts as unknown as SessionOutcomeListenerOptions);

    stateMachine.emit('session:status:terminated', {
      sessionId: 'sess-fail',
      from: 'running',
      to: 'terminated',
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(opts.ledger.record).toHaveBeenCalledOnce();
    const callArg = opts.ledger.record.mock.calls[0][0];
    expect(callArg.type).toBe('error');
  });

  it('18: sourceSessionId matches the session that reached terminal state', async () => {
    const stateMachine = makeStateMachine();
    const opts = makeListenerOpts({ stateMachine });
    new SessionOutcomeListener(opts as unknown as SessionOutcomeListenerOptions);

    stateMachine.emit('session:status:terminated', {
      sessionId: 'sess-id-check',
      from: 'running',
      to: 'terminated',
    });

    await new Promise((r) => setTimeout(r, 50));
    const callArg = opts.ledger.record.mock.calls[0][0];
    expect(callArg.sourceSessionId).toBe('sess-id-check');
  });

  it('19: evidence array is non-empty in metadata', async () => {
    const stateMachine = makeStateMachine();
    const opts = makeListenerOpts({
      stateMachine,
      getRecentMessages: () => [{ role: 'assistant', content: 'done' }],
      getToolStats: () => ({ successCount: 7, failureCount: 3 }),
    });
    new SessionOutcomeListener(opts as unknown as SessionOutcomeListenerOptions);

    stateMachine.emit('session:status:terminated', {
      sessionId: 'sess-evidence',
      from: 'running',
      to: 'terminated',
    });

    await new Promise((r) => setTimeout(r, 50));
    const callArg = opts.ledger.record.mock.calls[0][0];
    expect(Array.isArray(callArg.metadata?.evidence)).toBe(true);
    expect((callArg.metadata?.evidence as string[]).length).toBeGreaterThan(0);
  });

  it('20: outcome_json is written in metadata', async () => {
    const stateMachine = makeStateMachine();
    const opts = makeListenerOpts({
      stateMachine,
      getRecentMessages: () => [{ role: 'assistant', content: 'done' }],
      getToolStats: () => ({ successCount: 8, failureCount: 2 }),
    });
    new SessionOutcomeListener(opts as unknown as SessionOutcomeListenerOptions);

    stateMachine.emit('session:status:terminated', {
      sessionId: 'sess-json',
      from: 'running',
      to: 'terminated',
    });

    await new Promise((r) => setTimeout(r, 50));
    const callArg = opts.ledger.record.mock.calls[0][0];
    const outcomeJson = callArg.metadata?.outcome_json as string;
    expect(typeof outcomeJson).toBe('string');
    const parsed = JSON.parse(outcomeJson) as GoalEvalResult;
    expect(['success', 'failure', 'partial']).toContain(parsed.outcome);
  });
});

// ---------------------------------------------------------------------------
// 21–24: Schema migration
// ---------------------------------------------------------------------------

describe('migrateSchema', () => {
  function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    // Create the base tables that migrations will extend
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        system_text TEXT,
        tools_json TEXT NOT NULL DEFAULT '[]',
        skills_json TEXT NOT NULL DEFAULT '[]',
        mcp_servers_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    return db;
  }

  it('21: migrateSchema is idempotent — safe to call twice without throwing', () => {
    const db = makeDb();
    expect(() => migrateSchema(db)).not.toThrow();
    expect(() => migrateSchema(db)).not.toThrow();
  });

  it('22: adds all 4 columns after migration', () => {
    const db = makeDb();
    migrateSchema(db);

    // Verify columns exist by inserting and retrieving data
    db.exec(`INSERT INTO agents (id, version, name, model, created_at, updated_at)
             VALUES ('a1', 1, 'Test', 'claude-3', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`);
    db.exec(`UPDATE agents SET goal = 'test goal', sandbox_policy_json = '{}' WHERE id = 'a1'`);

    db.exec(`INSERT INTO sessions (id) VALUES ('s1')`);
    db.exec(`UPDATE sessions SET goal = 'session goal', outcome_json = '{"outcome":"success"}' WHERE id = 's1'`);

    const agentRow = db.prepare('SELECT goal, sandbox_policy_json FROM agents WHERE id = ?').get('a1') as {
      goal: string;
      sandbox_policy_json: string;
    };
    expect(agentRow.goal).toBe('test goal');
    expect(agentRow.sandbox_policy_json).toBe('{}');

    const sessionRow = db.prepare('SELECT goal, outcome_json FROM sessions WHERE id = ?').get('s1') as {
      goal: string;
      outcome_json: string;
    };
    expect(sessionRow.goal).toBe('session goal');
    expect(sessionRow.outcome_json).toBe('{"outcome":"success"}');
  });

  it('23: existing data is preserved after migration', () => {
    const db = makeDb();

    // Insert data before migration
    db.exec(`INSERT INTO agents (id, version, name, model, created_at, updated_at)
             VALUES ('a2', 1, 'PreExisting', 'claude-3', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`);

    migrateSchema(db);

    const row = db.prepare('SELECT name FROM agents WHERE id = ?').get('a2') as { name: string };
    expect(row.name).toBe('PreExisting');
  });

  it('24: handles pre-existing columns gracefully (no throw on duplicate ALTER)', () => {
    const db = makeDb();
    // Add columns manually first
    db.exec('ALTER TABLE agents ADD COLUMN goal TEXT');
    db.exec('ALTER TABLE sessions ADD COLUMN goal TEXT');

    // migrateSchema should silently skip these and still apply the rest
    expect(() => migrateSchema(db)).not.toThrow();

    // Verify the other columns got added
    db.exec(`INSERT INTO agents (id, version, name, model, created_at, updated_at)
             VALUES ('a3', 1, 'Test', 'claude-3', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`);
    db.exec(`UPDATE agents SET sandbox_policy_json = '{"enabled":true}' WHERE id = 'a3'`);
    const row = db.prepare('SELECT sandbox_policy_json FROM agents WHERE id = ?').get('a3') as {
      sandbox_policy_json: string;
    };
    expect(row.sandbox_policy_json).toBe('{"enabled":true}');
  });
});

// ---------------------------------------------------------------------------
// 25–27: AgentConfig fields — serialization and null handling
// ---------------------------------------------------------------------------

describe('AgentConfig fields — goal and sandbox_policy', () => {
  it('25: AgentConfig type accepts goal field', () => {
    const config: AgentConfig = {
      id: 'agent-1',
      name: 'Test',
      model: 'claude-3',
      system: null,
      tools: [],
      skills: [],
      mcp_servers: [],
      version: 1,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      archived_at: null,
      goal: 'Build something great',
      sandbox_policy: null,
    };
    expect(config.goal).toBe('Build something great');
    expect(config.sandbox_policy).toBeNull();
  });

  it('26: AgentRow goal and sandbox_policy_json roundtrip via JSON', () => {
    const policy: Record<string, unknown> = {
      enabled: true,
      network: 'none',
      cpuSeconds: 30,
      memoryMB: 512,
    };
    const row: AgentRow = {
      id: 'agent-2',
      version: 1,
      name: 'Test',
      model: 'claude-3',
      system_text: null,
      tools_json: '[]',
      skills_json: '[]',
      mcp_servers_json: '[]',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      archived_at: null,
      goal: 'My goal',
      sandbox_policy_json: JSON.stringify(policy),
    };

    const parsed = JSON.parse(row.sandbox_policy_json!) as Record<string, unknown>;
    expect(parsed['enabled']).toBe(true);
    expect(parsed['network']).toBe('none');
    expect(row.goal).toBe('My goal');
  });

  it('27: null handling — goal null and sandbox_policy_json null are valid AgentRow states', () => {
    const row: AgentRow = {
      id: 'agent-3',
      version: 1,
      name: 'Test',
      model: 'claude-3',
      system_text: null,
      tools_json: '[]',
      skills_json: '[]',
      mcp_servers_json: '[]',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      archived_at: null,
      goal: null,
      sandbox_policy_json: null,
    };

    expect(row.goal).toBeNull();
    expect(row.sandbox_policy_json).toBeNull();

    // CreateAgentInput and UpdateAgentInput accept optional fields
    const createInput: CreateAgentInput = {
      name: 'Agent',
      model: 'claude-3',
      goal: null,
      sandbox_policy: null,
    };
    expect(createInput.goal).toBeNull();

    const updateInput: UpdateAgentInput = {
      version: 1,
      goal: undefined,
      sandbox_policy: undefined,
    };
    expect(updateInput.goal).toBeUndefined();
    expect(updateInput.sandbox_policy).toBeUndefined();
  });
});
