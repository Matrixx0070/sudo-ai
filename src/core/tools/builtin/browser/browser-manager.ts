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
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataPath } from '../../../shared/paths.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import {
  buildLaunchArgs,
  detectChromiumVersion,
  buildUserAgent,
  buildClientHintsHeaders,
} from './anti-detect.js';
import { CDPManager, type CDPConfig } from './cdp-manager.js';
import { SSRFGuard } from './ssrf-guard.js';
import {
  getProfileEntry,
  ensureProfileDir,
  profileDir as resolveProfileDir,
  type ProfileTrust,
} from './profile-registry.js';
import { checkOwnerAllowed, browserAudit } from './safety.js';

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
  /** null for persistent contexts (Playwright doesn't expose a Browser then). */
  browser: Browser | null;
  launchedAt: Date;
  /** Spec 3 identity metadata (from the profile registry). */
  trust?: ProfileTrust;
  ownerOnly?: boolean;
  ephemeral?: boolean;
  /** Whether this instance is CDP-connected (external browser we must not wipe/kill). */
  cdp?: boolean;
}

/** Per-instance launch state for crash recovery + ephemeral wipe (not exposed on BrowserInstance). */
interface LaunchState {
  headless: boolean;
  ephemeral: boolean;
  autoRestart: boolean;
  restartCount: number;
  /** Set true while WE are intentionally closing, so the 'close' handler skips recovery. */
  closing: boolean;
}

