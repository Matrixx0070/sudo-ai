/**
 * PermissionModeManager — controls what actions require user confirmation.
 *
 * Inspired by Claude Code's permission model, this module defines four modes
 * that trade off autonomy vs. safety:
 *
 *   default      — Ask for every action (maximum safety).
 *   acceptEdits  — Auto-accept file edits, ask before running commands.
 *   autoAccept   — Auto-accept edits + commands, ask before destructive ops.
 *   bypass       — No prompts at all.  Requires explicit confirmation at mode
 *                  entry to prevent accidental activation.
 *
 * Mode state is persisted to a local JSON file so it survives process restarts.
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { ConfigError } from '../shared/errors.js';
import { DATA_DIR } from '../shared/paths.js';

const log = createLogger('config:permissions');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The four permission modes. */
export type PermissionModeType = 'default' | 'acceptEdits' | 'autoAccept' | 'bypass';

/** Categories of actions that may require confirmation. */
export type ActionCategory =
  | 'file_edit'      // Writing / modifying files
  | 'file_read'      // Reading files (normally safe, included for completeness)
  | 'command_run'    // Executing shell / system commands
  | 'command_destructive' // Commands that delete data, format disks, etc.
  | 'network_request'    // Outbound HTTP / network calls
  | 'tool_call'          // Invoking a named tool
  | 'agent_spawn'        // Spawning a sub-agent / swarm member
  | 'config_change';     // Modifying settings or config files

/** Configuration for a single permission mode. */
export interface PermissionModeConfig {
  /** Human-readable label. */
  label: string;
  /** Short description shown in prompts / UI. */
  description: string;
  /** Set of action categories that require explicit user confirmation. */
  requiresPrompt: ReadonlySet<ActionCategory>;
}

// ---------------------------------------------------------------------------
// Mode definitions
// ---------------------------------------------------------------------------

const MODE_ORDER: readonly PermissionModeType[] = [
  'default',
  'acceptEdits',
  'autoAccept',
  'bypass',
] as const;

const MODE_CONFIGS: Readonly<Record<PermissionModeType, PermissionModeConfig>> = {
  default: {
    label: 'Default',
    description: 'Ask for every action — maximum safety, minimum autonomy.',
    requiresPrompt: new Set<ActionCategory>([
      'file_edit',
      'command_run',
      'command_destructive',
      'network_request',
      'tool_call',
      'agent_spawn',
      'config_change',
    ]),
  },
  acceptEdits: {
    label: 'Accept Edits',
    description: 'Auto-accept file edits; ask before running commands or other actions.',
    requiresPrompt: new Set<ActionCategory>([
      'command_run',
      'command_destructive',
      'network_request',
      'tool_call',
      'agent_spawn',
      'config_change',
    ]),
  },
  autoAccept: {
    label: 'Auto Accept',
    description: 'Auto-accept edits and commands; ask before destructive operations.',
    requiresPrompt: new Set<ActionCategory>([
      'command_destructive',
      'agent_spawn',
      'config_change',
    ]),
  },
  bypass: {
    label: 'Bypass',
    description: 'No prompts — full autonomy.  Destructive operations run without confirmation.',
    requiresPrompt: new Set<ActionCategory>(),
  },
};

// ---------------------------------------------------------------------------
// Persistence path
// ---------------------------------------------------------------------------

const DEFAULT_PERSIST_DIR = path.join(DATA_DIR, 'config');
const PERSIST_FILENAME = 'permission-mode.json';

interface PersistedMode {
  mode: PermissionModeType;
  confirmedAt?: string; // ISO timestamp of when bypass was confirmed
}

// ---------------------------------------------------------------------------
// PermissionModeManager
// ---------------------------------------------------------------------------

export class PermissionModeManager {
  private currentMode: PermissionModeType = 'default';
  private readonly persistPath: string;
  private bypassConfirmed = false;

