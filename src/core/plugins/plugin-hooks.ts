/**
 * @file plugin-hooks.ts
 * @description Bridge between PluginManifest hooks and the HookManager.
 *
 * When a plugin declares hooks in its manifest, the PluginLoader calls
 * registerPluginHooks() to map those declarations onto the running
 * HookManager instance.  unregisterPluginHooks() removes them when
 * the plugin is disabled or unloaded.
 *
 * This bridge translates manifest-level PluginHookDecl objects into
 * handler functions registered on the HookManager, ensuring that plugin
 * hooks are properly scoped, source-tagged, and cleaned up.
 *
 * For command-type hooks, the bridge spawns a child process.
 * For http-type hooks, it POSTs to the declared URL.
 * For function-type hooks, it calls the named function on the plugin module.
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import { type PluginManifest, type PluginHookDecl } from './plugin-manifest.js';
import { type HookManager, type HookEvent, type HookContext } from '../hooks/index.js';
import { execSync } from 'child_process';

const log = createLogger('plugin:hooks');

// ---------------------------------------------------------------------------
// Mapping table: plugin hook events -> HookManager events
// ---------------------------------------------------------------------------

/**
 * Map plugin manifest event names to HookManager HookEvent values.
 * Plugin manifests use lower-case colon-separated names while
 * HookManager uses both conventions.  Both are accepted; unknown
 * events pass through as-is.
 */
const EVENT_MAP: Record<string, HookEvent> = {
  // Tool lifecycle
  'before:tool-call': 'before:tool-call',
  'after:tool-call': 'after:tool-call',
  // Session lifecycle
  'session:start': 'session:start',
  'session:end': 'session:end',
  // Memory / dream lifecycle
  'pre:compact': 'pre:compact',
  'post:compact': 'post:compact',
  'dream:start': 'dream:start',
  'dream:end': 'dream:end',
  // Agent lifecycle
  'instructions:loaded': 'instructions:loaded',
  'teammate:idle': 'teammate:idle',
  'swarm:spawn': 'swarm:spawn',
  'swarm:complete': 'swarm:complete',
  // File events
  'on:file-write': 'on:file-write',
  'file:changed': 'file:changed',
  // Message events
  'on:message': 'on:message',
  // Error events
  'on:error': 'on:error',
  // Security events
  'tool:approved': 'tool:approved',
  'tool:denied': 'tool:denied',
  // Goal events
  'goal:created': 'goal:created',
  'goal:completed': 'goal:completed',
};

/**
 * Normalise a manifest hook event name to a HookManager HookEvent.
 * Falls back to passing the name through as-is (allows future events).
 */
function normaliseEvent(event: string): HookEvent {
  const lower = event.toLowerCase();
  return EVENT_MAP[lower] ?? (event as HookEvent);
}

// ---------------------------------------------------------------------------
// Registration tracking
// ---------------------------------------------------------------------------

/**
 * Track which hook IDs a plugin has registered so we can unregister
 * them later.
 *
 * Module-level singleton: registering the same plugin ID twice without an
 * intervening unregisterPluginHooks() accumulates duplicate registrations.
 * Callers (e.g. plugins/boot.ts) must pair register and unregister per
 * plugin lifecycle.
 */
const pluginHookIds = new Map<string, Set<string>>();

// ---------------------------------------------------------------------------
// Hook handler builders
// ---------------------------------------------------------------------------

/**
 * Build a hook handler from a command-type declaration.
 * Spawns a shell command when the hook fires.
 */
