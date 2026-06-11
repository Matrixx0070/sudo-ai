/**
 * Multi-Delivery Cron Tests
 *
 * Tests for cron job management and delivery targets.
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { existsSync, rmSync } from 'fs';
import path from 'path';
import { MultiDeliveryCron } from '../../src/core/cron/multi-delivery.js';
import type { DeliveryTarget } from '../../src/core/cron/multi-delivery-types.js';

const TEST_DB = path.join('/tmp', `cron-test-${Date.now()}.db`);

function cleanupDb(): void {
  if (existsSync(TEST_DB)) {
    rmSync(TEST_DB, { force: true });
  }
}

describe('MultiDeliveryCron', () => {
  let cron: MultiDeliveryCron;

  beforeEach(() => {
    cleanupDb();
    cron = new MultiDeliveryCron(TEST_DB);
  });

  afterEach(() => {
    cron.close();
    cleanupDb();
  });

  it('addJob creates a new cron job', () => {
    const job = cron.addJob({
      name: 'test-job',
      schedule: { type: 'interval', value: '60000' },
      prompt: 'Run test',
      skills: ['skill-a', 'skill-b'],
      deliver: [{ type: 'local', config: {} }],
      enabled: true,
    });

    assert.ok(job.id.startsWith('job_'));
    assert.strictEqual(job.name, 'test-job');
    assert.strictEqual(job.schedule.type, 'interval');
    assert.strictEqual(job.schedule.value, '60000');
    assert.deepStrictEqual(job.skills, ['skill-a', 'skill-b']);
    assert.ok(job.createdAt);
    assert.ok(job.updatedAt);
  });

  it('removeJob deletes a cron job', () => {
    const job = cron.addJob({
      name: 'to-remove',
      schedule: { type: 'interval', value: '60000' },
      prompt: 'Test',
      skills: [],
      deliver: [],
      enabled: true,
    });

    const removed = cron.removeJob(job.id);
    assert.strictEqual(removed, true);

    const fetched = cron.getJob(job.id);
    assert.strictEqual(fetched, null);
  });

  it('listJobs returns all jobs', () => {
    cron.addJob({
      name: 'job-1',
      schedule: { type: 'interval', value: '60000' },
      prompt: 'First',
      skills: [],
      deliver: [],
      enabled: true,
    });

    cron.addJob({
      name: 'job-2',
      schedule: { type: 'interval', value: '120000' },
      prompt: 'Second',
      skills: [],
      deliver: [],
      enabled: true,
    });

    const jobs = cron.listJobs();
    assert.strictEqual(jobs.length, 2);
    assert.ok(jobs.some((j) => j.name === 'job-1'));
    assert.ok(jobs.some((j) => j.name === 'job-2'));
  });

  it('enableJob and disableJob toggle job state', () => {
    const job = cron.addJob({
      name: 'toggle-job',
      schedule: { type: 'interval', value: '60000' },
      prompt: 'Test',
      skills: [],
      deliver: [],
      enabled: true,
    });

    assert.strictEqual(cron.getJob(job.id)?.enabled, true);

    cron.disableJob(job.id);
    assert.strictEqual(cron.getJob(job.id)?.enabled, false);

    cron.enableJob(job.id);
    assert.strictEqual(cron.getJob(job.id)?.enabled, true);
  });

  it('deliverToTarget sends to local target (console.log)', async () => {
    const job = cron.addJob({
      name: 'local-test',
      schedule: { type: 'interval', value: '60000' },
      prompt: 'Hello local',
      skills: [],
      deliver: [{ type: 'local', config: {} }],
      enabled: true,
    });

    const result = await cron.deliverToTarget(job, { type: 'local', config: {} });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.target.type, 'local');
    assert.ok(result.deliveredAt);
  });

  it('deliverToTarget handles webhook target with mock fetch', async () => {
    const job = cron.addJob({
      name: 'webhook-test',
      schedule: { type: 'interval', value: '60000' },
      prompt: 'Hello webhook',
      skills: [],
      deliver: [],
      enabled: true,
    });

    // Mock global fetch for webhook test
    const originalFetch = global.fetch;
    global.fetch = async (url: unknown, opts?: RequestInit) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '{}',
      } as Response;
    };

    try {
      const result = await cron.deliverToTarget(job, {
        type: 'webhook',
        config: { url: 'https://example.com/hook' },
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.target.type, 'webhook');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('deliverToTarget respects kill-switch', async () => {
    process.env.SUDO_MULTI_DELIVERY_DISABLE = '1';

    const job = cron.addJob({
      name: 'killswitch-test',
      schedule: { type: 'interval', value: '60000' },
      prompt: 'Should not deliver',
      skills: [],
      deliver: [],
      enabled: true,
    });

    const result = await cron.deliverToTarget(job, { type: 'local', config: {} });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'Kill-switch active');

    delete process.env.SUDO_MULTI_DELIVERY_DISABLE;
  });

  it('tick fires due jobs', async () => {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

    // Create a job that was last run 5 minutes ago with 1-minute interval
    const job = cron.addJob({
      name: 'due-job',
      schedule: { type: 'interval', value: '60000' }, // 1 minute
      prompt: 'Run me',
      skills: [],
      deliver: [{ type: 'local', config: {} }],
      enabled: true,
    });

    // Manually set lastRunAt to 5 minutes ago
    cron.updateJob(job.id, { lastRunAt: fiveMinAgo.toISOString() });

    // Tick should run the due job
    await cron.tick();

    const updated = cron.getJob(job.id);
    assert.ok(updated?.lastRunAt);
    assert.ok(new Date(updated.lastRunAt).getTime() > fiveMinAgo.getTime());
  });

  it('tick skips jobs when kill-switch is active', async () => {
    process.env.SUDO_MULTI_DELIVERY_DISABLE = '1';

    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

    const job = cron.addJob({
      name: 'blocked-job',
      schedule: { type: 'interval', value: '60000' },
      prompt: 'Blocked',
      skills: [],
      deliver: [{ type: 'local', config: {} }],
      enabled: true,
    });

    cron.updateJob(job.id, { lastRunAt: fiveMinAgo.toISOString() });

    await cron.tick();

    // Job should NOT have been run
    const updated = cron.getJob(job.id);
    assert.strictEqual(updated?.lastRunAt, fiveMinAgo.toISOString());

    delete process.env.SUDO_MULTI_DELIVERY_DISABLE;
  });
});
