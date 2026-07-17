/**
 * F89 — standing orders wiring.
 *
 * The system.standing-orders tool ships registered but used to throw
 * "not initialised" on every call because no boot path ever constructed a
 * StandingOrderManager and injected it via setManager(). These tests pin the
 * failure mode (fail-closed tool result, not a crash) and the wired behavior
 * (CRUD through the tool + runner execution via triggers).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ToolContext } from '../../src/core/tools/types.js';

let dataDir: string;
const ctx = { sessionId: 'test-session' } as unknown as ToolContext;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'f89-standing-orders-'));
  process.env['DATA_DIR'] = dataDir;
});

afterAll(() => {
  delete process.env['DATA_DIR'];
  rmSync(dataDir, { recursive: true, force: true });
});

describe('F89 standing orders', () => {
  it('tool fails closed (no crash) before setManager is called', async () => {
    const { standingOrdersTool } = await import('../../src/core/tools/builtin/system/standing-orders.js');
    const res = await standingOrdersTool.execute({ operation: 'list' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain('not initialised');
  });

  it('after setManager: list shows seeded builtins, add/disable/remove work, runner fires', async () => {
    const { StandingOrderManager } = await import('../../src/core/automation/standing-orders.js');
    const { setManager, standingOrdersTool } = await import('../../src/core/tools/builtin/system/standing-orders.js');

    const ran: Array<{ action: string; orderId: string }> = [];
    const mgr = new StandingOrderManager(async (action, orderId) => {
      ran.push({ action, orderId });
    });
    setManager(mgr);

    // Seeded builtins visible through the tool.
    const list = await standingOrdersTool.execute({ operation: 'list' }, ctx);
    expect(list.success).toBe(true);
    expect(list.output).toContain('morning-briefing');
    expect(list.output).toContain('weekly-report');
    expect(list.output).toContain('error-monitor');

    // Add an event-triggered order through the tool.
    const add = await standingOrdersTool.execute(
      {
        operation: 'add',
        name: 'test order',
        description: 'fires on test-event',
        action: 'do the test thing',
        trigger: { kind: 'event', event: 'test-event' },
      },
      ctx,
    );
    expect(add.success).toBe(true);
    const orderId = (add.data as { order: { id: string } }).order.id;

    // Event emission executes the order through the injected runner.
    await mgr.emitEvent('test-event');
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ action: 'do the test thing', orderId });
    expect(mgr.getOrder(orderId)?.executionCount).toBe(1);

    // Disable stops execution; remove deletes.
    const disable = await standingOrdersTool.execute({ operation: 'disable', id: orderId }, ctx);
    expect(disable.success).toBe(true);
    await mgr.emitEvent('test-event');
    expect(ran).toHaveLength(1);

    const remove = await standingOrdersTool.execute({ operation: 'remove', id: orderId }, ctx);
    expect(remove.success).toBe(true);
    expect(mgr.getOrder(orderId)).toBeUndefined();
  });
});
