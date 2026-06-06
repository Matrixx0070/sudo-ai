/**
 * @file hook-engine.ts
 * @description Hook Engine for SUDO-AI v4.
 *
 * Reverse-engineered from Claude Code v2.1.97: Claude has 21+ hook events
 * (PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied, Notification,
 * UserPromptSubmit, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart,
 * SubagentStop, PreCompact, PostCompact, PermissionRequest, Setup, TeammateIdle,
 * TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange,
 * WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged).
 *
 * SUDO-AI's hook system extends this with additional events for our
 * consciousness layer, dream system, and skill marketplace.
 *
 * Hooks are the extensibility backbone — they allow users and plugins
 * to react to lifecycle events without modifying core code.
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const log = createLogger('hooks:engine');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** All hook events supported by SUDO-AI. */
export type HookEvent =
  // Tool lifecycle
  | 'PreToolCall'
  | 'PostToolCall'
  | 'PostToolCallFailure'
  // Permission lifecycle
  | 'PermissionDenied'
  | 'PermissionRequest'
  // Session lifecycle
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'StopFailure'
  // Agent lifecycle
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TeammateIdle'
  // Task lifecycle
  | 'TaskCreated'
  | 'TaskCompleted'
  // Memory lifecycle
  | 'MemoryChanged'
  | 'MemorySynced'
  // Skill lifecycle
  | 'SkillInstalled'
  | 'SkillPublished'
  | 'SkillRemoved'
  // Plugin lifecycle
  | 'PluginLoaded'
  | 'PluginUnloaded'
  // Config lifecycle
  | 'ConfigChanged'
  | 'InstructionsLoaded'
  // Context lifecycle
  | 'PreCompact'
  | 'PostCompact'
  | 'CwdChanged'
  | 'FileChanged'
  // Consciousness lifecycle (SUDO-AI extensions)
  | 'DreamStart'
  | 'DreamEnd'
  | 'HeartbeatGenerated'
  | 'KairosAlert'
  // User interaction
  | 'UserPromptSubmit'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'Notification'
  // Setup
  | 'Setup'
  // Worktree
  | 'WorktreeCreate'
  | 'WorktreeRemove';

/** Hook execution type. */
export type HookType = 'command' | 'http' | 'function';

/** A single hook definition. */
export interface HookDefinition {
  /** Unique ID for this hook. */
  id?: string;
  /** Type of hook — command (shell), http (webhook), or function (in-process). */
  type: HookType;
  /** For command hooks: the shell command to execute. */
  command?: string;
  /** For HTTP hooks: the URL to POST to. */
  url?: string;
  /** For function hooks: the function name to call. */
  functionName?: string;
  /** Timeout in milliseconds (default 30s). */
  timeout?: number;
  /** Whether this hook is enabled. */
  enabled?: boolean;
  /** Source of this hook (plugin name, settings, manual). */
  source?: string;
}

/** A group of hooks for a specific event. */
export interface HookGroup {
  /** Event this group is registered for. */
  event: HookEvent;
  /** Hooks to execute for this event. */
  hooks: HookDefinition[];
  /** Source of this hook group (plugin name, settings file, etc). */
  source: string;
}

/** Context passed to hook handlers. */
export interface HookContext {
  /** The event that triggered this hook. */
  event: HookEvent;
  /** Tool name (for tool-related events). */
  toolName?: string;
  /** Tool use ID (for tool-related events). */
  toolUseId?: string;
  /** Tool input parameters. */
  toolInput?: Record<string, unknown>;
  /** Tool result (for PostToolCall events). */
  toolResult?: unknown;
  /** Error message (for failure events). */
  error?: string;
  /** Session ID. */
  sessionId?: string;
  /** Agent ID (for subagent events). */
  agentId?: string;
  /** Agent name (for teammate events). */
  agentName?: string;
  /** Team name (for team events). */
  teamName?: string;
  /** Task ID (for task events). */
  taskId?: string;
  /** Task subject (for task events). */
  taskSubject?: string;
  /** File path (for file-related events). */
  filePath?: string;
  /** Configuration key that changed (for ConfigChanged). */
  configKey?: string;
  /** Additional metadata. */
  metadata?: Record<string, unknown>;
}

/** Result from a hook execution. */
export interface HookResult {
  /** Hook definition that was executed. */
  hook: HookDefinition;
  /** Whether execution succeeded. */
  success: boolean;
  /** Output from the hook (stdout for command hooks, response for HTTP). */
  output?: string;
  /** Error message if execution failed. */
  error?: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Whether the hook vetoes the action (for PreToolCall only). */
  veto?: boolean;
  /** Veto reason (if vetoed). */
  vetoReason?: string;
}

