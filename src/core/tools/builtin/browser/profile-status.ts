/**
 * @file profile-status.ts
 * @description browser.profile-status — health + identity report for durable
 * browser profiles (Spec 3). For each registered profile (and any on-disk
 * userDataDir) reports: registered?, trust, ownerOnly, ephemeral, whether the
 * dir exists, a logged-in heuristic (a persistent Cookies DB exists / live
 * cookie count when running), last-used time, and whether an instance is live.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import {
  loadBrowserProfiles,
  getProfileEntry,
  isRegisteredProfile,
  profileDir as resolveProfileDir,
} from './profile-registry.js';

interface ProfileStatus {
  name: string;
  registered: boolean;
  trust: string;
  ownerOnly: boolean;
  ephemeral: boolean;
  dirExists: boolean;
  hasSession: boolean; // persistent Cookies DB present → likely has saved logins
  lastUsed: string | null;
  running: boolean;
  liveCookies?: number;
}

/** A persistent Chromium profile keeps cookies at <dir>/Default/Cookies (or ./Cookies). */
function hasCookieDb(dir: string): boolean {
  return existsSync(join(dir, 'Default', 'Cookies')) || existsSync(join(dir, 'Cookies'));
}

export const profileStatusTool: ToolDefinition = {
  name: 'browser.profile-status',
  description:
    'Report health + identity for durable browser profiles: registered?, trust, ownerOnly, ' +
    'ephemeral, whether logins are saved (persistent cookie store), last-used, and whether a ' +
    'browser is currently running on the profile. Pass `name` to report one profile, else all.',
  category: 'browser',
  timeout: 10_000,
  parameters: {
    name: {
      type: 'string',
      required: false,
      description: 'Profile name to report (omit for all registered + on-disk profiles).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void };
    const manager = BrowserManager.getInstance();
    const cfg = loadBrowserProfiles();

    const only = typeof params['name'] === 'string' && params['name'].trim() ? params['name'].trim() : null;
    const names = only
      ? [only]
      : Array.from(new Set(Object.keys(cfg.profiles).concat(manager.list().map((i) => i.name))));

    const statuses: ProfileStatus[] = [];
    for (const name of names) {
      const entry = getProfileEntry(name);
      const dir = resolveProfileDir(name);
      const dirExists = existsSync(dir);
      const running = Boolean(manager.get(name));
      let lastUsed: string | null = null;
      if (dirExists) { try { lastUsed = statSync(dir).mtime.toISOString(); } catch { /* ignore */ } }

      const status: ProfileStatus = {
        name,
        registered: isRegisteredProfile(name),
        trust: entry.trust,
        ownerOnly: entry.ownerOnly,
        ephemeral: entry.ephemeral,
        dirExists,
        hasSession: dirExists && hasCookieDb(dir),
        lastUsed,
        running,
      };

      if (running) {
        const inst = manager.get(name);
        try {
          const cookies = await inst!.context.cookies();
          status.liveCookies = cookies.length;
        } catch { /* CDP/headless quirks — omit */ }
      }
      statuses.push(status);
    }

    ctxLog.info({ tool: 'browser.profile-status', count: statuses.length }, 'Profile status reported');
    const lines = statuses.map((s) =>
      `  ${s.name}${s.registered ? '' : ' (unregistered)'} — trust=${s.trust}` +
      `${s.ownerOnly ? ', owner-only' : ''}${s.ephemeral ? ', ephemeral' : ', durable'}` +
      `, dir=${s.dirExists ? 'present' : 'none'}, session=${s.hasSession ? 'saved' : 'none'}` +
      `, running=${s.running}${s.liveCookies !== undefined ? ` (${s.liveCookies} cookies)` : ''}` +
      `${s.lastUsed ? `, lastUsed=${s.lastUsed}` : ''}`,
    );
    return {
      success: true,
      output: `Browser profiles (${statuses.length}):\n${lines.join('\n')}`,
      data: { profiles: statuses, defaultProfile: cfg.defaultProfile },
    };
  },
};
