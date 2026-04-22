/**
 * system.standing-orders tool
 *
 * Allows the agent to list, add, remove, enable, or disable its own
 * standing orders at runtime. Requires a StandingOrderManager instance
 * to be injected via the tool registry or a module-level singleton.
 */

import { createLogger } from '../../../shared/logger.js';
import { ToolError } from '../../../shared/errors.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import type { StandingOrderManager } from '../../../automation/standing-orders.js';
import type { OrderTrigger } from '../../../automation/types.js';

const log = createLogger('tool:system.standing-orders');

// Module-level manager reference, set via setManager().
let _manager: StandingOrderManager | null = null;

/**
 * Inject the StandingOrderManager instance before any tool executions.
 * Call this once at application startup.
 */
export function setManager(manager: StandingOrderManager): void {
  _manager = manager;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireManager(): StandingOrderManager {
  if (!_manager) {
    throw new ToolError(
      'StandingOrderManager not initialised — call setManager() at startup',
      'tool_standing_orders_not_init',
    );
  }
  return _manager;
}

function parseTrigger(raw: unknown): OrderTrigger {
  if (typeof raw !== 'object' || raw === null) {
    throw new ToolError('trigger must be an object', 'tool_standing_orders_bad_trigger');
  }
  const t = raw as Record<string, unknown>;
  const kind = t['kind'];

  if (kind === 'schedule') {
    if (typeof t['cron'] !== 'string' || !t['cron']) {
      throw new ToolError('schedule trigger requires cron string', 'tool_standing_orders_bad_trigger');
    }
    return { kind: 'schedule', cron: t['cron'], tz: String(t['tz'] ?? 'Asia/Kolkata') };
  }

  if (kind === 'event') {
    if (typeof t['event'] !== 'string' || !t['event']) {
      throw new ToolError('event trigger requires event string', 'tool_standing_orders_bad_trigger');
    }
    return { kind: 'event', event: t['event'] };
  }

  if (kind === 'condition') {
    if (typeof t['check'] !== 'string' || !t['check']) {
      throw new ToolError('condition trigger requires check string', 'tool_standing_orders_bad_trigger');
    }
    const intervalMs = typeof t['intervalMs'] === 'number' ? t['intervalMs'] : 60_000;
    return { kind: 'condition', check: t['check'], intervalMs };
  }

  throw new ToolError(`Unknown trigger kind: ${String(kind)}`, 'tool_standing_orders_bad_trigger');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const standingOrdersTool: ToolDefinition = {
  name: 'system.standing-orders',
  description:
    'Manage SUDO-AI standing orders — permanent autonomous rules the agent follows without being explicitly prompted. ' +
    'Operations: list (show all), add (create new), remove (delete by id), enable (activate), disable (deactivate).',
  category: 'system',
  parameters: {
    operation: {
      type: 'string',
      description: 'Operation to perform: list | add | remove | enable | disable',
      required: true,
      enum: ['list', 'add', 'remove', 'enable', 'disable'],
    },
    id: {
      type: 'string',
      description: 'Standing order ID — required for remove, enable, disable.',
    },
    name: {
      type: 'string',
      description: 'Short name for the new order (required for add).',
    },
    description: {
      type: 'string',
      description: 'Human-readable description of what the order does (required for add).',
    },
    trigger: {
      type: 'object',
      description:
        'Trigger definition for the order (required for add). ' +
        'Examples: {"kind":"schedule","cron":"0 7 * * *","tz":"Asia/Kolkata"} | ' +
        '{"kind":"event","event":"error"} | ' +
        '{"kind":"condition","check":"disk > 90%","intervalMs":300000}',
      properties: {
        kind: { type: 'string', description: 'Trigger kind: schedule | event | condition' },
        cron: { type: 'string', description: 'Cron expression (schedule trigger)' },
        tz: { type: 'string', description: 'IANA timezone (schedule trigger)' },
        event: { type: 'string', description: 'Event name (event trigger)' },
        check: { type: 'string', description: 'Condition description (condition trigger)' },
        intervalMs: { type: 'number', description: 'Check interval in ms (condition trigger)' },
      },
    },
    action: {
      type: 'string',
      description: 'Natural-language instruction for the agent to execute (required for add).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const { sessionId } = ctx;
    const operation = String(params['operation'] ?? '');

    log.info({ sessionId, operation }, 'system.standing-orders called');

    try {
      const mgr = requireManager();

      switch (operation) {
        case 'list': {
          const orders = mgr.listOrders();
          const summary = orders.map((o) => ({
            id: o.id,
            name: o.name,
            enabled: o.enabled,
            triggerKind: o.trigger.kind,
            executionCount: o.executionCount,
            lastExecuted: o.lastExecuted ?? 'never',
          }));
          return {
            success: true,
            output: `Found ${orders.length} standing order(s):\n${JSON.stringify(summary, null, 2)}`,
            data: { orders: summary },
          };
        }

        case 'add': {
          const name = String(params['name'] ?? '');
          const desc = String(params['description'] ?? '');
          const action = String(params['action'] ?? '');
          if (!name) return { success: false, output: 'name is required for add' };
          if (!action) return { success: false, output: 'action is required for add' };
          if (!params['trigger']) return { success: false, output: 'trigger is required for add' };

          const trigger = parseTrigger(params['trigger']);
          const order = mgr.addOrder({ name, description: desc, trigger, action, enabled: true });
          log.info({ orderId: order.id, sessionId }, 'Standing order added via tool');
          return {
            success: true,
            output: `Standing order created: ${order.id} — "${order.name}"`,
            data: { order },
          };
        }

        case 'remove': {
          const id = String(params['id'] ?? '');
          if (!id) return { success: false, output: 'id is required for remove' };
          const removed = mgr.removeOrder(id);
          return removed
            ? { success: true, output: `Standing order removed: ${id}` }
            : { success: false, output: `Standing order not found: ${id}` };
        }

        case 'enable':
        case 'disable': {
          const id = String(params['id'] ?? '');
          if (!id) return { success: false, output: `id is required for ${operation}` };
          const ok = mgr.setEnabled(id, operation === 'enable');
          return ok
            ? { success: true, output: `Standing order ${operation}d: ${id}` }
            : { success: false, output: `Standing order not found: ${id}` };
        }

        default:
          return { success: false, output: `Unknown operation: ${operation}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId, operation, err }, 'system.standing-orders error');
      return { success: false, output: `Error: ${msg}` };
    }
  },
};
