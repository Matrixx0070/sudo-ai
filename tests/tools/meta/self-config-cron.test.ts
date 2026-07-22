/**
 * meta.self-config cron tools write valid CronJobSchema objects.
 *
 * Root cause (2026-07-22): add-cron-job pushed the raw tool input
 * ({ name, schedule, action }) straight into config.cron.jobs, but
 * CronJobSchema requires { id, schedule, description, enabled, task }.
 * Since the fail-closed schema guard landed in writeConfig (#922), every
 * add-cron-job was refused. These tests prove the tool now transforms the
 * friendly input into the config shape (and remove-cron-job matches on id).
 *
 * Same temp-fixture pattern as config-schema-guard.test.ts: the tool
 * resolves the config path at module load via cwd, so pin env + chdir and
 * dynamic-import after vi.resetModules().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSON5 from 'json5';
import { Value } from '@sinclair/typebox/value';
import { SudoConfigSchema, CronJobSchema } from '../../../src/core/config/schema.js';
import type { ToolContext } from '../../../src/core/tools/types.js';

function ctx(): ToolContext {
  return { sessionId: 'test', workingDir: '/tmp', config: {}, logger: {} } as unknown as ToolContext;
}

let tmp: string;
let configFile: string;
let originalCwd: string;
let savedHome: string | undefined;
let savedData: string | undefined;

function readJobs(): Record<string, unknown>[] {
  const parsed = JSON5.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  const cron = (parsed['cron'] ?? {}) as Record<string, unknown>;
  return (cron['jobs'] ?? []) as Record<string, unknown>[];
}

beforeEach(() => {
  originalCwd = process.cwd();
  savedHome = process.env['SUDO_AI_HOME'];
  savedData = process.env['DATA_DIR'];

  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-cron-shape-'));
  mkdirSync(path.join(tmp, 'config'), { recursive: true });
  configFile = path.join(tmp, 'config', 'sudo-ai.json5');

  // Minimal schema-valid fixture (never the repo's real config).
  const valid = Value.Create(SudoConfigSchema) as Record<string, unknown>;
  (valid['meta'] as Record<string, unknown>)['name'] = 'fixture';
  writeFileSync(configFile, JSON.stringify(valid, null, 2) + '\n', 'utf8');

  process.env['SUDO_AI_HOME'] = tmp;
  process.env['DATA_DIR'] = path.join(tmp, 'data'); // backups go to temp too
  process.chdir(tmp); // self-config resolves config path from cwd
  vi.resetModules(); // module captures paths at import time
});

afterEach(() => {
  process.chdir(originalCwd);
  if (savedHome === undefined) delete process.env['SUDO_AI_HOME'];
  else process.env['SUDO_AI_HOME'] = savedHome;
  if (savedData === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = savedData;
  rmSync(tmp, { recursive: true, force: true });
});

describe('meta.self-config add-cron-job writes CronJobSchema shape', () => {
  it('succeeds through the schema guard and stores { id, schedule, description, enabled, task }', async () => {
    const { selfConfigTool } = await import('../../../src/core/tools/builtin/meta/self-config.js');
    const res = await selfConfigTool.execute(
      {
        action: 'add-cron-job',
        cronJob: { name: 'nightly', schedule: '0 3 * * *', action: 'run the backup' },
      },
      ctx(),
    );
    expect(res.success).toBe(true);

    const jobs = readJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      id: 'nightly',
      schedule: '0 3 * * *',
      description: 'nightly',
      enabled: true,
      task: 'run the backup',
    });
    expect(Value.Check(CronJobSchema, jobs[0])).toBe(true);

    const parsed = JSON5.parse(readFileSync(configFile, 'utf8'));
    expect(Value.Check(SudoConfigSchema, parsed)).toBe(true);
  });

  it('honors explicit description and enabled:false', async () => {
    const { selfConfigTool } = await import('../../../src/core/tools/builtin/meta/self-config.js');
    const res = await selfConfigTool.execute(
      {
        action: 'add-cron-job',
        cronJob: {
          name: 'weekly',
          schedule: '0 4 * * 0',
          action: 'prune logs',
          description: 'weekly log prune',
          enabled: false,
        },
      },
      ctx(),
    );
    expect(res.success).toBe(true);

    const jobs = readJobs();
    expect(jobs[0]).toEqual({
      id: 'weekly',
      schedule: '0 4 * * 0',
      description: 'weekly log prune',
      enabled: false,
      task: 'prune logs',
    });
    expect(Value.Check(CronJobSchema, jobs[0])).toBe(true);
  });

  it('refuses a duplicate name (matched against stored id)', async () => {
    const { selfConfigTool } = await import('../../../src/core/tools/builtin/meta/self-config.js');
    const input = {
      action: 'add-cron-job',
      cronJob: { name: 'nightly', schedule: '0 3 * * *', action: 'run the backup' },
    };
    const first = await selfConfigTool.execute(input, ctx());
    expect(first.success).toBe(true);

    const second = await selfConfigTool.execute(input, ctx());
    expect(second.success).toBe(false);
    expect(second.output).toContain('already exists');
    expect(readJobs()).toHaveLength(1);
  });
});

describe('meta.self-config remove-cron-job matches stored id', () => {
  it('removes by name (stored as id)', async () => {
    const { selfConfigTool } = await import('../../../src/core/tools/builtin/meta/self-config.js');
    await selfConfigTool.execute(
      { action: 'add-cron-job', cronJob: { name: 'nightly', schedule: '0 3 * * *', action: 'run the backup' } },
      ctx(),
    );

    const res = await selfConfigTool.execute({ action: 'remove-cron-job', jobIdentifier: 'nightly' }, ctx());
    expect(res.success).toBe(true);
    expect(res.output).toContain('nightly');
    expect(readJobs()).toHaveLength(0);
  });

  it('removes by numeric index', async () => {
    const { selfConfigTool } = await import('../../../src/core/tools/builtin/meta/self-config.js');
    await selfConfigTool.execute(
      { action: 'add-cron-job', cronJob: { name: 'nightly', schedule: '0 3 * * *', action: 'run the backup' } },
      ctx(),
    );

    const res = await selfConfigTool.execute({ action: 'remove-cron-job', jobIdentifier: '0' }, ctx());
    expect(res.success).toBe(true);
    expect(readJobs()).toHaveLength(0);
  });

  it('lists stored ids in the not-found message', async () => {
    const { selfConfigTool } = await import('../../../src/core/tools/builtin/meta/self-config.js');
    await selfConfigTool.execute(
      { action: 'add-cron-job', cronJob: { name: 'nightly', schedule: '0 3 * * *', action: 'run the backup' } },
      ctx(),
    );

    const res = await selfConfigTool.execute({ action: 'remove-cron-job', jobIdentifier: 'missing' }, ctx());
    expect(res.success).toBe(false);
    expect(res.output).toContain('nightly'); // id listed, not "(unnamed)"
  });
});
