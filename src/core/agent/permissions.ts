/**
 * @file permissions.ts
 * @description Tool permission system for SUDO-AI.
 *
 * Based on Claude Code's permission modes. Every tool has a permission mode:
 *   auto  — execute without asking the user
 *   ask   — pause and request explicit user approval before executing
 *   deny  — permanently block; emit a denial message instead of executing
 *
 * The permission system is additive on top of the existing approval gate in
 * loop-helpers.ts. Tools with mode='ask' fall through to the approval gate;
 * tools with mode='deny' are short-circuited before the approval gate;
 * tools with mode='auto' skip the approval gate entirely.
 *
 * Consumers can override default permissions at runtime via
 * PermissionManager.getInstance().override(toolName, mode).
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:permissions');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Permission mode for a tool.
 *
 * - auto  Execute immediately without prompting (low-risk reads, writes, browser).
 * - ask   Require user approval before each execution (destructive or sensitive).
 * - deny  Always block — never execute regardless of approval.
 */
export type PermissionMode = 'auto' | 'ask' | 'deny';

/** Per-tool permission entry stored in the manager. */
export interface ToolPermission {
  /** Registered tool name (exact match or prefix with trailing '*'). */
  toolName: string;
  /** Resolved permission mode. */
  mode: PermissionMode;
  /** Human-readable explanation for why this mode was assigned. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Default permission table
// ---------------------------------------------------------------------------

/**
 * Default permission modes for known dangerous tools.
 * Keys are exact tool names; prefix matching uses toolName.startsWith(key).
 * Use '*' suffix for category-level matching.
 */
const DEFAULT_PERMISSIONS: Record<string, PermissionMode> = {
  // Shell execution — dangerous, always ask first
  'system.exec': 'ask',
  'system.shell': 'ask',
  'system.run': 'ask',

  // Process management
  'system.process-kill': 'ask',
  'system.kill': 'ask',

  // Self-modification — very sensitive
  'meta.self-modify': 'ask',
  'meta.reload': 'ask',

  // File writes — acceptable by default
  'coder.file-write': 'auto',
  'coder.write': 'auto',

  // File reads — safe
  'coder.file-read': 'auto',
  'coder.read': 'auto',
  'coder.glob': 'auto',
  'coder.grep': 'auto',

  // Browser — generally safe
  'browser.navigate': 'auto',
  'browser.screenshot': 'auto',
  'browser.snapshot': 'auto',
  'browser.interact': 'auto',
  'browser.click': 'auto',

  // Network — safe reads
  'web.search': 'auto',
  'web.fetch': 'auto',

  // Agent spawning — delegated tasks, auto
  'agent.spawn': 'auto',
};

// ---------------------------------------------------------------------------
// PermissionManager
// ---------------------------------------------------------------------------

/**
 * Singleton manager for tool permission modes.
 *
 * Provides O(1) lookup with prefix fallback and runtime override support.
 */
export class PermissionManager {
  private static _instance: PermissionManager | null = null;

  /** Runtime overrides applied on top of defaults. */
  private readonly overrides = new Map<string, ToolPermission>();

  private constructor() {
    log.debug({ defaultCount: Object.keys(DEFAULT_PERMISSIONS).length }, 'PermissionManager initialized');
  }

  /** Return the singleton instance (creates it on first call). */
  static getInstance(): PermissionManager {
    if (!PermissionManager._instance) {
      PermissionManager._instance = new PermissionManager();
    }
    return PermissionManager._instance;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Resolve the permission mode for a tool.
   *
   * Lookup order:
   *  1. Runtime overrides (exact match)
   *  2. Default table (exact match)
   *  3. Runtime overrides (prefix match, longest wins)
   *  4. Default table (prefix match, longest wins)
   *  5. Fallback: 'auto'
   *
   * @param toolName - Fully-qualified tool name, e.g. "system.exec".
   * @returns Resolved PermissionMode.
   */
  check(toolName: string): PermissionMode {
    if (!toolName || typeof toolName !== 'string') {
      log.warn({ toolName }, 'PermissionManager.check: invalid toolName — defaulting to ask');
      return 'ask';
    }

    // 1. Exact match in runtime overrides.
    const runtimeExact = this.overrides.get(toolName);
    if (runtimeExact) {
      log.debug({ toolName, mode: runtimeExact.mode, source: 'runtime-override' }, 'Permission resolved');
      return runtimeExact.mode;
    }

    // 2. Exact match in defaults.
    const defaultExact = DEFAULT_PERMISSIONS[toolName];
    if (defaultExact !== undefined) {
      log.debug({ toolName, mode: defaultExact, source: 'default-exact' }, 'Permission resolved');
      return defaultExact;
    }

    // 3. Prefix match in runtime overrides (longest matching prefix wins).
    let bestOverride: ToolPermission | undefined;
    let bestLen = 0;
    for (const [key, perm] of this.overrides.entries()) {
      if (toolName.startsWith(key) && key.length > bestLen) {
        bestOverride = perm;
        bestLen = key.length;
      }
    }
    if (bestOverride) {
      log.debug({ toolName, mode: bestOverride.mode, source: 'runtime-prefix' }, 'Permission resolved');
      return bestOverride.mode;
    }

    // 4. Prefix match in defaults (longest matching key wins).
    let bestDefault: PermissionMode | undefined;
    bestLen = 0;
    for (const [key, mode] of Object.entries(DEFAULT_PERMISSIONS)) {
      const prefix = key.endsWith('*') ? key.slice(0, -1) : key;
      if (toolName.startsWith(prefix) && prefix.length > bestLen) {
        bestDefault = mode;
        bestLen = prefix.length;
      }
    }
    if (bestDefault !== undefined) {
      log.debug({ toolName, mode: bestDefault, source: 'default-prefix' }, 'Permission resolved');
      return bestDefault;
    }

    // 5. Unknown tool — auto by default (least friction).
    log.debug({ toolName, mode: 'auto', source: 'fallback' }, 'Permission resolved');
    return 'auto';
  }

  /**
   * Set a runtime permission override for a specific tool.
   *
   * This persists only for the lifetime of the process. Use to temporarily
   * lock down or unlock a tool without modifying the defaults table.
   *
   * @param toolName - Exact tool name or prefix (e.g. "system." to cover all system tools).
   * @param mode     - New permission mode.
   * @param reason   - Optional human-readable justification.
   */
  override(toolName: string, mode: PermissionMode, reason?: string): void {
    if (!toolName || typeof toolName !== 'string') {
      log.warn({ toolName }, 'PermissionManager.override: invalid toolName — ignoring');
      return;
    }
    if (!['auto', 'ask', 'deny'].includes(mode)) {
      log.warn({ toolName, mode }, 'PermissionManager.override: invalid mode — ignoring');
      return;
    }

    this.overrides.set(toolName, { toolName, mode, reason });
    log.info({ toolName, mode, reason }, 'Permission override applied');
  }

  /**
   * Remove a runtime override, restoring the default table entry.
   *
   * @param toolName - Tool name to reset.
   */
  reset(toolName: string): void {
    if (this.overrides.delete(toolName)) {
      log.info({ toolName }, 'Permission override removed');
    }
  }

  /** Clear all runtime overrides, fully restoring defaults. */
  resetAll(): void {
    const count = this.overrides.size;
    this.overrides.clear();
    log.info({ count }, 'All permission overrides cleared');
  }

  /**
   * Return all currently active overrides (for admin/debug inspection).
   */
  listOverrides(): ToolPermission[] {
    return [...this.overrides.values()];
  }
}