const MAX_AUTO_RESTARTS = 3;

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
  private readonly launchState = new Map<string, LaunchState>();
  private readonly profilesRoot: string;

  /** Phase 6: CDPManager for first-class CDP browser control. */
  private cdpManager: CDPManager | null = null;
  /** Phase 6: SSRF guard for navigation safety. */
  private ssrfGuard: SSRFGuard;

  private constructor(profilesRoot = dataPath('browser-profiles')) {
    this.profilesRoot = resolve(profilesRoot);
    if (!existsSync(this.profilesRoot)) {
      mkdirSync(this.profilesRoot, { recursive: true });
    }
    this.ssrfGuard = new SSRFGuard({
      // Allow localhost in development; production should restrict this
      allowedHosts: process.env['SUDO_BROWSER_ALLOW_HOSTS']?.split(',').filter(Boolean) ?? [],
    });
  }

  static getInstance(): BrowserManager {
    if (!BrowserManager._instance) {
      BrowserManager._instance = new BrowserManager();
    }
    return BrowserManager._instance;
  }

  /** Access the SSRFGuard instance for URL safety checks. */
  getSSRFGuard(): SSRFGuard {
    return this.ssrfGuard;
  }

  /** Access the CDPManager instance (may be null if not yet initialized). */
  getCDPManager(): CDPManager | null {
    return this.cdpManager;
  }

  /**
   * Ensure a CDPManager is initialized and connected.
   * If one already exists, returns it. Otherwise creates and connects one
   * using the provided config or the SUDO_CDP_ENDPOINT env var.
   */
  async ensureCDPManager(config?: Partial<CDPConfig>): Promise<CDPManager> {
    if (this.cdpManager) return this.cdpManager;

    const endpoint = config?.endpoint ?? process.env['SUDO_CDP_ENDPOINT'];
    const cdpConfig: Partial<CDPConfig> = {
      headless: config?.headless ?? true,
      exposeCDP: config?.exposeCDP ?? true,
      cdpPort: config?.cdpPort ?? 9222,
      ...config,
    };
    // If an endpoint was provided (via argument or env), prefer it
    if (endpoint) cdpConfig.endpoint = endpoint;

    this.cdpManager = new CDPManager(cdpConfig);
    await this.cdpManager.connect(endpoint);
    log.info({ endpoint: endpoint ?? '(launch)' }, 'CDPManager connected via ensureCDPManager');
    return this.cdpManager;
  }

  /**
   * Get or auto-connect the "default" browser instance.
   * Priority: 1) cached instance, 2) CDPManager if SUDO_CDP_ENDPOINT is set,
   *           3) raw CDP on localhost:9222, 4) headless launch.
   * This ensures ALL tools automatically use the owner's already-open Chrome.
   */
  async getOrConnect(name = 'default'): Promise<BrowserInstance> {
    const cached = this.instances.get(name);
    if (cached) return cached;

    // Phase 6: Prefer CDPManager when a CDP endpoint is explicitly configured
    const configuredEndpoint = process.env['SUDO_CDP_ENDPOINT'];
    if (configuredEndpoint) {
      try {
        const cdp = await this.ensureCDPManager({ endpoint: configuredEndpoint });
        const client = cdp.getCDPClient();
        if (client) {
          const contexts = client.contexts();
          const context: BrowserContext =
            contexts.length > 0 ? contexts[0]! : await client.newContext({ ignoreHTTPSErrors: true });

          context.on('dialog', async (dialog) => {
            log.info({ type: dialog.type(), message: dialog.message() }, 'Auto-dismissing CDP dialog');
            await dialog.dismiss().catch(() => {});
          });

          const instance: BrowserInstance = {
            name,
            profileDir: `(cdp:${configuredEndpoint})`,
            context,
            browser: client,
            launchedAt: new Date(),
            cdp: true,
          };
          this.instances.set(name, instance);
          log.info({ name, cdpEndpoint: configuredEndpoint }, 'Auto-connected via CDPManager');
          return instance;
        }
      } catch (err) {
        log.warn({ err, endpoint: configuredEndpoint }, 'CDPManager connection failed — falling back');
      }
    }

    // Try raw CDP on localhost:9222 — the owner's Chrome on port 9222
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
        cdp: true,
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
   * Launch (or return cached) a named browser backed by a DURABLE persistent
   * profile at data/browser-profiles/{name}/ (userDataDir, mode 0700). Uses
   * launchPersistentContext so cookies + localStorage survive restarts — the
   * previous implementation launched a throwaway context and never wrote the
   * profile dir, so "logins persist" silently failed.
   *
   * @param autoRestart when true, an unexpected context close (crash / killed
   *        Chromium) triggers a bounded auto-relaunch of the same profile.
   */
  async launch(name: string, headless = true, autoRestart = false): Promise<BrowserInstance> {
    const existing = this.instances.get(name);
    if (existing) {
      log.info({ name }, 'Returning cached browser instance');
      return existing;
    }

    const entry = getProfileEntry(name);
    // Ephemeral profiles start clean every session: wipe any stale dir first.
    if (entry.ephemeral) {
      const stale = resolveProfileDir(name, this.profilesRoot);
      if (existsSync(stale)) { try { rmSync(stale, { recursive: true, force: true }); } catch { /* best-effort */ } }
    }
    const userDataDir = ensureProfileDir(name, this.profilesRoot); // 0700

    log.info({ name, userDataDir, headless, ephemeral: entry.ephemeral, trust: entry.trust }, 'Launching persistent browser profile');

    // Detect Chromium version once for UA/CH-header accuracy
    const chromiumVersion = await getCachedChromiumVersion();

    // Persistent context: userDataDir is the profile. Launch + context options
    // are merged here (Playwright API). This is what makes logins durable.
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      args: buildLaunchArgs(),
      userAgent: buildUserAgent(chromiumVersion),
      extraHTTPHeaders: buildClientHintsHeaders(chromiumVersion),
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
    });

    // Auto-dismiss any browser dialogs so they never block automation
    context.on('dialog', async (dialog) => {
      log.info({ type: dialog.type(), message: dialog.message() }, 'Auto-dismissing browser dialog');
      await dialog.dismiss().catch(() => {});
    });

    const instance: BrowserInstance = {
      name,
      profileDir: userDataDir,
      context,
      browser: context.browser(), // null for persistent contexts — expected
      launchedAt: new Date(),
      trust: entry.trust,
      ownerOnly: entry.ownerOnly,
      ephemeral: entry.ephemeral,
    };

    this.instances.set(name, instance);
    this.launchState.set(name, { headless, ephemeral: entry.ephemeral, autoRestart, restartCount: 0, closing: false });

    // Crash recovery: an unexpected close (owner killed Chromium, renderer
    // crash) removes the instance; auto-relaunch the SAME profile if requested.
    context.on('close', () => { void this._onContextClosed(name); });

    log.info({ name }, 'Browser launched (persistent)');
    return instance;
  }

  /** Handle an unexpected context close: clean state + bounded auto-relaunch. */
  private async _onContextClosed(name: string): Promise<void> {
    const state = this.launchState.get(name);
    this.instances.delete(name);
    if (!state || state.closing) return; // intentional close — nothing to recover
    log.warn({ name, restartCount: state.restartCount }, 'Browser context closed unexpectedly (crash/kill)');
    if (!state.autoRestart || state.restartCount >= MAX_AUTO_RESTARTS) {
      this.launchState.delete(name);
      if (state.autoRestart) log.error({ name }, 'Browser auto-restart limit reached — giving up');
      return;
    }
    state.restartCount += 1;
    this.launchState.set(name, state);
    try {
      await this.launch(name, state.headless, true);
      log.info({ name, attempt: state.restartCount }, 'Browser auto-relaunched after crash');
    } catch (err) {
      log.error({ name, err: String(err) }, 'Browser auto-relaunch failed');
    }
  }

  /**
   * Close a named browser instance and remove it from the registry. For an
   * EPHEMERAL profile the userDataDir is wiped so the next launch starts clean.
   * Returns false if the instance was not found.
   */
  async close(name: string): Promise<boolean> {
    const instance = this.instances.get(name);
    if (!instance) return false;

    const state = this.launchState.get(name);
    if (state) state.closing = true; // suppress crash-recovery for this close

    await instance.context.close().catch((e: unknown) =>
      log.error({ name, err: e }, 'Error closing context'),
    );
    // Persistent contexts have no separate Browser; close it only if present (CDP).
    if (instance.browser && !instance.cdp) {
      await instance.browser.close().catch((e: unknown) =>
        log.error({ name, err: e }, 'Error closing browser'),
      );
    }

    this.instances.delete(name);
    this.launchState.delete(name);

    // Ephemeral: wipe the profile dir on close (never for CDP/external browsers).
    if (instance.ephemeral && !instance.cdp) {
      try {
        rmSync(instance.profileDir, { recursive: true, force: true });
        log.info({ name, profileDir: instance.profileDir }, 'Ephemeral profile wiped on close');
      } catch (err) {
        log.warn({ name, err: String(err) }, 'Ephemeral wipe failed');
      }
    }

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
   * Phase 6: When a CDP endpoint is provided, CDPManager is used for the
   * connection, providing lifecycle management, session tracking, and
   * network interception. Falls back to raw Playwright if CDPManager fails.
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

    // Phase 6: Prefer CDPManager for structured CDP connections
    try {
      const cdp = await this.ensureCDPManager({ endpoint: cdpEndpoint });
      const client = cdp.getCDPClient();
      if (client) {
        const contexts = client.contexts();
        const context: BrowserContext =
          contexts.length > 0 ? contexts[0]! : await client.newContext({
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
          browser: client,
          launchedAt: new Date(),
        };

        this.instances.set(name, instance);
        log.info({ name, cdpEndpoint }, 'CDP browser connected via CDPManager');
        return instance;
      }
    } catch (err) {
      log.warn({ err, name, cdpEndpoint }, 'CDPManager connection failed — falling back to raw Playwright');
    }

    // Fallback: raw Playwright CDP connection
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
      cdp: true,
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
    'Launch or connect to a named Chromium browser backed by a DURABLE persistent ' +
    'profile (cookies + logins survive restarts). Operations: launch, close, list, connect (CDP). ' +
    'Use `profile` to select a named identity from config/browser-profiles.json5 ' +
    '(e.g. personal/work/ephemeral); ephemeral profiles are wiped on close.',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    operation: {
      type: 'string',
      required: true,
      enum: [...VALID_OPS],
      description: 'Operation to perform on browser instances.',
    },
    profile: {
      type: 'string',
      required: false,
      description:
        'Named durable identity from config/browser-profiles.json5 (personal/work/ephemeral or any name). ' +
        'Takes precedence over `name`. Defaults to the registry default profile.',
    },
    name: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Legacy alias for the instance/profile name (use `profile`).',
    },
    headless: {
      type: 'boolean',
      required: false,
      default: true,
      description: 'Whether to launch headless (default: true). Only used by "launch".',
    },
    autoRestart: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'Auto-relaunch the same profile if Chromium crashes/is killed (launch only).',
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
    // `profile` (named durable identity) wins over the legacy `name`. For non-
    // launch ops we keep 'default' so existing callers/instances still resolve.
    const rawName = typeof params['profile'] === 'string' && params['profile'].trim()
      ? params['profile'].trim()
      : (typeof params['name'] === 'string' ? params['name'] : 'default');
    const name = rawName;
    const headless = params['headless'] !== false;
    const autoRestart = params['autoRestart'] === true;
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
        // Safety rail: owner-only profiles (e.g. personal) are refused for a
        // known non-owner session. Audited either way.
        const entry = getProfileEntry(name);
        const gate = checkOwnerAllowed(entry, ctx.sessionId);
        if (!gate.allowed) {
          ctxLog.error({ tool: 'browser.launch', name }, 'owner-only profile denied');
          return { success: false, output: `browser.launch: ${gate.reason}.` };
        }
        const instance = await manager.launch(name, headless, autoRestart);
        browserAudit('launch', { profile: name, trust: instance.trust, ephemeral: instance.ephemeral, ownerOnly: instance.ownerOnly, sessionId: ctx.sessionId });
        ctxLog.info({ tool: 'browser.launch', name, autoRestart }, 'Browser launched');
        const persist = instance.ephemeral ? 'ephemeral (wiped on close)' : 'durable (persists across restarts)';
        return {
          success: true,
          output:
            `Browser profile "${name}" launched (headless=${headless}, ${persist}, trust=${instance.trust ?? 'low'})` +
            `${autoRestart ? ', auto-restart on' : ''}. userDataDir: ${instance.profileDir}`,
          data: {
            name, profileDir: instance.profileDir, headless, autoRestart,
            trust: instance.trust, ownerOnly: instance.ownerOnly, ephemeral: instance.ephemeral,
          },
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
