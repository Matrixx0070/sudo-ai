/**
 * Self-build working-tree safety — data-loss guard, driven END TO END through
 * runSelfBuildTick() against a REAL git repository (no execSync mocks).
 *
 * Two destructive behaviours are covered:
 *
 *  1. Gate 8 used to "clean up and proceed" on a dirty tree: an unscoped
 *     `git checkout -- .` plus a `git clean -fd` of every untracked path git
 *     reported. On a shared checkout that silently wipes a human's uncommitted
 *     work. It must now SKIP the tick and destroy nothing.
 *
 *  2. revertAgentChanges() restores the tree to HEAD after a rejected agent
 *     turn. That is only safe because Gate 8 guarantees a clean tree at turn
 *     start — and it must be complete (staged + tracked + untracked), or the
 *     leftovers make Gate 8 skip every later tick and self-build wedges.
 *
 * Test IDs:
 *   SB-T1 dirty tree at tick start -> dirty-state, human WIP untouched
 *   SB-T2 rejected agent turn -> tree fully restored to HEAD, no wedge
 *   SB-T3 rejected agent turn with non-ASCII / metacharacter filenames
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { runSelfBuildTick, type SelfBuildDeps } from '../../src/core/self-build/orchestrator.js';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function read(rel: string): string {
  return readFileSync(join(repo, rel), 'utf8');
}

/** mindDb shaped like prod: api_call_log present, zero spend today. */
function buildTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE api_call_log (
      id INTEGER PRIMARY KEY,
      estimated_cost_usd REAL NOT NULL,
      called_at TEXT NOT NULL
    );
  `);
  return db;
}

/** Deps that pass gates 1-7 so the tick actually reaches the tree logic. */
function buildDeps(run: SelfBuildDeps['agentLoop']['run']): SelfBuildDeps {
  return {
    agentLoop: { run },
    mindDb: buildTestDb(),
    alignmentAggregator: { getLastReport: vi.fn().mockReturnValue({ score: 0.95 }) },
    mistakeAutoBlockGuard: { decide: vi.fn().mockReturnValue({ verdict: 'PASS' }) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    gitCwd: repo,
  } as unknown as SelfBuildDeps;
}

beforeEach(() => {
  process.env['SUDO_SELF_BUILD_MODE'] = '1';
  delete process.env['SUDO_SELF_BUILD_DISABLE'];
  // Gate 5 reads real daily spend from mindDb; keep the cap generous.
  process.env['SUDO_DAILY_LLM_BUDGET_USD'] = 'off';

  repo = mkdtempSync(join(tmpdir(), 'sb-tick-'));
  git('init', '-q', '-b', 'self-build', '.');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  // data/ holds the self-build state + journal and is gitignored in the real
  // repo too — otherwise saveState() would dirty the tree it is guarding.
  write('.gitignore', 'data/\n');
  write('src/human/wip.ts', 'export const HUMAN = 1;\n');
  write('src/agent/target.ts', 'export const AGENT = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  delete process.env['SUDO_SELF_BUILD_MODE'];
  delete process.env['SUDO_DAILY_LLM_BUDGET_USD'];
  rmSync(repo, { recursive: true, force: true });
});

describe('SB-T1 dirty tree at tick start', () => {
  it('skips the tick and destroys nothing', async () => {
    // A human's uncommitted work: a modified tracked file, a brand-new file,
    // and a staged edit.
    write('src/human/wip.ts', 'export const HUMAN = 999; // hours of work\n');
    write('src/human/scratch.md', 'notes I have not committed\n');
    write('src/agent/target.ts', 'export const AGENT = 7;\n');
    git('add', 'src/agent/target.ts');

    const run = vi.fn();
    const result = await runSelfBuildTick(buildDeps(run));

    expect(result.status).toBe('dirty-state');
    // The agent must not even have been asked to run.
    expect(run).not.toHaveBeenCalled();
    // Every byte of the human's work survives.
    expect(read('src/human/wip.ts')).toContain('999');
    expect(read('src/human/scratch.md')).toBe('notes I have not committed\n');
    expect(read('src/agent/target.ts')).toContain('AGENT = 7');
    expect(git('diff', '--cached', '--name-only').trim()).toBe('src/agent/target.ts');
  });
});

describe('SB-T2 rejected agent turn', () => {
  it('restores the tree to HEAD completely, leaving no wedge for the next tick', async () => {
    const run = vi.fn(async () => {
      // The agent edits a tracked file, deletes another, creates a new file and
      // a new directory, and stages part of its work — then the turn fails.
      write('src/agent/target.ts', 'export const AGENT = 2;\n');
      rmSync(join(repo, 'src/human/wip.ts'));
      write('src/agent/new-feature.ts', 'export const NEW = 1;\n');
      write('scratch/leftover.txt', 'agent junk\n');
      git('add', 'src/agent/target.ts');
      throw new Error('agent exploded');
    });

    const result = await runSelfBuildTick(buildDeps(run));

    expect(result.status).toBe('test-fail-reverted');
    expect(run).toHaveBeenCalledOnce();
    expect(read('src/agent/target.ts')).toBe('export const AGENT = 1;\n');
    expect(read('src/human/wip.ts')).toBe('export const HUMAN = 1;\n');
    expect(existsSync(join(repo, 'src/agent/new-feature.ts'))).toBe(false);
    expect(existsSync(join(repo, 'scratch'))).toBe(false);
    // The no-wedge assertion: a dirty tree here would make Gate 8 skip forever.
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('leaves gitignored state files alone while reverting', async () => {
    const run = vi.fn(async () => {
      write('data/precious.json', '{"keep":true}\n');
      throw new Error('agent exploded');
    });

    await runSelfBuildTick(buildDeps(run));

    expect(read('data/precious.json')).toBe('{"keep":true}\n');
  });
});

describe('SB-T3 hostile filenames', () => {
  it('reverts paths containing non-ASCII, quotes and glob metacharacters', async () => {
    // git C-quotes these in `git diff --name-only` output (core.quotePath), so
    // any revert that round-trips paths through a pathspec silently reverts
    // NOTHING. The revert must not depend on parsing path lists at all.
    write('src/café.ts', 'export const CAFE = 1;\n');
    write("src/we'ird *.ts", 'export const ODD = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'odd names');

    const run = vi.fn(async () => {
      write('src/café.ts', 'export const CAFE = 2;\n');
      write("src/we'ird *.ts", 'export const ODD = 2;\n');
      write('src/naïve new.ts', 'export const NEW = 1;\n');
      throw new Error('agent exploded');
    });

    const result = await runSelfBuildTick(buildDeps(run));

    expect(result.status).toBe('test-fail-reverted');
    expect(read('src/café.ts')).toBe('export const CAFE = 1;\n');
    expect(read("src/we'ird *.ts")).toBe('export const ODD = 1;\n');
    expect(existsSync(join(repo, 'src/naïve new.ts'))).toBe(false);
    expect(git('status', '--porcelain').trim()).toBe('');
  });
});