/** Configuration for the hook engine. */
export interface HookEngineConfig {
  /** Whether hooks are enabled. */
  enabled: boolean;
  /** Default timeout for hook execution (ms). */
  defaultTimeout: number;
  /** Maximum concurrent hook executions per event. */
  maxConcurrency: number;
  /** Directory for hook state persistence. */
  dataDir: string;
  /** Kill-switch: completely disable all hooks. */
  killSwitch: boolean;
}

const DEFAULT_CONFIG: Readonly<HookEngineConfig> = {
  enabled: true,
  defaultTimeout: 30000,
  maxConcurrency: 10,
  dataDir: 'data/hooks',
  killSwitch: false,
};

// ---------------------------------------------------------------------------
// In-process function registry
// ---------------------------------------------------------------------------

/** Type for in-process hook functions. */
export type HookFunction = (ctx: HookContext) => Promise<HookResult> | HookResult;

const functionRegistry = new Map<string, HookFunction>();

/**
 * Register an in-process hook function.
 */
export function registerHookFunction(name: string, fn: HookFunction): void {
  functionRegistry.set(name, fn);
  log.info({ functionName: name }, 'Registered hook function');
}

/**
 * Unregister an in-process hook function.
 */
export function unregisterHookFunction(name: string): void {
  functionRegistry.delete(name);
  log.info({ functionName: name }, 'Unregistered hook function');
}

// ---------------------------------------------------------------------------
// HookEngine
// ---------------------------------------------------------------------------

/**
 * Hook Engine — the extensibility backbone for SUDO-AI.
 *
 * Based on Claude Code's 21+ hook events, extended with SUDO-AI's
 * consciousness and dream lifecycle events. Hooks allow users and plugins
 * to react to lifecycle events without modifying core code.
 */
export class HookEngine {
  private readonly config: Readonly<HookEngineConfig>;
  private readonly registry: Map<HookEvent, HookGroup[]> = new Map();
  private readonly executionHistory: HookResult[] = [];
  private readonly executionStats: Map<HookEvent, { fired: number; succeeded: number; failed: number; vetoed: number }> = new Map();

  constructor(config?: Partial<HookEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.enabled) {
      try {
        mkdirSync(this.config.dataDir, { recursive: true });
      } catch {
        log.warn({ dir: this.config.dataDir }, 'Cannot create hook data directory');
      }
    }

