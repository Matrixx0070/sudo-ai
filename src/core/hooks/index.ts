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
import { runVoidHook, runModifyingHook, runClaimingHook } from './hook-runner.js';
import type { HookResult, PrioritizedHook } from './hook-runner.js';

// Re-export hook-runner types and functions
export { runVoidHook, runModifyingHook, runClaimingHook, sortHooksByPriority } from './hook-runner.js';
export type { HookRunnerType, HookResult as HookRunnerResult, PrioritizedHook, HookRunnerConfig, VoidHookHandler, ModifyingHookHandler, ClaimingHookHandler } from './hook-runner.js';

// Re-export typed-hook definitions and convenience function
export { TYPED_HOOK_MAP, getHookRunnerType } from './typed-hooks.js';

// Re-export Claude Code–style command/HTTP/function hook engine
export {
  HookEngine,
  registerHookFunction,
  unregisterHookFunction,
} from './hook-engine.js';

export type {
  HookEvent as ExtHookEvent,
  HookType,
  HookDefinition,
  HookGroup as HookGroupExt,
  HookContext as ExtHookContext,
  HookResult as ExtHookResult,
  HookEngineConfig,
  HookFunction,
} from './hook-engine.js';
export type {
  PreToolCallResult,
  PostToolCallResult,
  PreLLMCallResult,
  TransformToolResultResult,
  TransformLLMOutputResult,
  OnErrorResult,
  SteeringResult,
  CompactionResult as TypedCompactionResult,
  SecurityResult as TypedSecurityResult,
  MemoryResult as TypedMemoryResult,
  VaultResult as TypedVaultResult,
  GoalResult as TypedGoalResult,
  AgentResult as TypedAgentResult,
  MessageResult as TypedMessageResult,
  GenericResult as TypedGenericResult,
} from './typed-hooks.js';

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
  // Fired once after every tool call in a turn has settled (batch-level hook)
  | 'tool_batch_complete'
  // Compaction alias events (distinct from pre:compact / post:compact)
  | 'before_compaction'
  | 'after_compaction'
  // Install lifecycle events
  | 'before_install'
  | 'after_install'
  // Vault events
  | 'vault:set'
  | 'vault:get'
  | 'vault:rotate'
  | 'vault:delete'
  // Rate limit events
  | 'rate-limit:triggered'
  // MCP loopback events
  | 'mcp:tool-call'
  // Cost-optimisation routing event
  | 'model:route:cheap'
  // Memory security events
  | 'memory:scan:triggered'
  // Task management events
  | 'task:created'
  | 'task:completed'
  // Cost / billing events
  | 'cost_rate_alert';

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
  /** Execution priority — higher values run first. Default: 50 */
  priority?: number;
  /** Secondary sort key within the same priority tier. Higher wins. Default: 1 */
  weight?: number;
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
   * @param options     - Optional scheduling metadata (priority, weight).
   * @returns The unique hook ID (use with `unregister` to remove it).
   */
  register(
    event: HookEvent,
    handler: (ctx: HookContext) => Promise<void>,
    description = '',
    options?: { priority?: number; weight?: number },
  ): string {
    if (!event || typeof event !== 'string') {
      throw new TypeError('HookManager.register: event must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('HookManager.register: handler must be a function');
    }

    const id = genId();
    const hook: Hook = {
      id,
      event,
      handler,
      description,
      priority: options?.priority ?? 50,
      weight: options?.weight ?? 1,
    };

    const list = this.hooks.get(event) ?? [];
    list.push(hook);
    // Keep list sorted by priority (desc), then weight (desc)
    list.sort((a, b) => {
      const pa = a.priority ?? 50;
      const pb = b.priority ?? 50;
      if (pb !== pa) return pb - pa;
      const wa = a.weight ?? 1;
      const wb = b.weight ?? 1;
      return wb - wa;
    });
    this.hooks.set(event, list);

    log.info({ event, hookId: id, description, priority: hook.priority, weight: hook.weight }, 'Hook registered');
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

  /**
   * Fire-and-forget emission — all handlers run in parallel.
   * Errors are swallowed and logged. No results are returned.
   *
   * Use for: telemetry, analytics, audit-logging.
   *
   * @param event   - Event name.
   * @param context - Context bag passed to each handler.
   */
  async emitVoid(event: HookEvent, context: HookContext): Promise<void> {
    const list = this.hooks.get(event);
    if (!list || list.length === 0) return;

    const prioritized: PrioritizedHook[] = list.map((h) => ({
      ...h,
      priority: h.priority ?? 50,
      weight: h.weight ?? 1,
    }));

    await runVoidHook(event, context, prioritized);
  }

  /**
   * Sequential context-mutation emission.
   * Each handler receives and can modify the context; the final
   * (possibly enriched) context is returned to the caller.
   *
   * Use for: sanitising output, injecting context, enriching messages.
   *
   * @param event   - Event name.
   * @param context - Context bag threaded through each handler.
   * @returns The modified context after all handlers have run.
   */
  async emitModifying(event: HookEvent, context: HookContext): Promise<HookContext> {
    const list = this.hooks.get(event);
    if (!list || list.length === 0) return context;

    const prioritized: PrioritizedHook[] = list.map((h) => ({
      ...h,
      priority: h.priority ?? 50,
      weight: h.weight ?? 1,
    }));

    return runModifyingHook(event, context, prioritized);
  }

  /**
   * First-claim-wins emission.
   * Handlers run in priority order; the first one that returns a
   * non-null HookResult claims the event and the rest are skipped.
   * Returns null if no handler claims.
   *
   * Use for: security vetoes, permission gates, policy enforcement.
   *
   * @param event   - Event name.
   * @param context - Context bag passed to each handler.
   * @returns The winning HookResult, or null if nobody claimed.
   */
  async emitClaiming(event: HookEvent, context: HookContext): Promise<HookResult | null> {
    const list = this.hooks.get(event);
    if (!list || list.length === 0) return null;

    const prioritized: PrioritizedHook[] = list.map((h) => ({
      ...h,
      priority: h.priority ?? 50,
      weight: h.weight ?? 1,
    }));

    return runClaimingHook(event, context, prioritized);
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
