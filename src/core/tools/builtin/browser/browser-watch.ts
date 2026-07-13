/**
 * @file browser-watch.ts
 * @description browser.watch — the agent enables an owner-visible live view of
 * a running browser profile (Spec 3, step 4). Starts/stops a CDP screencast the
 * owner watches in /admin, and reports takeover state. This is the "agent starts
 * a task with watch:true" entry point; taking over / driving happens from /admin.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { screencastManager } from './screencast-manager.js';
import { BrowserManager } from './browser-manager.js';
import { getProfileEntry } from './profile-registry.js';
import { checkOwnerAllowed, browserAudit } from './safety.js';

const VALID = ['start', 'stop', 'status'] as const;

export const browserWatchTool: ToolDefinition = {
  name: 'browser.watch',
  description:
    'Give the owner a live view of a running browser profile so they can watch — and take over — ' +
    'from /admin. Operations: start (begin screencast), stop, status. Use before a sensitive task ' +
    '(logins, banking) so the owner can grab control. The owner views/controls at ' +
    '/v1/admin/browser (live screen + take-over).',
  category: 'browser',
  timeout: 15_000,
  parameters: {
    operation: { type: 'string', required: true, enum: [...VALID], description: 'start | stop | status' },
    profile: { type: 'string', required: false, description: 'Profile to watch (default: "default").' },
    fps: { type: 'number', required: false, description: 'Frames/sec 1..10 (default 3).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void };
    const op = params['operation'];
    if (typeof op !== 'string' || !(VALID as readonly string[]).includes(op)) {
      return { success: false, output: `browser.watch: operation must be one of ${VALID.join('|')}.` };
    }
    const profile = typeof params['profile'] === 'string' && params['profile'].trim() ? params['profile'].trim() : 'default';

    if (op === 'status') {
      const casts = screencastManager.list();
      return {
        success: true,
        output: casts.length
          ? `Watched profiles:\n${casts.map((c) => `  ${c.name} — ${c.viewers} viewer(s)${c.takeover ? ', OWNER IN CONTROL' : ''}`).join('\n')}`
          : 'No profiles are being watched.',
        data: { casts },
      };
    }

    if (op === 'stop') {
      const ok = await screencastManager.stop(profile);
      return { success: true, output: ok ? `Stopped watching "${profile}".` : `"${profile}" was not being watched.`, data: { profile, stopped: ok } };
    }

    // start
    const gate = checkOwnerAllowed(getProfileEntry(profile), ctx.sessionId);
    if (!gate.allowed) {
      return { success: false, output: `browser.watch: ${gate.reason}.` };
    }
    if (!BrowserManager.getInstance().get(profile)) {
      return { success: false, output: `browser.watch: profile "${profile}" is not running — launch it first with browser.launch.` };
    }
    browserAudit('watch-start', { profile, sessionId: ctx.sessionId });
    try {
      await screencastManager.start(profile, { fps: typeof params['fps'] === 'number' ? params['fps'] : undefined });
      ctxLog.info({ tool: 'browser.watch', profile }, 'watch started');
      return {
        success: true,
        output: `Watching "${profile}" — owner can view the live screen and take over at /admin (browser panel).`,
        data: { profile, watching: true, adminPath: '/v1/admin/dashboard' },
      };
    } catch (err) {
      return { success: false, output: `browser.watch: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