function buildCommandHandler(decl: PluginHookDecl): (ctx: HookContext) => Promise<void> {
  return async (ctx: HookContext) => {
    if (!decl.command) return;

    let command = decl.command;
    command = command.replace(/\$\{SUDO_PLUGIN_ROOT\}/g, process.env.SUDO_PLUGIN_ROOT ?? '');
    command = command.replace(/\$\{SUDO_AI_ROOT\}/g, process.env.SUDO_AI_ROOT ?? process.cwd());

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SUDO_HOOK_EVENT: ctx.event,
      SUDO_HOOK_TOOL: ctx.toolName ?? '',
    };

    try {
      execSync(command, {
        timeout: decl.timeout ?? 30_000,
        env,
        input: JSON.stringify(ctx),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      log.warn({ command: decl.command, err }, 'Command hook execution failed');
    }
  };
}

/**
 * Build a hook handler from an http-type declaration.
 * POSTs the hook context as JSON to the declared URL.
 */
function buildHttpHandler(decl: PluginHookDecl): (ctx: HookContext) => Promise<void> {
  return async (ctx: HookContext) => {
    if (!decl.url) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), decl.timeout ?? 30_000);

    try {
      await fetch(decl.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ctx),
        signal: controller.signal,
      });
    } catch (err) {
      log.warn({ url: decl.url, err }, 'HTTP hook execution failed');
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Build a hook handler from a function-type declaration.
 * Calls the named function on the provided plugin module.
 */
function buildFunctionHandler(
  decl: PluginHookDecl,
  moduleFns?: Record<string, (...args: unknown[]) => unknown>,
): (ctx: HookContext) => Promise<void> {
  return async (ctx: HookContext) => {
    if (!decl.functionName || !moduleFns) return;

    const fn = moduleFns[decl.functionName];
    if (typeof fn !== 'function') {
      log.warn({ functionName: decl.functionName }, 'Function hook: named function not found on module');
      return;
    }

    try {
      await fn(ctx);
    } catch (err) {
      log.warn({ functionName: decl.functionName, err }, 'Function hook execution failed');
    }
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register all hooks declared in a plugin manifest onto the HookManager.
 *
 * For each PluginHookDecl in manifest.hooks:
 *  1. Normalise the event name to a HookEvent
 *  2. Build an appropriate handler (command / http / function)
 *  3. Register on the HookManager and track the hook ID
 *
 * @param manifest - The plugin manifest containing hook declarations.
 * @param manager - The running HookManager instance.
 * @param moduleFns - Optional module exports for function-type hooks.
 * @returns Number of hooks registered.
 */
export function registerPluginHooks(
  manifest: PluginManifest,
  manager: HookManager,
  moduleFns?: Record<string, (...args: unknown[]) => unknown>,
): number {
  if (!manifest.hooks || manifest.hooks.length === 0) return 0;

  const pluginId = manifest.id;
  let registered = 0;

  for (const decl of manifest.hooks) {
    const event = normaliseEvent(decl.event);

    let handler: (ctx: HookContext) => Promise<void>;

    switch (decl.type) {
      case 'command':
        handler = buildCommandHandler(decl);
        break;
      case 'http':
        handler = buildHttpHandler(decl);
        break;
      case 'function':
        handler = buildFunctionHandler(decl, moduleFns);
        break;
      default:
        log.warn({ type: decl.type, pluginId }, 'Unknown hook type — skipping');
        continue;
    }

    const description = `plugin:${pluginId} [${decl.type}] ${decl.event}`;
    const hookId = manager.register(event, handler, description);

    // Track the hook ID for cleanup
    if (!pluginHookIds.has(pluginId)) {
      pluginHookIds.set(pluginId, new Set());
    }
    pluginHookIds.get(pluginId)!.add(hookId);
    registered++;

    log.debug({ pluginId, event, type: decl.type, hookId }, 'Plugin hook registered');
  }

  log.info({ pluginId, hookCount: registered }, 'Plugin hooks registered');
  return registered;
}

/**
 * Unregister all hooks that a plugin previously registered.
 *
 * Removes all hook IDs tracked for the given plugin from the HookManager.
 *
 * @param manifest - The plugin manifest.
 * @param manager - The running HookManager instance.
 * @returns Number of hooks removed.
 */
export function unregisterPluginHooks(manifest: PluginManifest, manager: HookManager): number {
  const pluginId = manifest.id;
  const ids = pluginHookIds.get(pluginId);

  if (!ids || ids.size === 0) return 0;

  let removed = 0;
  for (const hookId of ids) {
    manager.unregister(hookId);
    removed++;
  }

  pluginHookIds.delete(pluginId);

  log.info({ pluginId, removed }, 'Plugin hooks unregistered');
  return removed;
}

/**
 * Get the number of hooks currently registered for a plugin.
 */
export function getPluginHookCount(pluginId: string): number {
  return pluginHookIds.get(pluginId)?.size ?? 0;
}

/**
 * Check whether a plugin has any hooks currently registered.
 */
export function hasPluginHooks(pluginId: string): boolean {
  return (pluginHookIds.get(pluginId)?.size ?? 0) > 0;
}