    log.info(
      {
        enabled: this.config.enabled,
        defaultTimeout: this.config.defaultTimeout,
        killSwitch: this.config.killSwitch,
      },
      'HookEngine initialized',
    );
  }

  // -------------------------------------------------------------------------
  // Registration API
  // -------------------------------------------------------------------------

  /**
   * Register a hook group for an event.
   */
  register(group: HookGroup): void {
    if (!this.registry.has(group.event)) {
      this.registry.set(group.event, []);
    }

    const groups = this.registry.get(group.event)!;

    // Deduplicate by source — replace existing group from same source
    const existingIdx = groups.findIndex(g => g.source === group.source);
    if (existingIdx >= 0) {
      groups[existingIdx] = group;
      log.info({ event: group.event, source: group.source }, 'Replaced existing hook group');
    } else {
      groups.push(group);
      log.info({ event: group.event, source: group.source, hookCount: group.hooks.length }, 'Registered hook group');
    }
  }

  /**
   * Unregister all hooks from a specific source.
   */
  unregisterBySource(source: string): number {
    let removed = 0;
    for (const [event, groups] of this.registry.entries()) {
      const before = groups.length;
      const filtered = groups.filter(g => g.source !== source);
      removed += before - filtered.length;
      this.registry.set(event, filtered);
    }

    log.info({ source, removed }, 'Unregistered hooks by source');
    return removed;
  }

  /**
   * Register hooks from a settings configuration (like Claude Code's settings.json).
   */
  registerFromSettings(settings: Record<string, unknown>): number {
    let totalHooks = 0;
    const hooksConfig = settings.hooks as Record<string, HookGroup[] | undefined> | undefined;
    if (!hooksConfig) return 0;

    for (const [event, groups] of Object.entries(hooksConfig)) {
      if (!groups) continue;

      for (const group of groups) {
        this.register({
          event: event as HookEvent,
          hooks: group.hooks.map(h => ({
            ...h,
            id: h.id ?? genId(),
            source: 'settings',
            enabled: h.enabled ?? true,
          })),
          source: 'settings',
        });
        totalHooks += group.hooks.length;
      }
    }

    log.info({ totalHooks }, 'Registered hooks from settings');
    return totalHooks;
  }

  // -------------------------------------------------------------------------
  // Execution API
  // -------------------------------------------------------------------------

  /**
   * Fire a hook event. Executes all registered hooks for this event.
   *
   * For PreToolCall events, if any hook vetoes, the action is blocked.
   * Returns all hook results.
   */
  async fire(event: HookEvent, context?: Partial<HookContext>): Promise<HookResult[]> {
    if (this.config.killSwitch || !this.config.enabled) {
      return [];
    }

    const fullContext: HookContext = { event, ...context };
    const groups = this.registry.get(event) ?? [];

    if (groups.length === 0) {
      return [];
    }

    // Collect all hooks across all groups for this event
    const allHooks: { definition: HookDefinition; source: string }[] = [];
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.enabled !== false) {
          allHooks.push({ definition: { ...hook, id: hook.id ?? genId() }, source: group.source });
        }
      }
    }

    if (allHooks.length === 0) return [];

    // Execute hooks with concurrency limit
    const results: HookResult[] = [];
    const batches: { definition: HookDefinition; source: string }[][] = [];
    for (let i = 0; i < allHooks.length; i += this.config.maxConcurrency) {
      batches.push(allHooks.slice(i, i + this.config.maxConcurrency));
    }

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(({ definition, source }) =>
          this._executeHook(definition, fullContext, source),
        ),
      );
      results.push(...batchResults);
    }

    // Update stats
    this._updateStats(event, results);

    // Store history (keep last 1000)
    this.executionHistory.push(...results);
    if (this.executionHistory.length > 1000) {
      this.executionHistory.splice(0, this.executionHistory.length - 1000);
    }

    return results;
  }

  /**
   * Fire a PreToolCall hook and check for vetoes.
   * Returns true if the action should proceed, false if any hook vetoed.
   */
  async firePreToolCall(
    toolName: string,
    toolUseId: string,
    toolInput?: Record<string, unknown>,
    context?: Partial<HookContext>,
  ): Promise<{ allowed: boolean; vetoReason?: string; results: HookResult[] }> {
    const results = await this.fire('PreToolCall', {
      toolName,
      toolUseId,
      toolInput,
      ...context,
    });

    for (const result of results) {
      if (result.veto) {
        log.warn(
          { toolName, toolUseId, vetoReason: result.vetoReason, hook: result.hook.id },
          'PreToolCall hook vetoed action',
        );
        return { allowed: false, vetoReason: result.vetoReason, results };
      }
    }

    return { allowed: true, results };
  }

  // -------------------------------------------------------------------------
  // Query API
  // -------------------------------------------------------------------------

  /**
   * Get all registered hooks for a specific event.
   */
  getHooksForEvent(event: HookEvent): HookGroup[] {
    return this.registry.get(event) ?? [];
  }

  /**
   * Get all registered events.
   */
  getRegisteredEvents(): HookEvent[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Get execution statistics.
   */
  getStats(): Record<string, { fired: number; succeeded: number; failed: number; vetoed: number }> {
    const stats: Record<string, { fired: number; succeeded: number; failed: number; vetoed: number }> = {};
    for (const [event, data] of this.executionStats.entries()) {
      stats[event] = { ...data };
    }
    return stats;
  }

  /**
   * Get recent execution history.
   */
  getHistory(limit: number = 50): HookResult[] {
    return this.executionHistory.slice(-limit);
  }

  /**
   * Get total hook count across all events.
   */
  getTotalHookCount(): number {
    let count = 0;
    for (const groups of this.registry.values()) {
      for (const group of groups) {
        count += group.hooks.filter(h => h.enabled !== false).length;
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Save hook configuration to disk.
   */
  saveConfig(): void {
    const configPath = join(this.config.dataDir, 'hooks-config.json');
    const data: Record<string, HookGroup[]> = {};
    for (const [event, groups] of this.registry.entries()) {
      data[event] = groups;
    }

    try {
      writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
      log.info({ path: configPath }, 'Saved hook configuration');
    } catch (err) {
      log.warn({ err }, 'Failed to save hook configuration');
    }
  }

  /**
   * Load hook configuration from disk.
   */
  loadConfig(): number {
    const configPath = join(this.config.dataDir, 'hooks-config.json');
    if (!existsSync(configPath)) return 0;

    try {
      const data = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, HookGroup[]>;
      let count = 0;
      for (const [event, groups] of Object.entries(data)) {
        for (const group of groups) {
          this.register({ ...group, event: event as HookEvent });
          count += group.hooks.length;
        }
      }
      log.info({ count }, 'Loaded hook configuration from disk');
      return count;
    } catch (err) {
      log.warn({ err }, 'Failed to load hook configuration');
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _executeHook(
    definition: HookDefinition,
    context: HookContext,
    source: string,
  ): Promise<HookResult> {
    const start = Date.now();
    const timeout = definition.timeout ?? this.config.defaultTimeout;

    try {
      let result: HookResult;

      switch (definition.type) {
        case 'command':
          result = await this._executeCommandHook(definition, context, timeout);
          break;
        case 'http':
          result = await this._executeHttpHook(definition, context, timeout);
          break;
        case 'function':
          result = await this._executeFunctionHook(definition, context);
          break;
        default:
          result = {
            hook: definition,
            success: false,
            error: `Unknown hook type: ${definition.type}`,
            durationMs: Date.now() - start,
          };
      }

      return result;
    } catch (err) {
      return {
        hook: definition,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  private _executeCommandHook(
    definition: HookDefinition,
    context: HookContext,
    timeout: number,
  ): HookResult {
    const start = Date.now();

    if (!definition.command) {
      return {
        hook: definition,
        success: false,
        error: 'No command specified for command hook',
        durationMs: Date.now() - start,
      };
    }

    // Replace environment variables in command
    let command = definition.command;
    command = command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, process.env.SUDO_PLUGIN_ROOT ?? '');
    command = command.replace(/\$\{SUDO_AI_ROOT\}/g, process.env.SUDO_AI_ROOT ?? process.cwd());

    // Build environment from context
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SUDO_HOOK_EVENT: context.event,
      SUDO_HOOK_TOOL: context.toolName ?? '',
      SUDO_HOOK_SESSION: context.sessionId ?? '',
      SUDO_HOOK_AGENT: context.agentName ?? '',
      SUDO_HOOK_FILE: context.filePath ?? '',
      SUDO_HOOK_TASK: context.taskId ?? '',
    };

    // Pass context as JSON via stdin
    const contextJson = JSON.stringify(context);

    try {
      const output = execSync(command, {
        timeout,
        env,
        input: contextJson,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Check for veto in output (for PreToolCall hooks)
      let veto = false;
      let vetoReason: string | undefined;
      if (context.event === 'PreToolCall') {
        try {
          const parsed = JSON.parse(output.trim());
          if (parsed.veto === true || parsed.allow === false) {
            veto = true;
            vetoReason = parsed.reason ?? parsed.vetoReason ?? 'Hook vetoed action';
          }
        } catch {
          // Non-JSON output — check for VETO: prefix
          if (output.trim().startsWith('VETO:')) {
            veto = true;
            vetoReason = output.trim().replace('VETO:', '').trim() || 'Hook vetoed action';
          }
        }
      }

      return {
        hook: definition,
        success: true,
        output: output.trim(),
        durationMs: Date.now() - start,
        veto,
        vetoReason,
      };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
      const isTimeout = execErr.killed || execErr.signal === 'SIGTERM';

      return {
        hook: definition,
        success: false,
        output: execErr.stdout?.trim(),
        error: isTimeout ? 'Hook timed out' : (execErr.stderr?.trim() ?? String(err)),
        durationMs: Date.now() - start,
      };
    }
  }

  private async _executeHttpHook(
    definition: HookDefinition,
    context: HookContext,
    timeout: number,
  ): Promise<HookResult> {
    const start = Date.now();

    if (!definition.url) {
      return {
        hook: definition,
        success: false,
        error: 'No URL specified for HTTP hook',
        durationMs: Date.now() - start,
      };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(definition.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(context),
        signal: controller.signal,
      });

      clearTimeout(timer);

      const body = await response.text();

      // Check for veto in response
      let veto = false;
      let vetoReason: string | undefined;
      if (context.event === 'PreToolCall' && response.ok) {
        try {
          const parsed = JSON.parse(body);
          if (parsed.veto === true || parsed.allow === false) {
            veto = true;
            vetoReason = parsed.reason ?? 'HTTP hook vetoed action';
          }
        } catch {
          // Non-JSON response — ignore veto check
        }
      }

      return {
        hook: definition,
        success: response.ok,
        output: body.trim(),
        error: response.ok ? undefined : `HTTP ${response.status}`,
        durationMs: Date.now() - start,
        veto,
        vetoReason,
      };
    } catch (err) {
      return {
        hook: definition,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  private async _executeFunctionHook(
    definition: HookDefinition,
    context: HookContext,
  ): Promise<HookResult> {
    const start = Date.now();

    if (!definition.functionName) {
      return {
        hook: definition,
        success: false,
        error: 'No function name specified for function hook',
        durationMs: Date.now() - start,
      };
    }

    const fn = functionRegistry.get(definition.functionName);
    if (!fn) {
      return {
        hook: definition,
        success: false,
        error: `Hook function not found: ${definition.functionName}`,
        durationMs: Date.now() - start,
      };
    }

    try {
      const result = await fn(context);
      return {
        ...result,
        hook: definition,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        hook: definition,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  private _updateStats(event: HookEvent, results: HookResult[]): void {
    if (!this.executionStats.has(event)) {
      this.executionStats.set(event, { fired: 0, succeeded: 0, failed: 0, vetoed: 0 });
    }

    const stats = this.executionStats.get(event)!;
    stats.fired += results.length;

    for (const result of results) {
      if (result.veto) stats.vetoed++;
      else if (result.success) stats.succeeded++;
      else stats.failed++;
    }
  }
}