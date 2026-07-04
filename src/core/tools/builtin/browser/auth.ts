/**
 * @file auth.ts
 * @description browser.auth — handle browser-based authentication:
 * login (fill credentials and submit), check-session (detect logged-in state),
 * save-cookies (persist session cookies to profile).
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import { resolveActivePage } from './active-page.js';
import { requiresConfirmationDefault } from './autonomy.js';

export const authTool: ToolDefinition = {
  name: 'browser.auth',
  description:
    'Browser authentication helper. Operations: login (fill and submit credentials), ' +
    'check-session (returns true if user appears logged in), save-cookies (persist session ' +
    'to a JSON file in the browser profile directory).',
  category: 'browser',
  timeout: 60_000,
  // Confirm unless unattended mode (SUDO_BROWSER_UNATTENDED=1) is enabled, in
  // which case runtime guardrails (ConfidenceGate / StuckDetector) apply instead.
  requiresConfirmation: requiresConfirmationDefault(),
  parameters: {
    operation: {
      type: 'string',
      required: true,
      enum: ['login', 'check-session', 'save-cookies', 'load-cookies'],
      description: 'Auth operation to perform.',
    },
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance (default: "default").',
    },
    site: {
      type: 'string',
      required: false,
      description: 'Site identifier used to name the cookie file (e.g. "youtube").',
    },
    credentials: {
      type: 'object',
      required: false,
      description: 'Login credentials object with "username", "password", and selector fields.',
      properties: {
        usernameSelector: { type: 'string', description: 'CSS selector for username field.' },
        passwordSelector: { type: 'string', description: 'CSS selector for password field.' },
        submitSelector: { type: 'string', description: 'CSS selector for submit button.' },
        username: { type: 'string', description: 'Username or email.' },
        password: { type: 'string', description: 'Password.' },
      },
    },
    sessionIndicatorSelector: {
      type: 'string',
      required: false,
      description: 'CSS selector present only when logged in (for check-session).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const op = params['operation'];
    if (typeof op !== 'string' || !['login', 'check-session', 'save-cookies', 'load-cookies'].includes(op)) {
      return { success: false, output: 'browser.auth: invalid operation.' };
    }

    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const site = typeof params['site'] === 'string' ? params['site'] : 'default';

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);

    const page = await resolveActivePage(instance);
    const cookiePath = resolve(instance.profileDir, `${site}-cookies.json`);

    try {
      if (op === 'login') {
        const creds = params['credentials'];
        if (!creds || typeof creds !== 'object' || Array.isArray(creds)) {
          return { success: false, output: 'browser.auth: "credentials" object required for login.' };
        }
        const c = creds as Record<string, string>;
        if (!c['usernameSelector'] || !c['passwordSelector'] || !c['username'] || !c['password']) {
          return { success: false, output: 'browser.auth: credentials must have usernameSelector, passwordSelector, username, password.' };
        }
        await page.locator(c['usernameSelector']!).first().fill(c['username']!);
        await page.locator(c['passwordSelector']!).first().fill(c['password']!);
        if (c['submitSelector']) {
          await page.locator(c['submitSelector']).first().click();
          await page.waitForLoadState('domcontentloaded');
        }
        ctxLog.info({ tool: 'browser.auth', op, site }, 'Login submitted');
        return { success: true, output: 'Login form submitted.', data: { site } };
      }

      if (op === 'check-session') {
        const indicator = typeof params['sessionIndicatorSelector'] === 'string'
          ? params['sessionIndicatorSelector']
          : null;
        if (!indicator) {
          return { success: false, output: 'browser.auth: "sessionIndicatorSelector" required for check-session.' };
        }
        const count = await page.locator(indicator).count();
        const loggedIn = count > 0;
        ctxLog.info({ tool: 'browser.auth', op, site, loggedIn }, 'Session check');
        return {
          success: true,
          output: `Session check: ${loggedIn ? 'logged in' : 'not logged in'}.`,
          data: { loggedIn, site },
        };
      }

      if (op === 'save-cookies') {
        const cookies = await instance.context.cookies();
        writeFileSync(cookiePath, JSON.stringify(cookies, null, 2), 'utf-8');
        ctxLog.info({ tool: 'browser.auth', op, site, count: cookies.length }, 'Cookies saved');
        return {
          success: true,
          output: `Saved ${cookies.length} cookies to ${cookiePath}`,
          data: { path: cookiePath, count: cookies.length },
          artifacts: [{ path: cookiePath, action: 'created' }],
        };
      }

      // op === 'load-cookies'
      if (!existsSync(cookiePath)) {
        return { success: false, output: `browser.auth: cookie file not found at ${cookiePath}` };
      }
      const raw = readFileSync(cookiePath, 'utf-8');
      const cookies = JSON.parse(raw) as Parameters<typeof instance.context.addCookies>[0];
      await instance.context.addCookies(cookies);
      ctxLog.info({ tool: 'browser.auth', op, site, count: cookies.length }, 'Cookies loaded');
      return {
        success: true,
        output: `Loaded ${cookies.length} cookies from ${cookiePath}`,
        data: { path: cookiePath, count: cookies.length },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.auth', op, err }, 'Auth operation failed');
      return { success: false, output: `browser.auth error: ${msg}` };
    }
  },
};
