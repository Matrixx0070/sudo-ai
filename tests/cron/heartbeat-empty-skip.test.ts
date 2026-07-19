/**
 * @file heartbeat-empty-skip.test.ts
 * @description BO4 / scorecard-S5 — an empty/comments-only HEARTBEAT.md must NOT
 * spend a model call. Today the slim heartbeat still pays for a model call every
 * tick; this gate short-circuits before the model when there is nothing
 * actionable to run, and logs a clear skip.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Capture logger output so we can assert the skip line. pino writes to its own
// fd/transport (not process.stdout.write), so we intercept createLogger instead.
const { infoLogs } = vi.hoisted(() => ({ infoLogs: [] as unknown[][] }));
vi.mock('../../src/core/shared/logger.js', () => {
  const stub: Record<string, unknown> = {
    info: (...a: unknown[]) => { infoLogs.push(a); },
    debug: () => {},
    warn: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
  };
  stub['child'] = () => stub;
  return { createLogger: () => stub };
});

import {
  HeartbeatRunner,
  heartbeatHasActionableContent,
} from '../../src/core/cron/heartbeat.js';
import type { CronStore } from '../../src/core/cron/store.js';
import type { CronScheduler } from '../../src/core/cron/scheduler.js';
import type { CronJob, CronPayload } from '../../src/core/cron/types.js';
import { PATHS } from '../../src/core/shared/constants.js';

const HEARTBEAT_FILE = path.join(PATHS.WORKSPACE, 'HEARTBEAT.md');

// ---------------------------------------------------------------------------
// Pure content classifier
// ---------------------------------------------------------------------------

describe('BO4/S5 — heartbeatHasActionableContent', () => {
  it('treats absent/empty/whitespace as non-actionable', () => {
    expect(heartbeatHasActionableContent('')).toBe(false);
    expect(heartbeatHasActionableContent('   \n\n\t  \n')).toBe(false);
  });

  it('treats comments/headers/HTML-comments-only as non-actionable', () => {
    expect(heartbeatHasActionableContent('# just a header')).toBe(false);
    expect(heartbeatHasActionableContent('## Checklist\n### Sub\n')).toBe(false);
    expect(heartbeatHasActionableContent('<!-- a note -->\n<!-- more -->')).toBe(false);
    expect(heartbeatHasActionableContent('# Header\n\n<!-- comment -->\n   \n')).toBe(false);
  });

  it('treats frontmatter-only as non-actionable', () => {
    expect(heartbeatHasActionableContent('---\ntasks:\n  - x\n---\n')).toBe(false);
    expect(heartbeatHasActionableContent('---\ntasks:\n  - x\n---\n# Header only\n')).toBe(false);
  });

  it('treats any real checklist line as actionable', () => {
    expect(heartbeatHasActionableContent('- [ ] run the health check')).toBe(true);
    expect(heartbeatHasActionableContent('## Checklist\n- verify disk space')).toBe(true);
    expect(heartbeatHasActionableContent('---\nx: 1\n---\nCheck the queue depth.')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wrapRunner integration — the model call itself
// ---------------------------------------------------------------------------

function makeRunner(): HeartbeatRunner {
  const store = { list: () => [], patch: () => {} } as unknown as CronStore;
  const scheduler = {
    addJob: (j: CronJob) => j,
    removeJob: () => {},
  } as unknown as CronScheduler;
  // Default options → no active-hours restriction (always active).
  return new HeartbeatRunner(store, scheduler, {});
}

const JOB: CronJob = {
  id: 'hb-test',
  name: 'system.heartbeat',
  schedule: { kind: 'every', ms: 60_000 },
  payload: { kind: 'agentTurn', message: 'x' },
  sessionTarget: 'isolated',
  enabled: true,
  consecutiveErrors: 0,
} as unknown as CronJob;

const PAYLOAD: CronPayload = { kind: 'agentTurn', message: 'x' };

describe('BO4/S5 — wrapRunner empty-heartbeat skip', () => {
  let origHeartbeat: string | null = null;

  beforeEach(() => {
    mkdirSync(PATHS.WORKSPACE, { recursive: true });
    origHeartbeat = existsSync(HEARTBEAT_FILE) ? readFileSync(HEARTBEAT_FILE, 'utf8') : null;
  });

  afterEach(() => {
    if (origHeartbeat === null) { if (existsSync(HEARTBEAT_FILE)) rmSync(HEARTBEAT_FILE); }
    else writeFileSync(HEARTBEAT_FILE, origHeartbeat);
  });

  it('comments-only HEARTBEAT.md ⇒ ZERO model calls', async () => {
    writeFileSync(HEARTBEAT_FILE, '# Heartbeat\n\n<!-- nothing to do right now -->\n   \n');
    const runner = makeRunner();
    const modelCall = vi.fn(async () => 'something happened');
    const wrapped = runner.wrapRunner(modelCall);

    const out = await wrapped(PAYLOAD, JOB);

    expect(modelCall).toHaveBeenCalledTimes(0);
    expect(out).toBeUndefined();
  });

  it('empty HEARTBEAT.md ⇒ ZERO model calls', async () => {
    writeFileSync(HEARTBEAT_FILE, '   \n\n');
    const runner = makeRunner();
    const modelCall = vi.fn(async () => 'something happened');
    const wrapped = runner.wrapRunner(modelCall);

    await wrapped(PAYLOAD, JOB);
    expect(modelCall).toHaveBeenCalledTimes(0);
  });

  it('logs a clear skip when the checklist is empty', async () => {
    writeFileSync(HEARTBEAT_FILE, '# only a header\n');
    const runner = makeRunner();
    const modelCall = vi.fn(async () => 'x');
    const wrapped = runner.wrapRunner(modelCall);

    infoLogs.length = 0;
    await wrapped(PAYLOAD, JOB);

    expect(modelCall).toHaveBeenCalledTimes(0);
    const logged = infoLogs.map((a) => a.map((x) => String(x)).join(' ')).join('\n');
    expect(logged).toContain('empty checklist — skipping model call');
  });

  it('actionable HEARTBEAT.md ⇒ EXACTLY ONE model call', async () => {
    writeFileSync(HEARTBEAT_FILE, '## Checklist\n- [ ] verify the queue depth and disk space\n');
    const runner = makeRunner();
    const modelCall = vi.fn(async () => 'all good, nothing to report');
    const wrapped = runner.wrapRunner(modelCall);

    const out = await wrapped(PAYLOAD, JOB);

    expect(modelCall).toHaveBeenCalledTimes(1);
    expect(out).toBe('all good, nothing to report');
  });
});
