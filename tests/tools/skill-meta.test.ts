/**
 * @file tests/tools/skill-meta.test.ts
 * @description Tests for the Wave 9C skill.* meta-cognition tools.
 *
 * Strategy:
 * - Mock logger to suppress output.
 * - Run from an isolated temp working dir so file-path DB access (resolved from
 *   <cwd>/data at import time) never touches the real production databases.
 * - Use in-memory better-sqlite3 for DB-backed fixtures (usage-stats, refine).
 * - Test each tool's execute() directly with a minimal ToolContext.
 * - Verify fail-open behavior when DBs are missing.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// Hermetic working directory.
//
// usage-stats.ts and refine.ts capture their DB paths at import time from
// `path.resolve('data')` (i.e. <cwd>/data) and open them via
// require('better-sqlite3') with { fileMustExist: true }. require() inside the
// source module is NOT intercepted by vi.mock (it resolves through Node's CJS
// resolver, returning the real driver), so the only way to keep these tools
// hermetic without editing production code is to control the working directory
// *before* the source modules are imported — vi.hoisted() runs ahead of the
// import statements below. Pointing cwd at an empty temp dir makes
// path.resolve('data') resolve to a directory with no audit.db/calibration.db,
// so the real driver throws on fileMustExist:true and the genuine fail-open
// path is exercised against controlled state rather than the real production
// data/audit.db and data/calibration.db at the repo root.
// ---------------------------------------------------------------------------

const { ORIGINAL_CWD, TMP_DATA_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  const original = process.cwd();
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'skill-meta-test-'));
  process.chdir(dir);
  return { ORIGINAL_CWD: original, TMP_DATA_DIR: dir };
});

// ---------------------------------------------------------------------------
// Mock logger — suppress output
// ---------------------------------------------------------------------------

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { usageStatsTool } from '../../src/core/tools/builtin/skill/tools/usage-stats.js';
import { refineTool } from '../../src/core/tools/builtin/skill/tools/refine.js';
import { federateTool } from '../../src/core/tools/builtin/skill/tools/federate.js';
import { composeTool } from '../../src/core/tools/builtin/skill/tools/compose.js';
import { explainTool } from '../../src/core/tools/builtin/skill/tools/explain.js';
import { registerSkillTools } from '../../src/core/tools/builtin/skill/index.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolContext } from '../../src/core/tools/types.js';
import fs from 'node:fs';

// Restore the original working directory and remove the temp dir once done.
afterAll(() => {
  try { process.chdir(ORIGINAL_CWD); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ToolContext for tests. */
const ctx: ToolContext = {
  sessionId: 'test-session-skill',
  workingDir: '/tmp',
  config: {},
  logger: {},
};

/** Build an in-memory audit DB with the audit_log schema. */
function makeAuditDb(): Database {
  const db = new DatabaseConstructor(':memory:');
  db.exec(`
    CREATE TABLE audit_log (
      id            TEXT PRIMARY KEY,
      timestamp     TEXT NOT NULL,
      actor         TEXT NOT NULL,
      action        TEXT NOT NULL,
      resource      TEXT NOT NULL,
      outcome       TEXT NOT NULL,
      metadata_json TEXT,
      prev_hash     TEXT NOT NULL DEFAULT '',
      hash          TEXT NOT NULL DEFAULT ''
    )
  `);
  return db;
}

/** Build an in-memory calibration DB. */
function makeCalibDb(): Database {
  const db = new DatabaseConstructor(':memory:');
  db.exec(`
    CREATE TABLE confidence_calibration (
      id        TEXT PRIMARY KEY,
      predicted REAL NOT NULL,
      outcome   INTEGER NOT NULL CHECK(outcome IN (0,1)),
      tag       TEXT,
      ts        INTEGER NOT NULL
    )
  `);
  return db;
}

let _seq = 0;

