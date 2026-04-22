/**
 * @file profiles.ts
 * @description browser.profiles — manage persistent browser profile directories
 * at data/browser-profiles/. Operations: create, list, delete.
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

const PROFILES_ROOT = 'data/browser-profiles';

function ensureProfilesRoot(root: string): void {
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
}

function listProfiles(root: string): Array<{ name: string; path: string; createdAt: string }> {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => statSync(join(root, entry)).isDirectory())
    .map((name) => ({
      name,
      path: join(root, name),
      createdAt: statSync(join(root, name)).birthtime.toISOString(),
    }));
}

export const profilesTool: ToolDefinition = {
  name: 'browser.profiles',
  description:
    'Manage browser profile directories at data/browser-profiles/. ' +
    'Operations: create (make a new profile dir), list (show all profiles), ' +
    'delete (remove a profile and close any active browser using it).',
  category: 'browser',
  timeout: 10_000,
  parameters: {
    operation: {
      type: 'string',
      required: true,
      enum: ['create', 'list', 'delete'],
      description: 'Profile operation to perform.',
    },
    name: {
      type: 'string',
      required: false,
      description: 'Profile name (required for create/delete).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const op = params['operation'];
    if (typeof op !== 'string' || !['create', 'list', 'delete'].includes(op)) {
      return { success: false, output: 'browser.profiles: "operation" must be create|list|delete.' };
    }

    const profilesRoot = resolve(ctx.workingDir, PROFILES_ROOT);
    ensureProfilesRoot(profilesRoot);

    try {
      if (op === 'list') {
        const profiles = listProfiles(profilesRoot);
        ctxLog.info({ tool: 'browser.profiles', op, count: profiles.length }, 'Profiles listed');
        return {
          success: true,
          output: `Browser profiles (${profiles.length}):\n` +
            (profiles.length === 0
              ? '  (none)'
              : profiles.map((p) => `  ${p.name} — ${p.path} (created: ${p.createdAt})`).join('\n')),
          data: { profiles },
        };
      }

      const name = params['name'];
      if (typeof name !== 'string' || name.trim() === '') {
        return { success: false, output: `browser.profiles: "name" required for ${op}.` };
      }

      // Sanitise profile name — no path traversal
      if (/[/\\.]/.test(name)) {
        return { success: false, output: 'browser.profiles: profile name must not contain /, \\, or .' };
      }

      const profilePath = join(profilesRoot, name);

      if (op === 'create') {
        if (existsSync(profilePath)) {
          return {
            success: false,
            output: `browser.profiles: profile "${name}" already exists at ${profilePath}.`,
          };
        }
        mkdirSync(profilePath, { recursive: true });
        ctxLog.info({ tool: 'browser.profiles', op, name, profilePath }, 'Profile created');
        return {
          success: true,
          output: `Profile "${name}" created at ${profilePath}.`,
          data: { name, path: profilePath },
          artifacts: [{ path: profilePath, action: 'created' }],
        };
      }

      // op === 'delete'
      if (!existsSync(profilePath)) {
        return { success: false, output: `browser.profiles: profile "${name}" not found.` };
      }

      // Close any active browser using this profile
      const manager = BrowserManager.getInstance();
      const instance = manager.get(name);
      if (instance) {
        await manager.close(name);
        ctxLog.info({ tool: 'browser.profiles', name }, 'Closed active browser before profile delete');
      }

      rmSync(profilePath, { recursive: true, force: true });
      ctxLog.info({ tool: 'browser.profiles', op, name, profilePath }, 'Profile deleted');
      return {
        success: true,
        output: `Profile "${name}" deleted.`,
        data: { name, path: profilePath },
        artifacts: [{ path: profilePath, action: 'deleted' }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.profiles', op, err }, 'Profile operation failed');
      return { success: false, output: `browser.profiles error: ${msg}` };
    }
  },
};
