/**
 * YoloModeManager — auto-approve all safe tool calls when yolo mode is enabled.
 *
 * Yolo mode (also known as "always approve") skips the human-in-the-loop
 * confirmation prompt for tool calls that match allowed patterns and are
 * not in the blocked list. Destructive operations (rm -rf, DROP, format,
 * etc.) are NEVER auto-approved, even when yolo mode is on.
 *
 * Activation sources (checked in order by resolve()):
 *   1. CLI flags  (--yolo, --always-approve)
 *   2. Environment (SUDO_YOLO=1, SUDO_ALWAYS_APPROVE=1)
 *   3. Config file (future: yolo: true in sudo-ai.json5)
 *   4. Default     (disabled)
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:yolo-mode');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Source that activated yolo mode, in priority order. */
export type YoloSource = 'cli' | 'env' | 'config' | 'default';

/** Options for resolve(). */
export interface ResolveOptions {
  /** True when --yolo or --always-approve was passed on the CLI. */
  cliFlag?: boolean;
}

// ---------------------------------------------------------------------------
// Default patterns
// ---------------------------------------------------------------------------

/**
 * Tool patterns that are ALWAYS blocked from auto-approval, even in yolo mode.
 * These represent irreversibly destructive operations.
 */
const DEFAULT_BLOCKED_PATTERNS: string[] = [
  'rm -rf',
  'rm -r',
  'format',
  'DROP',
  'DELETE FROM',
  'shutdown',
  'reboot',
];

/**
 * When yolo mode is enabled and no explicit allowed list has been set,
 * the wildcard '*' is used — meaning all tools are allowed unless blocked.
 */
const WILDCARD_PATTERN = '*';

// ---------------------------------------------------------------------------
// YoloModeManager
// ---------------------------------------------------------------------------

/**
 * Manages yolo (auto-approve) mode for tool call confirmations.
 *
 * When enabled, tool calls that match allowed patterns and do NOT match
 * blocked patterns are automatically approved without prompting the user.
 * Blocked patterns always take priority over allowed patterns.
 *
 * @example
 * ```ts
 * const yolo = new YoloModeManager();
 * yolo.resolve({ cliFlag: true }); // enable via CLI
 * if (yolo.shouldAutoApprove('readFile')) {
 *   // skip confirmation prompt
 * }
 * ```
 */
export class YoloModeManager {
  /** Whether yolo mode is currently active. */
  enabled: boolean = false;

  /** Source that activated yolo mode. */
  source: YoloSource = 'default';

  /** Tool name patterns that are allowed to auto-approve. */
  allowedToolPatterns: string[] = [];

  /** Tool name patterns that are NEVER auto-approved (takes priority over allowed). */
  blockedToolPatterns: string[] = [...DEFAULT_BLOCKED_PATTERNS];

  // -------------------------------------------------------------------------
  // Core methods
  // -------------------------------------------------------------------------

  /**
   * Resolve yolo mode state from CLI flags, environment variables, and config.
   * Checks sources in priority order: cli > env > config > default.
   *
   * @param opts - Options containing CLI flag state.
   */
  resolve(opts?: ResolveOptions): void {
    // Priority 1: CLI flag
    if (opts?.cliFlag) {
      this.enabled = true;
      this.source = 'cli';
      this.allowedToolPatterns = [WILDCARD_PATTERN];
      log.info('Yolo mode enabled via CLI flag');
      return;
    }

    // Priority 2: Environment variables
    if (process.env.SUDO_YOLO === '1' || process.env.SUDO_ALWAYS_APPROVE === '1') {
      this.enabled = true;
      this.source = 'env';
      this.allowedToolPatterns = [WILDCARD_PATTERN];
      log.info('Yolo mode enabled via environment variable');
      return;
    }

    // Priority 3: Config file (reserved for future use)
    // When config support is added, check here before falling through.

    // Default: disabled
    this.enabled = false;
    this.source = 'default';
    this.allowedToolPatterns = [];
    log.debug('Yolo mode not enabled (default)');
  }

  /**
   * Returns true if yolo mode is currently enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Determine whether a tool call should be auto-approved.
   *
   * A tool is auto-approved when:
   *   1. Yolo mode is enabled
   *   2. The tool name matches at least one allowed pattern
   *   3. The tool name does NOT match any blocked pattern
   *
   * Blocked patterns always take priority over allowed patterns.
   *
   * @param toolName - The name or command string of the tool to check.
   * @returns True if the tool should be auto-approved without confirmation.
   */
  shouldAutoApprove(toolName: string): boolean {
    if (!this.enabled) {
      return false;
    }

    // Check blocked patterns first — they take absolute priority
    if (this.matchesAnyPattern(toolName, this.blockedToolPatterns)) {
      log.warn(`Blocked tool in yolo mode: ${toolName}`);
      return false;
    }

    // Check allowed patterns
    if (this.matchesAnyPattern(toolName, this.allowedToolPatterns)) {
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Runtime mutation
  // -------------------------------------------------------------------------

  /**
   * Add an allowed tool pattern. When yolo mode is enabled, tools matching
   * this pattern will be auto-approved (unless blocked).
   *
   * @param pattern - Glob-style pattern string (e.g. 'read*', 'bash').
   */
  allowTool(pattern: string): void {
    if (!this.allowedToolPatterns.includes(pattern)) {
      this.allowedToolPatterns.push(pattern);
      log.info(`Allowed tool pattern added: ${pattern}`);
    }
  }

  /**
   * Add a blocked tool pattern. Blocked patterns take priority over allowed
   * patterns — a tool matching both will NOT be auto-approved.
   *
   * @param pattern - Glob-style pattern string (e.g. 'rm -rf', 'DROP*').
   */
  blockTool(pattern: string): void {
    if (!this.blockedToolPatterns.includes(pattern)) {
      this.blockedToolPatterns.push(pattern);
      log.info(`Blocked tool pattern added: ${pattern}`);
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Check if a tool name matches any pattern in the given list.
   * Supports wildcard '*' (matches everything) and substring contains matching.
   *
   * @param toolName - The tool name to check.
   * @param patterns - Array of patterns to match against.
   * @returns True if the tool name matches at least one pattern.
   */
  private matchesAnyPattern(toolName: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (pattern === WILDCARD_PATTERN) {
        return true;
      }
      // Case-insensitive substring/contains match
      if (toolName.toLowerCase().includes(pattern.toLowerCase())) {
        return true;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Singleton instance and global helpers
// ---------------------------------------------------------------------------

/** Global singleton YoloModeManager instance. */
const globalYolo = new YoloModeManager();

/**
 * Returns true if yolo mode is enabled on the global singleton.
 *
 * @example
 * ```ts
 * if (isYoloMode()) {
 *   // skip confirmation UI
 * }
 * ```
 */
export function isYoloMode(): boolean {
  return globalYolo.isEnabled();
}

/**
 * Convenience wrapper — check whether a tool should be auto-approved
 * using the global singleton YoloModeManager.
 *
 * @param toolName - The tool name or command string to check.
 * @returns True if the tool should be auto-approved.
 *
 * @example
 * ```ts
 * if (shouldAutoApprove('readFile')) {
 *   // execute without prompting
 * } else {
 *   // show confirmation dialog
 * }
 * ```
 */
export function shouldAutoApprove(toolName: string): boolean {
  return globalYolo.shouldAutoApprove(toolName);
}

/**
 * Get a reference to the global YoloModeManager singleton.
 * Useful for calling resolve() at startup or mutating patterns at runtime.
 */
export function getGlobalYoloManager(): YoloModeManager {
  return globalYolo;
}