/** Insert a tool_call row into audit_log. */
function insertToolCall(
  db: Database,
  resource: string,
  outcome: 'success' | 'failure' | 'veto',
  ageDaysAgo = 0,
  durationMs?: number,
  errorKind?: string,
): void {
  const id = `tc-${++_seq}`;
  const ts = new Date(Date.now() - ageDaysAgo * 86_400_000).toISOString();
  const meta = JSON.stringify({
    durationMs: durationMs ?? 1000,
    ...(errorKind ? { errorKind } : {}),
  });
  db.prepare(
    `INSERT INTO audit_log (id, timestamp, actor, action, resource, outcome, metadata_json)
     VALUES (?, ?, 'system', 'tool_call', ?, ?, ?)`
  ).run(id, ts, resource, outcome, meta);
}

/** Insert a commitment/mistake row into audit_log. */
function insertMistakeRow(db: Database, resource: string, mistake: string, ageDaysAgo = 0): void {
  const id = `m-${++_seq}`;
  const ts = new Date(Date.now() - ageDaysAgo * 86_400_000).toISOString();
  const meta = JSON.stringify({ mistake, commitment: 'will fix', learned: 'lesson' });
  db.prepare(
    `INSERT INTO audit_log (id, timestamp, actor, action, resource, outcome, metadata_json)
     VALUES (?, ?, 'system', 'commitment', ?, 'success', ?)`
  ).run(id, ts, resource, meta);
}

// ---------------------------------------------------------------------------
// skill.usage-stats tests
//
// The tool resolves audit.db/calibration.db from <cwd>/data at import time; the
// hoisted chdir at the top of this file points cwd at an empty temp dir, so the
// tool genuinely fails open instead of reading the real production databases.
// The in-memory fixtures below exercise the schema/helpers without touching disk.
// ---------------------------------------------------------------------------