  /**
   * @param persistDir - Directory for the persisted mode file.
   *                     Defaults to `data/config`.
   */
  constructor(persistDir?: string) {
    this.persistPath = path.resolve(persistDir ?? DEFAULT_PERSIST_DIR, PERSIST_FILENAME);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Get the current permission mode.
   */
  getMode(): PermissionModeType {
    return this.currentMode;
  }

  /**
   * Set the permission mode.
   *
   * When switching to `bypass`, you must pass `confirmBypass: true` to
   * acknowledge the safety implications.  Otherwise the call throws.
   *
   * @param mode   - Target mode.
   * @param confirmBypass - Required and must be `true` when mode is `bypass`.
   * @throws ConfigError if bypass is requested without confirmation.
   */
  setMode(mode: PermissionModeType, confirmBypass = false): void {
    if (mode === 'bypass' && !confirmBypass) {
      throw new ConfigError(
        'Switching to bypass mode requires explicit confirmation (confirmBypass: true). ' +
        'Bypass mode disables ALL safety prompts, including destructive operations.',
        'config_bypass_unconfirmed',
      );
    }

    const prev = this.currentMode;
    this.currentMode = mode;
    this.bypassConfirmed = mode === 'bypass' && confirmBypass;

    log.info({ from: prev, to: mode }, 'Permission mode changed');

    this.persistMode();
  }

  /**
   * Cycle to the next mode in order: default → acceptEdits → autoAccept → bypass → default.
   *
   * When cycling into `bypass`, `confirmBypass` must be `true`.
   *
   * @param confirmBypass - Required when the next mode is `bypass`.
   * @returns The new mode after cycling.
   */
  cycleMode(confirmBypass = false): PermissionModeType {
    const idx = MODE_ORDER.indexOf(this.currentMode);
    const nextIdx = (idx + 1) % MODE_ORDER.length;
    const next = MODE_ORDER[nextIdx];
    this.setMode(next, confirmBypass);
    return this.currentMode;
  }

  /**
   * Check whether a given action category is allowed without prompting
   * under the current permission mode.
   *
   * @param action - The action category to check.
   * @returns `true` if the action is auto-allowed; `false` if user confirmation is required.
   */
  isActionAllowed(action: ActionCategory): boolean {
    return !MODE_CONFIGS[this.currentMode].requiresPrompt.has(action);
  }

  /**
   * Return the full configuration object for the current mode.
   */
  getModeConfig(): PermissionModeConfig {
    return MODE_CONFIGS[this.currentMode];
  }

  /**
   * Return a human-readable description of the current mode.
   */
  getModeDescription(): string {
    const cfg = MODE_CONFIGS[this.currentMode];
    return `[${cfg.label}] ${cfg.description}`;
  }

  /**
   * Return the ordered list of all available modes.
   */
  getAllModes(): readonly PermissionModeType[] {
    return MODE_ORDER;
  }

  /**
   * Return the config for any mode (not just the current one).
   */
  getModeConfigFor(mode: PermissionModeType): PermissionModeConfig {
    return MODE_CONFIGS[mode];
  }

  /**
   * Check whether bypass mode has been explicitly confirmed this session.
   */
  isBypassConfirmed(): boolean {
    return this.bypassConfirmed;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Persist the current mode to disk so it survives process restarts.
   */
  persistMode(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const payload: PersistedMode = {
        mode: this.currentMode,
        confirmedAt: this.bypassConfirmed ? new Date().toISOString() : undefined,
      };

      fs.writeFileSync(this.persistPath, JSON.stringify(payload, null, 2), 'utf8');
      log.debug({ path: this.persistPath, mode: this.currentMode }, 'Permission mode persisted');
    } catch (err) {
      // Non-fatal: persistence is best-effort.
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message, path: this.persistPath }, 'Failed to persist permission mode');
    }
  }

  /**
   * Load the persisted mode from disk.
   *
   * If the file is missing, corrupt, or contains an invalid mode, falls back
   * to `default` and logs a warning.
   *
   * When the persisted mode is `bypass`, this method does NOT auto-confirm it.
   * The caller must explicitly call `setMode('bypass', true)` to activate bypass.
   * A persisted bypass mode is downgraded to `autoAccept` on load.
   */
  loadMode(): void {
    try {
      if (!fs.existsSync(this.persistPath)) {
        log.debug({ path: this.persistPath }, 'No persisted permission mode found — using default');
        this.currentMode = 'default';
        this.bypassConfirmed = false;
        return;
      }

      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'mode' in parsed &&
        typeof (parsed as PersistedMode).mode === 'string'
      ) {
        const candidate = (parsed as PersistedMode).mode;

        if (isValidMode(candidate)) {
          // Safety: never auto-restore bypass; downgrade to autoAccept.
          if (candidate === 'bypass') {
            log.warn('Persisted mode is "bypass" — downgrading to "autoAccept" on load for safety');
            this.currentMode = 'autoAccept';
          } else {
            this.currentMode = candidate;
          }

          this.bypassConfirmed = false;
          log.info({ mode: this.currentMode }, 'Permission mode loaded from disk');
        } else {
          log.warn({ candidate }, 'Invalid persisted mode — falling back to default');
          this.currentMode = 'default';
          this.bypassConfirmed = false;
        }
      } else {
        log.warn({ raw }, 'Corrupt persisted mode file — falling back to default');
        this.currentMode = 'default';
        this.bypassConfirmed = false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message }, 'Error loading persisted permission mode — using default');
      this.currentMode = 'default';
      this.bypassConfirmed = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidMode(value: string): value is PermissionModeType {
  return MODE_ORDER.includes(value as PermissionModeType);
}