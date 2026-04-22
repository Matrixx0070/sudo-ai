/**
 * @file browser-manager.ts
 * @description BrowserManager singleton — launches and tracks Playwright
 * Chromium instances with persistent profiles stored at
 * data/browser-profiles/{name}/. Also supports connecting to an existing
 * Chrome browser via CDP (Chrome DevTools Protocol) endpoint.
 *
 * Also exports a ToolDefinition for browser.launch so the manager is
 * accessible from the tool registry.
 */

import { chromium, type BrowserContext, type Browser } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import {
  ANTI_DETECT_ARGS,
  detectChromiumVersion,
  buildUserAgent,
  buildClientHintsHeaders,
} from './anti-detect.js';

const log = createLogger('browser-manager');

// ---------------------------------------------------------------------------
// Module-level Chromium version cache — detected once at startup
// ---------------------------------------------------------------------------

let _cachedChromiumVersion: string | null = null;
let _versionDetected = false;

async function getCachedChromiumVersion(): Promise<string | null> {
  if (_versionDetected) return _cachedChromiumVersion;
  _cachedChromiumVersion = await detectChromiumVersion();
  _versionDetected = true;
  log.info({ version: _cachedChromiumVersion }, 'Chromium version cached');
  return _cachedChromiumVersion;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserInstance {
  name: string;
  profileDir: string;
  context: BrowserContext;
  browser: Browser;
  launchedAt: Date;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/**
 * BrowserManager manages named Playwright browser instances.
 * Each instance uses a persistent context backed by a profile directory.
 */
export class BrowserManager {
  private static _instance: BrowserManager | null = null;
  private readonly instances = new Map<string, BrowserInstance>();
  private readonly profilesRoot: string;

  private constructor(profilesRoot = 'data/browser-profiles') {
    this.profilesRoot = resolve(profilesRoot);
    if (!existsSync(this.profilesRoot)) {
      mkdirSync(this.profilesRoot, { recursive: true });
    }
  }

  static getInstance(): BrowserManager {
    if (!BrowserManager._instance) {
      BrowserManager._instance = new BrowserManager();
    }
    return BrowserManager._instance;
  }

  /**
   * Get or auto-connect the "default" browser instance.
   * Priority: 1) cached instance, 2) CDP on localhost:9222, 3) headless launch.
   * This ensures ALL tools automatically use Frank's already-open Chrome.
   */
  async getOrConnect(name = 'default'): Promise<BrowserInstance> {
    const cached = this.instances.get(name);
    if (cached) return cached;

    // Try CDP first — Frank's Chrome on port 9222
    const cdpEndpoint = 'http://localhost:9222';
    try {
      const browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 2000 });
      const contexts = browser.contexts();
      const context: BrowserContext =
        contexts.length > 0 ? contexts[0]! : await browser.newContext({ ignoreHTTPSErrors: true });

      context.on('dialog', async (dialog) => {
        log.info({ type: dialog.type(), message: dialog.message() }, 'Auto-dismissing CDP dialog');
        await dialog.dismiss().catch(() => {});
      });

      const instance: BrowserInstance = {
        name,
        profileDir: `(cdp:${cdpEndpoint})`,
        context,
        browser,
        launchedAt: new Date(),
      };
      this.instances.set(name, instance);
      log.info({ name, cdpEndpoint }, 'Auto-connected to CDP browser');
      return instance;
    } catch {
      log.info({ name }, 'CDP not available — launching headless browser');
    }

    // Fallback: launch headless
    return this.launch(name, true);
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  /**
   * Launch (or return cached) a named browser context backed by a persistent
   * profile directory at data/browser-profiles/{name}/.
   */
  async launch(name: string, headless = true): Promise<BrowserInstance> {
    const existing = this.instances.get(name);
    if (existing) {
      log.info({ name }, 'Returning cached browser instance');
      return existing;
    }

    const profileDir = resolve(this.profilesRoot, name);
    if (!existsSync(profileDir)) {
      mkdirSync(profileDir, { recursive: true });
    }

    log.info({ name, profileDir, headless }, 'Launching browser');

    // Detect Chromium version once for UA/CH-header accuracy
    const chromiumVersion = await getCachedChromiumVersion();

    const browser = await chromium.launch({
      headless,
      args: [
        '--ignore-certificate-errors',
        '--ignore-ssl-errors',
        '--disable-web-security',
        '--allow-running-insecure-content',
        '--no-sandbox',
        '--disable-features=IsolateOrigins,site-per-process',
        // Anti-detection flags — hide navigator.webdriver and other automation signals
        ...ANTI_DETECT_ARGS,
      ],
    });
    const context = await browser.newContext({
      userAgent: buildUserAgent(chromiumVersion),
      extraHTTPHeaders: buildClientHintsHeaders(chromiumVersion),
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      // Auto-dismiss JavaScript dialogs (alert/confirm/prompt) without blocking
      // Chrome's "This web app may not be secured" interstitial is handled via ignoreHTTPSErrors
    });

    // Auto-dismiss any browser dialogs so they never block automation
    context.on('dialog', async (dialog) => {
      log.info({ type: dialog.type(), message: dialog.message() }, 'Auto-dismissing browser dialog');
      await dialog.dismiss().catch(() => {});
    });

    const instance: BrowserInstance = {
      name,
      profileDir,
      context,
      browser,
      launchedAt: new Date(),
    };

    this.instances.set(name, instance);
    log.info({ name }, 'Browser launched');
    return instance;
  }

  /**
   * Close a named browser instance and remove it from the registry.
   * Returns false if the instance was not found.
   */
  async close(name: string): Promise<boolean> {
    const instance = this.instances.get(name);
    if (!instance) return false;

    await instance.context.close().catch((e: unknown) =>
      log.error({ name, err: e }, 'Error closing context'),
    );
    await instance.browser.close().catch((e: unknown) =>
      log.error({ name, err: e }, 'Error closing browser'),
    );

    this.instances.delete(name);
    log.info({ name }, 'Browser closed');
    return true;
  }

  /** Return metadata for all running instances (no playwright objects). */
  list(): Array<{ name: string; profileDir: string; launchedAt: string }> {
    return Array.from(this.instances.values()).map((i) => ({
      name: i.name,
      profileDir: i.profileDir,
      launchedAt: i.launchedAt.toISOString(),
    }));
  }

  /** Get a running instance by name, or undefined. */
  get(name: string): BrowserInstance | undefined {
    return this.instances.get(name);
  }

  /**
   * Connect to an already-running Chrome/Chromium browser via CDP endpoint.
   * Stores the connected instance under `name` exactly like `launch()`.
   * The browser's first existing context is used; no new context is created.
   *
   * @param name         - Identifier for the instance (e.g. "chrome-cdp").
   * @param cdpEndpoint  - CDP HTTP endpoint (e.g. "http://localhost:9222").
   */
  async connectCDP(name: string, cdpEndpoint: string): Promise<BrowserInstance> {
    const existing = this.instances.get(name);
    if (existing) {
      log.info({ name, cdpEndpoint }, 'Returning cached CDP browser instance');
      return existing;
    }

    if (!cdpEndpoint || cdpEndpoint.trim() === '') {
      throw new Error('connectCDP: cdpEndpoint must be a non-empty string');
    }

    log.info({ name, cdpEndpoint }, 'Connecting to browser via CDP');

    const browser = await chromium.connectOverCDP(cdpEndpoint);
    const contexts = browser.contexts();
    const context: BrowserContext =
      contexts.length > 0 ? contexts[0]! : await browser.newContext({
        ignoreHTTPSErrors: true,
      });

    // Auto-dismiss any browser dialogs so they never block automation
    context.on('dialog', async (dialog) => {
      log.info({ type: dialog.type(), message: dialog.message() }, 'Auto-dismissing CDP dialog');
      await dialog.dismiss().catch(() => {});
    });

    const instance: BrowserInstance = {
      name,
      profileDir: `(cdp:${cdpEndpoint})`,
      context,
      browser,
      launchedAt: new Date(),
    };

    this.instances.set(name, instance);
    log.info({ name, cdpEndpoint }, 'CDP browser connected');
    return instance;
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const VALID_OPS = ['launch', 'close', 'list', 'connect'] as const;
type BrowserOp = (typeof VALID_OPS)[number];

export const browserManagerTool: ToolDefinition = {
  name: 'browser.launch',
  description:
    'Launch or connect to a named Chromium browser instance backed by a persistent ' +
    'profile. Operations: launch, close, list, connect (CDP).',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    operation: {
      type: 'string',
      required: true,
      enum: [...VALID_OPS],
      description: 'Operation to perform on browser instances.',
    },
    name: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance to target (default: "default").',
    },
    headless: {
      type: 'boolean',
      required: false,
      default: true,
      description: 'Whether to launch headless (default: true). Only used by "launch".',
    },
    cdpEndpoint: {
      type: 'string',
      required: false,
      default: 'http://localhost:9222',
      description:
        'CDP endpoint URL for the "connect" operation (default: "http://localhost:9222"). ' +
        'Chrome must be running with --remote-debugging-port=9222.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
    const op = params['operation'];

    if (typeof op !== 'string' || !(VALID_OPS as readonly string[]).includes(op)) {
      return {
        success: false,
        output: `browser.launch: "operation" must be one of: ${VALID_OPS.join('|')}.`,
      };
    }

    const manager = BrowserManager.getInstance();
    const name = typeof params['name'] === 'string' ? params['name'] : 'default';
    const headless = params['headless'] !== false;
    const cdpEndpoint =
      typeof params['cdpEndpoint'] === 'string' && params['cdpEndpoint'].trim() !== ''
        ? params['cdpEndpoint'].trim()
        : 'http://localhost:9222';

    try {
      if (op === 'list') {
        const instances = manager.list();
        ctxLog.info({ tool: 'browser.launch', op }, 'Listed instances');
        return {
          success: true,
          output:
            `Active browser instances (${instances.length}):\n` +
            instances.map((i) => `  ${i.name} — launched ${i.launchedAt}`).join('\n'),
          data: { instances },
        };
      }

      if (op === 'launch') {
        const instance = await manager.launch(name, headless);
        ctxLog.info({ tool: 'browser.launch', name }, 'Browser launched');
        return {
          success: true,
          output: `Browser "${name}" launched (headless=${headless}). Profile: ${instance.profileDir}`,
          data: { name, profileDir: instance.profileDir, headless },
        };
      }

      if ((op as BrowserOp) === 'connect') {
        const instance = await manager.connectCDP(name, cdpEndpoint);
        ctxLog.info({ tool: 'browser.launch', name, cdpEndpoint }, 'CDP browser connected');
        const pageCount = instance.context.pages().length;
        return {
          success: true,
          output:
            `Connected to browser "${name}" via CDP at ${cdpEndpoint}. ` +
            `Open pages: ${pageCount}.`,
          data: { name, cdpEndpoint, pageCount },
        };
      }

      // op === 'close'
      const closed = await manager.close(name);
      ctxLog.info({ tool: 'browser.launch', name, closed }, 'Browser close attempted');
      return closed
        ? { success: true, output: `Browser "${name}" closed.`, data: { name } }
        : { success: false, output: `browser.launch: no instance named "${name}" found.` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.launch', op, err }, 'Browser operation failed');
      return { success: false, output: `browser.launch error: ${msg}` };
    }
  },
};
