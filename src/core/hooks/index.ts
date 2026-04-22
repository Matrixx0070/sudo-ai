/**
 * @file hooks/index.ts
 * @description HookManager — lifecycle event hooks for SUDO-AI.
 *
 * Hooks are registered programmatically by name, tied to a specific event,
 * and executed in registration order when that event fires. All hook errors
 * are caught and logged so a misbehaving hook never crashes the agent loop.
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';

const log = createLogger('hooks');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All lifecycle events that can be observed. */
export type HookEvent =
  // Core tool / brain events (original 7)
  | 'before:tool-call'
  | 'after:tool-call'
  | 'before:brain-call'
  | 'after:brain-call'
  | 'on:error'
  | 'on:file-write'
  | 'on:message'
  // Lifecycle events
  | 'session:start'
  | 'session:end'
  // Memory events
  | 'pre:compact'
  | 'post:compact'
  | 'dream:start'
  | 'dream:end'
  // Agent events
  | 'instructions:loaded'
  | 'teammate:idle'
  | 'swarm:spawn'
  | 'swarm:complete'
  | 'background:start'
  | 'background:complete'
  // Goal events
  | 'goal:created'
  | 'goal:completed'
  // Security events
  | 'tool:approved'
  | 'tool:denied'
  // Steering events
  | 'steering:received'
  // Integration events
  | 'mcp:connected'
  | 'a2a:message'
  | 'file:changed'
  // Command lifecycle events (OpenClaw parity)
  | 'command:new'
  | 'command:reset'
  | 'command:stop'
  // Session compaction events (OpenClaw parity)
  | 'session:compact:before'
  | 'session:compact:after'
  | 'session:compact:patch'
  // Agent bootstrap event
  | 'agent:bootstrap'
  // Gateway lifecycle events
  | 'gateway:startup'
  | 'gateway:shutdown'
  // Message lifecycle events
  | 'message:received'
  | 'message:transcribed'
  | 'message:preprocessed'
  | 'message:sent'
  // Model / prompt pipeline events
  | 'before_model_resolve'
  | 'before_prompt_build'
  // Persistence event
  | 'tool_result_persist'
  // Compaction alias events (distinct from pre:compact / post:compact)
  | 'before_compaction'
  | 'after_compaction'
  // Install lifecycle events
  | 'before_install'
  | 'after_install'
  // Wave 3 — Vault events
  | 'vault:set'
  | 'vault:get'
  | 'vault:rotate'
  | 'vault:delete'
  // Wave 3 — Rate limit events
  | 'rate-limit:triggered'
  // Wave 3 — MCP loopback events
  | 'mcp:tool-call'
  // Wave 4 — Cost-optimisation routing event
  | 'model:route:cheap'
  // Wave 4 — Memory security events
  | 'memory:scan:triggered';

/**
 * Context bag passed to every hook handler.
 * Fields are event-specific; unused fields are `undefined`.
 */
export interface HookContext {
  /** The event that triggered this hook invocation. */
  event: HookEvent;
  /** Present for tool-call events. */
  toolName?: string;
  /** Arguments for the tool call. */
  args?: Record<string, unknown>;
  /** Result from the tool or brain call. */
  result?: unknown;
  /** Error instance on `on:error`. */
  error?: Error;
  /** Absolute path of a file that was written (on:file-write). */
  filePath?: string;
  /** Raw message text (on:message). */
  message?: string;
  /** Session ID for session / command / message lifecycle events. */
  sessionId?: string;
  /** Channel identifier (e.g. 'telegram', 'web', 'ws'). */
  channel?: string;
  /** Command string for command:* events. */
  command?: string;
  /** Gateway identifier for gateway:startup / gateway:shutdown events. */
  gatewayId?: string;
  /** Model name resolved for before_model_resolve events. */
  modelName?: string;
  /** Compaction patch content for session:compact:patch events. */
  patch?: string;
  /** Arbitrary extra metadata attached by the emitter. */
  meta?: Record<string, unknown>;
  /** Vault namespace (vault:* events). */
  vaultNamespace?: string;
  /** Vault key name (vault:* events). */
  vaultKey?: string;
  /** Requester ID — agentId or sessionId (vault:* events). */
  requester?: string;
  /** Peer identifier for rate-limit:triggered events. Reuses peerId pattern. */
  peerId?: string;
}

