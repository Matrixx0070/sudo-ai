/**
 * @file browser-login.ts
 * @description browser.login — login bootstrap (Spec 3, step 3). The agent opens
 * a site's login page in a DURABLE profile and starts watch; the OWNER then takes
 * over from /admin to type the password + complete 2FA. Because the profile is a
 * persistent context, the resulting session cookies are saved automatically —
 * next launch of the same profile is already logged in. No credential ever
 * passes through the agent or the model.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import { screencastManager } from './screencast-manager.js';
import { resolveActivePage } from './active-page.js';
import { getProfileEntry } from './profile-registry.js';
import { checkOwnerAllowed, browserAudit, domainAllowed } from './safety.js';

export const browserLoginTool: ToolDefinition = {
  name: 'browser.login',
  description:
    'Bootstrap a saved login for a durable profile: open a site\'s login page and start a live view so ' +
    'the OWNER can take over (from /admin) to enter the password + 2FA. The session is saved to the ' +
    'persistent profile automatically — future launches are already logged in. No credential touches the agent.',
  category: 'browser',
  timeout: 45_000,
  parameters: {
    profile: { type: 'string', required: true, description: 'Durable profile to log into (e.g. personal, work).' },
    url: { type: 'string', required: true, description: 'Login page URL (e.g. https://accounts.google.com).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const profile = typeof params['profile'] === 'string' ? params['profile'].trim() : '';
    const url = typeof params['url'] === 'string' ? params['url'].trim() : '';
    if (!profile || !url) return { success: false, output: 'browser.login: profile and url are required.' };
    if (!/^https?:\/\//i.test(url)) return { success: false, output: 'browser.login: url must be http(s).' };

    const entry = getProfileEntry(profile);
    const gate = checkOwnerAllowed(entry, ctx.sessionId);
    if (!gate.allowed) return { success: false, output: `browser.login: ${gate.reason}.` };
    if (!domainAllowed(entry, url)) {
      return { success: false, output: `browser.login: ${url} is not in profile "${profile}"'s domain allowlist.` };
    }

    try {
      const manager = BrowserManager.getInstance();
      // Gated path (owner check passed above) → authorized to open owner-only.
      const instance = await manager.launch(profile, true, false, true); // durable persistent context
      const page = await resolveActivePage(instance);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => { /* partial load ok — owner drives */ });
      await screencastManager.start(profile, { fps: 3 });
      browserAudit('login-bootstrap', { profile, url, sessionId: ctx.sessionId });

      return {
        success: true,
        output:
          `Opened ${url} in durable profile "${profile}" and started a live view.\n` +
          `Owner: go to /admin → "Browser (watch / take over)" → View live → Take over, then enter the ` +
          `password + 2FA and finish signing in. Hand back when done — the login is saved to the profile ` +
          `automatically, so future "${profile}" launches are already authenticated.`,
        data: { profile, url, watching: true, adminPath: '/v1/admin/dashboard' },
      };
    } catch (err) {
      return { success: false, output: `browser.login: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