describe('skill.usage-stats', () => {
  let auditDb: Database;
  let calibDb: Database;

  beforeEach(() => {
    _seq = 0;
    auditDb = makeAuditDb();
    calibDb = makeCalibDb();
  });

  afterEach(() => {
    try { auditDb.close(); } catch { /* ignore */ }
    try { calibDb.close(); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('returns empty stats when no DB file exists (fail-open)', async () => {
    // Don't insert anything — DB files won't exist at test path
    const result = await usageStatsTool.execute({ toolName: 'nonexistent.tool', windowDays: 7 }, ctx);
    expect(result.success).toBe(true);
    // Either "No tool call records" or empty array
    expect(result.output).toBeTruthy();
  });

  it('has correct tool metadata', () => {
    expect(usageStatsTool.name).toBe('skill.usage-stats');
    expect(usageStatsTool.category).toBe('skill');
    expect(usageStatsTool.timeout).toBe(15_000);
    expect(usageStatsTool.parameters).toHaveProperty('toolName');
    expect(usageStatsTool.parameters).toHaveProperty('windowDays');
  });

  it('returns success with default windowDays when called without params', async () => {
    const result = await usageStatsTool.execute({}, ctx);
    expect(result.success).toBe(true);
  });

  it('validates windowDays bounds (clamped to 1–365)', async () => {
    const result = await usageStatsTool.execute({ windowDays: 0 }, ctx);
    // windowDays clamped to 1 — should not throw
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// skill.refine tests
// ---------------------------------------------------------------------------

describe('skill.refine', () => {
  it('has correct tool metadata', () => {
    expect(refineTool.name).toBe('skill.refine');
    expect(refineTool.category).toBe('skill');
    expect(refineTool.timeout).toBe(15_000);
    expect(refineTool.parameters['toolName']?.required).toBe(true);
    expect(refineTool.parameters['dryRun']?.default).toBe(true);
  });

  it('returns error when toolName is missing', async () => {
    const result = await refineTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/toolName is required/i);
  });

  it('returns error when toolName is blank', async () => {
    const result = await refineTool.execute({ toolName: '  ' }, ctx);
    expect(result.success).toBe(false);
  });

  it('fails open when audit DB is missing (returns empty issues)', async () => {
    const result = await refineTool.execute({ toolName: 'browser.navigate', dryRun: true }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const proposal = (result.data as { proposal: { issues: unknown[] } }).proposal;
    expect(Array.isArray(proposal.issues)).toBe(true);
  });

  it('dryRun=true is default and emits proposal without patching', async () => {
    const result = await refineTool.execute({ toolName: 'meta.self-test' }, ctx);
    expect(result.success).toBe(true);
    const proposal = (result.data as { proposal: { dryRun: boolean } }).proposal;
    expect(proposal.dryRun).toBe(true);
  });

  it('dryRun=false sets flag in proposal (no actual patching)', async () => {
    const result = await refineTool.execute({ toolName: 'meta.self-test', dryRun: false }, ctx);
    expect(result.success).toBe(true);
    const proposal = (result.data as { proposal: { dryRun: boolean } }).proposal;
    expect(proposal.dryRun).toBe(false);
  });

  it('includes proposedPatchHints array', async () => {
    const result = await refineTool.execute({ toolName: 'skill.usage-stats' }, ctx);
    expect(result.success).toBe(true);
    const proposal = (result.data as { proposal: { proposedPatchHints: string[] } }).proposal;
    expect(Array.isArray(proposal.proposedPatchHints)).toBe(true);
    expect(proposal.proposedPatchHints.length).toBeGreaterThanOrEqual(1);
  });

  it('reports sourceFileFound correctly for known skill tool', async () => {
    const result = await refineTool.execute({ toolName: 'skill.usage-stats' }, ctx);
    const proposal = (result.data as { proposal: { sourceFileFound: boolean; sourceFilePath: string | null } }).proposal;
    // skill category has tools/ subdirectory — file should be discoverable
    expect(typeof proposal.sourceFileFound).toBe('boolean');
    expect(typeof proposal.sourceFilePath === 'string' || proposal.sourceFilePath === null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// skill.federate tests
// ---------------------------------------------------------------------------

describe('skill.federate', () => {
  it('has correct tool metadata', () => {
    expect(federateTool.name).toBe('skill.federate');
    expect(federateTool.category).toBe('skill');
    expect(federateTool.timeout).toBe(20_000);
    expect(federateTool.parameters['action']?.required).toBe(true);
    expect(federateTool.parameters['action']?.enum).toContain('publish');
    expect(federateTool.parameters['action']?.enum).toContain('fetch');
  });

  it('returns error for invalid action', async () => {
    const result = await federateTool.execute({ action: 'invalid' }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/publish.*fetch/i);
  });

  it('returns ok:false when SUDO_FEDERATION_URL is not set', async () => {
    const orig = process.env['SUDO_FEDERATION_URL'];
    delete process.env['SUDO_FEDERATION_URL'];
    delete process.env['SUDO_AUDIT_CHAIN_URL'];

    const result = await federateTool.execute({ action: 'publish', payload: { test: true } }, ctx);
    expect(result.success).toBe(true);
    expect((result.data as { ok: boolean }).ok).toBe(false);
    expect((result.data as { reason: string }).reason).toMatch(/federation not configured/i);

    if (orig !== undefined) process.env['SUDO_FEDERATION_URL'] = orig;
  });

  it('returns ok:false for fetch when federation not configured', async () => {
    const orig = process.env['SUDO_FEDERATION_URL'];
    delete process.env['SUDO_FEDERATION_URL'];

    const result = await federateTool.execute({ action: 'fetch' }, ctx);
    expect(result.success).toBe(true);
    expect((result.data as { ok: boolean }).ok).toBe(false);

    if (orig !== undefined) process.env['SUDO_FEDERATION_URL'] = orig;
  });

  it('uses globalThis auditChainSync when env is set', async () => {
    process.env['SUDO_FEDERATION_URL'] = 'http://localhost:9999';
    const appendToChain = vi.fn().mockResolvedValue(undefined);
    (globalThis as Record<string, unknown>)['__auditChainSync'] = { appendToChain };

    const result = await federateTool.execute({ action: 'publish', payload: { hello: 'world' } }, ctx);
    expect(result.success).toBe(true);
    expect(appendToChain).toHaveBeenCalledOnce();

    delete process.env['SUDO_FEDERATION_URL'];
    delete (globalThis as Record<string, unknown>)['__auditChainSync'];
  });

  it('handles fetchPeerTail and filters by eventType', async () => {
    process.env['SUDO_FEDERATION_URL'] = 'http://localhost:9999';
    const mockEvents = [
      { id: 'e1', eventType: 'skill.federate', payload: { x: 1 }, ts: Date.now() },
      { id: 'e2', eventType: 'other.event', payload: {}, ts: Date.now() },
    ];
    const fetchPeerTail = vi.fn().mockResolvedValue(mockEvents);
    const appendToChain = vi.fn();
    (globalThis as Record<string, unknown>)['__auditChainSync'] = { appendToChain, fetchPeerTail };

    const result = await federateTool.execute({ action: 'fetch', eventType: 'skill.federate' }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { ok: boolean; events: unknown[]; totalFetched: number };
    expect(data.ok).toBe(true);
    expect(data.totalFetched).toBe(2);
    expect(data.events.length).toBe(1); // only skill.federate events

    delete process.env['SUDO_FEDERATION_URL'];
    delete (globalThis as Record<string, unknown>)['__auditChainSync'];
  });
});

// ---------------------------------------------------------------------------
// skill.compose tests
// ---------------------------------------------------------------------------

describe('skill.compose', () => {
  it('has correct tool metadata', () => {
    expect(composeTool.name).toBe('skill.compose');
    expect(composeTool.category).toBe('skill');
    expect(composeTool.timeout).toBe(15_000);
    expect(composeTool.parameters['goal']?.required).toBe(true);
  });

  it('returns error when goal is missing', async () => {
    const result = await composeTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/goal is required/i);
  });

  it('returns error when goal is blank', async () => {
    const result = await composeTool.execute({ goal: '   ' }, ctx);
    expect(result.success).toBe(false);
  });

  it('returns proposal with chain array using fallback catalog', async () => {
    // No global registry set — uses fallback
    const saved = ToolRegistry.getGlobal();
    ToolRegistry['_global'] = null; // force fallback

    const result = await composeTool.execute({ goal: 'search the web for youtube video ideas' }, ctx);
    expect(result.success).toBe(true);
    const proposal = (result.data as { proposal: { chain: string[]; rationale: string; estimatedDurationMs: number } }).proposal;
    expect(Array.isArray(proposal.chain)).toBe(true);
    expect(typeof proposal.rationale).toBe('string');
    expect(typeof proposal.estimatedDurationMs).toBe('number');
    expect(proposal.estimatedDurationMs).toBeGreaterThan(0);

    ToolRegistry['_global'] = saved;
  });

  it('respects maxChainLength (clamped to 10)', async () => {
    const result = await composeTool.execute({ goal: 'search web scrape data analyze report', maxChainLength: 2 }, ctx);
    expect(result.success).toBe(true);
    const proposal = (result.data as { proposal: { chain: string[] } }).proposal;
    expect(proposal.chain.length).toBeLessThanOrEqual(2);
  });

  it('uses registry when global registry is available', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'test.search',
      description: 'Search the web for information',
      category: 'browser' as import('../../src/core/tools/types.js').ToolCategory,
      timeout: 5000,
      parameters: {},
      async execute() { return { success: true, output: 'ok' }; },
    });
    ToolRegistry.setGlobal(registry);

    const result = await composeTool.execute({ goal: 'search the web for info' }, ctx);
    expect(result.success).toBe(true);
    const proposal = (result.data as { proposal: { chain: string[] } }).proposal;
    // test.search should score well for "search web info"
    expect(proposal.chain.length).toBeGreaterThan(0);

    ToolRegistry['_global'] = null;
  });

  it('returns empty chain with rationale when no tools match', async () => {
    const registry = new ToolRegistry();
    // Register something that won't match any keyword in the goal
    registry.register({
      name: 'finance.track',
      description: 'Track revenue and costs',
      category: 'finance' as import('../../src/core/tools/types.js').ToolCategory,
      timeout: 5000,
      parameters: {},
      async execute() { return { success: true, output: 'ok' }; },
    });
    ToolRegistry.setGlobal(registry);

    const result = await composeTool.execute({ goal: 'zxqv nonexistent purpose xyz' }, ctx);
    expect(result.success).toBe(true);
    const proposal = (result.data as { proposal: { rationale: string } }).proposal;
    expect(typeof proposal.rationale).toBe('string');

    ToolRegistry['_global'] = null;
  });
});

// ---------------------------------------------------------------------------
// skill.explain tests
// ---------------------------------------------------------------------------

describe('skill.explain', () => {
  it('has correct tool metadata', () => {
    expect(explainTool.name).toBe('skill.explain');
    expect(explainTool.category).toBe('skill');
    expect(explainTool.timeout).toBe(15_000);
    expect(explainTool.parameters['toolName']?.required).toBe(true);
  });

  it('returns error when toolName is missing', async () => {
    const result = await explainTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/toolName is required/i);
  });

  it('returns markdown for unknown tool (fail-open)', async () => {
    const result = await explainTool.execute({ toolName: 'nonexistent.tool' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('## nonexistent.tool');
    expect(result.output).toContain('**Description:**');
    expect(result.output).toContain('**Usage (last 7d):**');
    expect(result.output).toContain('**Common failures:**');
  });

  it('includes registry description when tool is registered', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'test.my-tool',
      description: 'My special test tool description',
      category: 'meta' as import('../../src/core/tools/types.js').ToolCategory,
      timeout: 5000,
      parameters: {
        input: { type: 'string', description: 'Input string', required: true },
      },
      async execute() { return { success: true, output: 'ok' }; },
    });
    ToolRegistry.setGlobal(registry);

    const result = await explainTool.execute({ toolName: 'test.my-tool' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('My special test tool description');
    expect(result.output).toContain('`input`');

    ToolRegistry['_global'] = null;
  });

  it('returns found:false when tool not in registry', async () => {
    ToolRegistry['_global'] = null;
    const result = await explainTool.execute({ toolName: 'ghost.tool' }, ctx);
    expect(result.success).toBe(true);
    expect((result.data as { found: boolean }).found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// registerSkillTools tests
// ---------------------------------------------------------------------------

describe('registerSkillTools', () => {
  it('registers exactly 9 skill tools', () => {
    const registry = new ToolRegistry();
    registerSkillTools(registry);
    expect(registry.size).toBe(9);
  });

  it('registers all expected tool names', () => {
    const registry = new ToolRegistry();
    registerSkillTools(registry);
    expect(registry.get('skill.usage-stats')).toBeDefined();
    expect(registry.get('skill.refine')).toBeDefined();
    expect(registry.get('skill.federate')).toBeDefined();
    expect(registry.get('skill.compose')).toBeDefined();
    expect(registry.get('skill.explain')).toBeDefined();
    expect(registry.get('skill.apply')).toBeDefined();
    expect(registry.get('skill.rollback')).toBeDefined();
    expect(registry.get('skill.search')).toBeDefined();
    expect(registry.get('skill.install')).toBeDefined();
  });

  it('all registered tools have execute function', () => {
    const registry = new ToolRegistry();
    registerSkillTools(registry);
    for (const tool of registry.listAll()) {
      expect(typeof tool.execute).toBe('function');
    }
  });
});