/** A registered hook entry. */
export interface Hook {
  /** Unique nanoid assigned at registration. */
  id: string;
  /** Event this hook listens to. */
  event: HookEvent;
  /** Async handler executed when the event fires. */
  handler: (context: HookContext) => Promise<void>;
  /** Human-readable description (e.g. for /hooks list). */
  description: string;
}

// ---------------------------------------------------------------------------
// HookManager
// ---------------------------------------------------------------------------

/**
 * Central registry and emitter for lifecycle hooks.
 *
 * @example
 * ```ts
 * const hooks = new HookManager();
 * hooks.register('after:tool-call', async (ctx) => {
 *   console.log('Tool ran:', ctx.toolName);
 * }, 'Log every tool call');
 * await hooks.emit('after:tool-call', { event: 'after:tool-call', toolName: 'fs.read' });
 * ```
 */
export class HookManager {
  private readonly hooks: Map<HookEvent, Hook[]> = new Map();

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a hook handler for the given event.
   *
   * @param event       - Lifecycle event to listen for.
   * @param handler     - Async function executed when the event fires.
   * @param description - Optional human-readable label for this hook.
   * @returns The unique hook ID (use with `unregister` to remove it).
   */
  register(
    event: HookEvent,
    handler: (ctx: HookContext) => Promise<void>,
    description = '',
  ): string {
    if (!event || typeof event !== 'string') {
      throw new TypeError('HookManager.register: event must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('HookManager.register: handler must be a function');
    }

    const id = genId();
    const hook: Hook = { id, event, handler, description };

    const list = this.hooks.get(event) ?? [];
    list.push(hook);
    this.hooks.set(event, list);

    log.info({ event, hookId: id, description }, 'Hook registered');
    return id;
  }

  /**
   * Remove a previously registered hook by its ID.
   * Silently does nothing when the ID is not found.
   *
   * @param id - Hook ID returned from `register`.
   */
  unregister(id: string): void {
    if (!id) return;

    for (const [event, list] of this.hooks.entries()) {
      const idx = list.findIndex((h) => h.id === id);
      if (idx !== -1) {
        list.splice(idx, 1);
        if (list.length === 0) this.hooks.delete(event);
        log.info({ event, hookId: id }, 'Hook unregistered');
        return;
      }
    }

    log.warn({ hookId: id }, 'unregister: hook ID not found');
  }

  // -------------------------------------------------------------------------
  // Emission
  // -------------------------------------------------------------------------

  /**
   * Fire all hooks registered for the given event.
   * Hook errors are caught and logged — they never propagate to the caller.
   *
   * @param event   - Event name.
   * @param context - Context bag passed to each handler.
   */
  async emit(event: HookEvent, context: HookContext): Promise<void> {
    const list = this.hooks.get(event);
    if (!list || list.length === 0) return;

    log.debug({ event, hookCount: list.length }, 'Emitting hooks');

    for (const hook of list) {
      try {
        await hook.handler(context);
      } catch (err) {
        log.error(
          { event, hookId: hook.id, err: String(err) },
          'Hook handler threw — continuing to next hook',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /**
   * Return a snapshot of all registered hooks across all events.
   */
  listHooks(): Hook[] {
    const result: Hook[] = [];
    for (const list of this.hooks.values()) {
      result.push(...list);
    }
    return result;
  }

  /** Total count of registered hooks. */
  get size(): number {
    let count = 0;
    for (const list of this.hooks.values()) count += list.length;
    return count;
  }
}
