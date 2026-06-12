/**
 * @file user-hooks.ts
 * @description File-based user hooks: script lifecycle events without writing
 * a plugin.
 *
 * Reads a JSON hooks file (default `DATA_DIR/hooks.json`) and registers each
 * declared hook on the running HookManager via the same bridge plugins use
 * (plugin-hooks.ts), so command/http execution semantics are identical to
 * manifest-declared plugin hooks: command hooks receive the HookContext as
 * JSON on stdin plus SUDO_HOOK_EVENT / SUDO_HOOK_TOOL env vars; http hooks
 * POST the context as JSON.
 *
 * File shape (a bare array is also accepted):
 * ```json
 * {
 *   "hooks": [
 *     { "event": "session:start", "type": "command", "command": "notify-send 'session started'" },
 *     { "event": "after:tool-call", "type": "http", "url": "http://127.0.0.1:9000/hook" }
 *   ]
 * }
 * ```
 *
 * `function`-type hooks are rejected here — they need a plugin module to
 * resolve the named export, which a standalone file cannot provide.
 *
 * Security: command hooks execute arbitrary shell with the host process env.
 * The file lives in the user's own DATA_DIR and loading is opt-in
 * (SUDO_USER_HOOKS=1), same trust model as Claude Code settings hooks.
 */

import { readFileSync } from 'fs';
import { registerPluginHooks, unregisterPluginHooks, hasPluginHooks } from '../plugins/plugin-hooks.js';
import type { PluginManifest, PluginHookDecl } from '../plugins/plugin-manifest.js';
import type { HookManager } from './index.js';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';

const log = createLogger('hooks:user');

/** Synthetic plugin ID the bridge tracks user-file hooks under. */
export const USER_HOOKS_ID = 'user-hooks-file';

export interface UserHooksLoadResult {
  /** Hooks registered on the HookManager. */
  registered: number;
  /** Entries with `enabled: false`. */
  skipped: number;
  /** Validation/parse problems, human-readable. Invalid entries are skipped; valid ones still register. */
  errors: string[];
}

function syntheticManifest(hooks: PluginHookDecl[]): PluginManifest {
  return {
    id: USER_HOOKS_ID,
    name: 'User hooks file',
    version: '1.0.0',
    description: 'Hooks loaded from the user hooks JSON file',
    author: 'user',
    category: 'productivity',
    hooks,
    skills: [],
    mcpServers: [],
    lspServers: [],
    source: { type: 'local' },
  };
}

function validateEntry(entry: unknown, index: number, errors: string[]): PluginHookDecl | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errors.push(`hooks[${index}] must be an object`);
    return null;
  }
  const obj = entry as Record<string, unknown>;

  if (typeof obj['event'] !== 'string' || obj['event'].trim() === '') {
    errors.push(`hooks[${index}].event must be a non-empty string`);
    return null;
  }

  const type = obj['type'];
  if (type === 'function') {
    errors.push(`hooks[${index}]: function hooks need a plugin module — use the plugin SDK instead`);
    return null;
  }
  if (type !== 'command' && type !== 'http') {
    errors.push(`hooks[${index}].type must be 'command' or 'http'`);
    return null;
  }

  if (type === 'command' && (typeof obj['command'] !== 'string' || obj['command'].trim() === '')) {
    errors.push(`hooks[${index}].command is required for command hooks`);
    return null;
  }
  if (type === 'http') {
    const url = obj['url'];
    if (typeof url !== 'string') {
      errors.push(`hooks[${index}].url is required for http hooks`);
      return null;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push(`hooks[${index}].url must be http(s), got '${parsed.protocol.slice(0, 16)}'`);
        return null;
      }
    } catch {
      errors.push(`hooks[${index}].url is not a valid URL`);
      return null;
    }
  }

  if (obj['timeout'] !== undefined && (typeof obj['timeout'] !== 'number' || !(obj['timeout'] > 0))) {
    errors.push(`hooks[${index}].timeout must be a positive number`);
    return null;
  }

  return {
    event: obj['event'],
    type,
    ...(typeof obj['command'] === 'string' ? { command: obj['command'] } : {}),
    ...(typeof obj['url'] === 'string' ? { url: obj['url'] } : {}),
    ...(typeof obj['timeout'] === 'number' ? { timeout: obj['timeout'] } : {}),
    ...(typeof obj['enabled'] === 'boolean' ? { enabled: obj['enabled'] } : {}),
  };
}

/**
 * Load the user hooks file and register its hooks on the HookManager.
 *
 * Idempotent: a previous load's registrations are removed first, so calling
 * again re-reads the file rather than accumulating duplicates (the bridge's
 * tracking map is a module-level singleton keyed by plugin ID). Invariant:
 * always pass the SAME HookManager instance across calls — the singleton
 * tracks hook IDs, not managers, so unregistering against a different
 * manager would leave stale hooks firing on the old one.
 *
 * A missing file is not an error — it means zero hooks. Event names are
 * passed through unvalidated (the bridge fails open on unknown events) so
 * the file can target any current or future HookEvent.
 *
 * Uses synchronous file I/O — suitable for the boot path, not hot loops.
 */
export function loadUserHooks(manager: HookManager, filePath?: string): UserHooksLoadResult {
  const path = filePath ?? dataPath('hooks.json');
  const errors: string[] = [];

  if (hasPluginHooks(USER_HOOKS_ID)) {
    unregisterPluginHooks(syntheticManifest([]), manager);
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    log.debug({ path }, 'No user hooks file — nothing to register');
    return { registered: 0, skipped: 0, errors };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    errors.push(`hooks file is not valid JSON: ${String(err)}`);
    log.warn({ path, err: String(err) }, 'User hooks file unparseable — no hooks registered');
    return { registered: 0, skipped: 0, errors };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>)['hooks'])
        ? (parsed as Record<string, unknown>)['hooks'] as unknown[]
        : null);
  if (list === null) {
    errors.push("hooks file must be an array or an object with a 'hooks' array");
    log.warn({ path }, 'User hooks file has wrong shape — no hooks registered');
    return { registered: 0, skipped: 0, errors };
  }

  const decls: PluginHookDecl[] = [];
  let skipped = 0;
  for (let i = 0; i < list.length; i++) {
    const decl = validateEntry(list[i], i, errors);
    if (!decl) continue;
    if (decl.enabled === false) {
      skipped++;
      continue;
    }
    decls.push(decl);
  }

  const registered = registerPluginHooks(syntheticManifest(decls), manager);
  if (errors.length > 0) {
    log.warn({ path, errors }, 'Some user hook entries were invalid and skipped');
  }
  log.info({ path, registered, skipped, invalid: errors.length }, 'User hooks loaded');
  return { registered, skipped, errors };
}

/** Remove all user-file hooks from the HookManager. Returns how many were removed. */
export function unloadUserHooks(manager: HookManager): number {
  return unregisterPluginHooks(syntheticManifest([]), manager);
}
