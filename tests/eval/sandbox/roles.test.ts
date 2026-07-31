/** Multi-agent role scenarios (ADR-0007 Phase 4): manifest validation, {previous}
 *  substitution, role.turn journaling, sequencing via the injected RoleTurnRunner
 *  stub — no LLM calls anywhere. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRoleMessage,
  perRoleMaxIterations,
  runRoleTurns,
  PREVIOUS_TEXT_CAP_BYTES,
  type RoleTurnRunner,
} from '../../../src/core/eval/sandbox/roles.js';
import { validateScenario, loadScenarioFile, type Scenario, type ScenarioRole } from '../../../src/core/eval/sandbox/scenario.js';
import { runEval } from '../../../src/core/eval/sandbox/eval-runner.js';
import { readJournal } from '../../../src/core/eval/sandbox/run-journal.js';
import { PROJECT_ROOT } from '../../../src/core/shared/paths.js';

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

function baseScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'roles-stub',
    version: '1',
    title: 'roles stub',
    taskType: 'coding',
    prompt: 'multi-role drill',
    grading: { checks: [{ type: 'fileExists', path: 'out.txt' }] },
    budgets: { maxUsd: 0.1, maxSteps: 8, maxWallMs: 30_000 },
    ...over,
  };
}

const twoRoles: ScenarioRole[] = [
  { name: 'coder', prompt: 'fix {workspace}/a.js' },
  { name: 'reviewer', persona: 'strict', prompt: 'review: {previous}' },
];

describe('roles manifest validation', () => {
  it('accepts 2 roles with optional persona', () => {
    const v = validateScenario(baseScenario({ roles: twoRoles }));
    expect(v.ok).toBe(true);
  });

  it('accepts 4 roles, rejects 1 and 5', () => {
    const role = (n: number): ScenarioRole => ({ name: `r${n}`, prompt: 'p' });
    expect(validateScenario(baseScenario({ roles: [1, 2, 3, 4].map(role) })).ok).toBe(true);
    expect(validateScenario(baseScenario({ roles: [role(1)] })).ok).toBe(false);
    expect(validateScenario(baseScenario({ roles: [1, 2, 3, 4, 5].map(role) })).ok).toBe(false);
  });

  it('rejects a role with empty name or missing prompt', () => {
    expect(validateScenario(baseScenario({
      roles: [{ name: '', prompt: 'p' }, { name: 'b', prompt: 'p' }],
    })).ok).toBe(false);
    expect(validateScenario(baseScenario({
      roles: [{ name: 'a' } as unknown as ScenarioRole, { name: 'b', prompt: 'p' }],
    })).ok).toBe(false);
  });

  it('rejects unknown role properties', () => {
    expect(validateScenario(baseScenario({
      roles: [{ name: 'a', prompt: 'p', extra: 1 } as unknown as ScenarioRole, { name: 'b', prompt: 'p' }],
    })).ok).toBe(false);
  });

  it('seed scenario roles-code-review.yaml validates', () => {
    const s = loadScenarioFile(path.join(PROJECT_ROOT, 'evals', 'sandbox', 'scenarios', 'roles-code-review.yaml'));
    expect(s.roles).toHaveLength(2);
    expect(s.roles![0]!.name).toBe('coder');
    expect(s.roles![1]!.name).toBe('reviewer');
    expect(s.roles![1]!.prompt).toContain('{previous}');
  });
});

// ---------------------------------------------------------------------------
// Message building: {workspace}, {previous}, persona, 8KB cap
// ---------------------------------------------------------------------------

describe('buildRoleMessage', () => {
  it('substitutes {workspace} and {previous}', () => {
    const msg = buildRoleMessage(
      { name: 'reviewer', prompt: 'in {workspace}, review: {previous}' },
      '/ws', 'the diff',
    );
    expect(msg).toBe('in /ws, review: the diff');
  });

  it('prepends the persona preamble when present', () => {
    const msg = buildRoleMessage({ name: 'coder', persona: 'Careful engineer.', prompt: 'go' }, '/ws', '');
    expect(msg).toContain('[You are the "coder" role. Careful engineer.]');
    expect(msg.endsWith('go')).toBe(true);
  });

  it('caps {previous} at 8KB', () => {
    const huge = 'x'.repeat(PREVIOUS_TEXT_CAP_BYTES + 100);
    const msg = buildRoleMessage({ name: 'r', prompt: 'P:{previous}' }, '/ws', huge);
    expect(msg.length).toBe(2 + PREVIOUS_TEXT_CAP_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Sequencing + journaling with an injected stub runner
// ---------------------------------------------------------------------------

class MemJournal {
  events: Array<Record<string, unknown>> = [];
  append(e: Record<string, unknown>): void { this.events.push(e); }
}

describe('runRoleTurns', () => {
  it('runs roles sequentially, passes previous text, sums steps, journals role.turn', async () => {
    const calls: Array<{ sessionKey: string; message: string; maxIterations: number }> = [];
    const runTurn: RoleTurnRunner = async (a) => {
      calls.push({ sessionKey: a.sessionKey, message: a.message, maxIterations: a.maxIterations });
      return { text: `${a.role.name}-done`, steps: 3 };
    };
    const j = new MemJournal();
    const out = await runRoleTurns({
      roles: twoRoles, runId: 'run1', workspaceDir: '/ws', maxSteps: 7, journal: j, runTurn,
    });

    expect(out).toEqual({ text: 'reviewer-done', steps: 6 });
    expect(calls).toHaveLength(2);
    // ceil(7/2) = 4 iterations per role
    expect(calls.map((c) => c.maxIterations)).toEqual([4, 4]);
    expect(calls[0]!.sessionKey).toBe('eval-run1-coder');
    expect(calls[1]!.sessionKey).toBe('eval-run1-reviewer');
    // second role saw the first role's final text via {previous}
    expect(calls[1]!.message).toContain('review: coder-done');
    expect(j.events).toEqual([
      { type: 'role.turn', role: 'coder', steps: 3, ok: true },
      { type: 'role.turn', role: 'reviewer', steps: 3, ok: true },
    ]);
  });

  it('stops the sequence on an errored role and journals ok:false', async () => {
    const seen: string[] = [];
    const runTurn: RoleTurnRunner = async (a) => {
      seen.push(a.role.name);
      if (a.role.name === 'coder') return { text: '', steps: 2, error: 'boom' };
      return { text: 'ok', steps: 1 };
    };
    const j = new MemJournal();
    const out = await runRoleTurns({
      roles: twoRoles, runId: 'run2', workspaceDir: '/ws', maxSteps: 8, journal: j, runTurn,
    });
    expect(seen).toEqual(['coder']);
    expect(out.steps).toBe(2);
    expect(out.error).toContain("role 'coder' failed: boom");
    expect(j.events).toEqual([
      { type: 'role.turn', role: 'coder', steps: 2, ok: false, error: 'boom' },
    ]);
  });

  it('a THROWN runner surfaces as an errored role turn, not a harness crash', async () => {
    const j = new MemJournal();
    const out = await runRoleTurns({
      roles: twoRoles, runId: 'run3', workspaceDir: '/ws', maxSteps: 8, journal: j,
      runTurn: async () => { throw new Error('runner exploded'); },
    });
    expect(out.error).toContain('runner exploded');
    expect(j.events[0]).toMatchObject({ type: 'role.turn', role: 'coder', ok: false });
  });
});

describe('perRoleMaxIterations', () => {
  it('divides ceil() and never returns < 1', () => {
    expect(perRoleMaxIterations(16, 2)).toBe(8);
    expect(perRoleMaxIterations(7, 3)).toBe(3);
    expect(perRoleMaxIterations(1, 4)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Runner integration: roles land (substituted) in the child's scenario.json
// ---------------------------------------------------------------------------

describe('runEval with a roles scenario', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-roles-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('writes roles into scenario.json with {mockServiceUrl} substituted', async () => {
    const scenario = baseScenario({
      roles: [
        { name: 'coder', prompt: 'hit {mockServiceUrl} then fix {workspace}/a.js' },
        { name: 'reviewer', prompt: 'review: {previous}' },
      ],
      mockService: { failuresBeforeSuccess: 0, successBody: 'ok' },
    });
    const report = await runEval(scenario, {
      executor: async (args) => {
        fs.writeFileSync(path.join(args.workspaceDir, 'out.txt'), 'x');
        return { text: 'done', steps: 1 };
      },
      evalRunsRoot: root,
      benchDbPath: path.join(root, 'bench.db'),
    });
    expect(report.passed).toBe(true);
    const runDir = path.dirname(report.journalPath);
    const written = JSON.parse(fs.readFileSync(path.join(runDir, 'scenario.json'), 'utf-8')) as Scenario;
    expect(written.roles).toHaveLength(2);
    expect(written.roles![0]!.prompt).not.toContain('{mockServiceUrl}');
    expect(written.roles![0]!.prompt).toMatch(/hit http:\/\/127\.0\.0\.1:\d+/);
    // child-side placeholders survive untouched
    expect(written.roles![0]!.prompt).toContain('{workspace}');
    expect(written.roles![1]!.prompt).toContain('{previous}');
    // journal parses with the new role.turn type present in the union
    expect(readJournal(report.journalPath).length).toBeGreaterThan(0);
  });
});
