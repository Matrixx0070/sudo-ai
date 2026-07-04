/**
 * @file cdp-manager.ts
 * @description Chrome DevTools Protocol connection manager for SUDO-AI v4.
 *
 * Extends the existing BrowserManager with first-class CDP support including
 * lifecycle management, multi-tab coordination, and network interception.
 *
 * Primary mode:  Launch Chromium via Playwright with CDP endpoint exposed
 * Secondary mode: Connect to an existing Chrome via CDP endpoint
 */

import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright-core';
import { createLogger } from '../../../shared/logger.js';
import { genId } from '../../../shared/utils.js';
import { buildLaunchArgs } from './anti-detect.js';

const log = createLogger('cdp-manager');

// -- Types -------------------------------------------------------------------

export type CDPConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface CDPConfig {
  endpoint?: string;
  headless: boolean;
  exposeCDP: boolean;
  cdpPort: number;
  userDataDir?: string;
  slowMo?: number;
}

export interface CDPSession {
  id: string;
  targetId: string;
  url: string;
  state: CDPConnectionState;
  createdAt: string;
}

export interface CDPManagerState {
  connectionState: CDPConnectionState;
  sessions: CDPSession[];
  activeSessionId?: string;
  endpoint?: string;
}

// -- Defaults ----------------------------------------------------------------

const DEFAULT_CONFIG: CDPConfig = { headless: true, exposeCDP: true, cdpPort: 9222 };

// -- CDPManager --------------------------------------------------------------

/**
 * Manages a Chrome DevTools Protocol connection with lifecycle control,
 * multi-tab session coordination, and network interception.
 */
export class CDPManager {
  private config: CDPConfig;
  private connectionState: CDPConnectionState = 'disconnected';
  private sessions = new Map<string, CDPSession>();
  private activeSessionId: string | undefined;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private cdpEndpoint: string | undefined;
  private interceptHandlers = new Map<string, (request: Request) => void>();

  constructor(config?: Partial<CDPConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info({ config: this.config }, 'CDPManager initialized');
  }

  // -- Connection lifecycle --------------------------------------------------

  /**
   * Connect to a CDP endpoint or launch a new Chromium browser.
   * If `endpoint` is provided (argument or config), attaches to existing Chrome.
   * Otherwise launches fresh Chromium with CDP exposed.
   */
  async connect(endpoint?: string): Promise<void> {
    if (this.connectionState === 'connected') {
      log.warn('Already connected — call disconnect() first');
      return;
    }
    this.connectionState = 'connecting';
    const target = endpoint ?? this.config.endpoint;
    try {
      if (target) await this.connectToEndpoint(target);
      else await this.launchBrowser();
      this.connectionState = 'connected';
      log.info({ endpoint: this.cdpEndpoint }, 'CDP connection established');
    } catch (err) {
      this.connectionState = 'error';
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, endpoint: target }, 'CDP connection failed');
      throw new Error(`CDP connection failed: ${msg}`);
    }
  }

  /** Disconnect from the browser and clean up all sessions. */
  async disconnect(): Promise<void> {
    if (this.connectionState === 'disconnected') return;
    log.info({ sessionCount: this.sessions.size }, 'Disconnecting CDP manager');
    for (const id of this.sessions.keys()) {
      try { await this.closeSession(id); } catch (e) { log.error({ sessionId: id, err: e }, 'Error closing session'); }
    }
    if (this.context) {
      await this.context.close().catch((e: unknown) => log.error({ err: e }, 'Error closing context'));
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch((e: unknown) => log.error({ err: e }, 'Error closing browser'));
      this.browser = null;
    }
    this.interceptHandlers.clear();
    this.activeSessionId = undefined;
    this.cdpEndpoint = undefined;
    this.connectionState = 'disconnected';
    log.info('CDP manager disconnected');
  }

  // -- Session (tab) management ----------------------------------------------

  /** Create a new browser tab (CDP session) and navigate to `url`. */
  async createSession(url = 'about:blank'): Promise<CDPSession> {
    this.requireConnected();
    const page = await this.context!.newPage();
    this.applyInterception(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e: unknown) =>
      log.warn({ url, err: e }, 'Navigation warning during session creation'),
    );
    const sessionId = genId();
    const targetId = await this.resolveTargetId(page);
    const session: CDPSession = {
      id: sessionId, targetId, url, state: 'connected', createdAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, session);
    this.activeSessionId = sessionId;

    // Keep session URL in sync as the page navigates
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        const s = this.sessions.get(sessionId);
        if (s) s.url = frame.url();
      }
    });
    // Mark disconnected when the page closes externally
    page.on('close', () => {
      const s = this.sessions.get(sessionId);
      if (s) s.state = 'disconnected';
      if (this.activeSessionId === sessionId) this.activeSessionId = undefined;
    });
    log.info({ sessionId, targetId, url }, 'CDP session created');
    return session;
  }

  /** Switch the active session — brings the associated page to the foreground. */
  async switchSession(sessionId: string): Promise<void> {
    this.requireConnected();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.state !== 'connected')
      throw new Error(`Session ${sessionId} not connected (state: ${session.state})`);
    const page = await this.findPageByTargetId(session.targetId);
    if (page) await page.bringToFront().catch((e: unknown) => log.warn({ err: e }, 'bringToFront failed'));
    this.activeSessionId = sessionId;
    log.info({ sessionId }, 'Switched to CDP session');
  }

  /** Close a session — closes the underlying page and removes it from tracking. */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      const page = await this.findPageByTargetId(session.targetId);
      if (page && !page.isClosed()) await page.close();
    } catch (e) { log.warn({ sessionId, err: e }, 'Error closing session page'); }
    session.state = 'disconnected';
    this.sessions.delete(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = undefined;
    log.info({ sessionId }, 'CDP session closed');
  }

  /** Return the currently active session, or undefined. */
  getActiveSession(): CDPSession | undefined {
    return this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
  }

  /** Return all tracked sessions as an array. */
  listSessions(): CDPSession[] {
    return Array.from(this.sessions.values());
  }

  // -- State & accessors -----------------------------------------------------

  /** Return a serializable snapshot of the manager's current state. */
  getState(): CDPManagerState {
    return {
      connectionState: this.connectionState,
      sessions: this.listSessions(),
      activeSessionId: this.activeSessionId,
      endpoint: this.cdpEndpoint,
    };
  }

  /**
   * Expose the raw CDP client for advanced operations.
   * Returns the Playwright Browser which exposes `.newBrowserCDPSession()`
   * and per-page CDP sessions for low-level protocol access.
   */
  getCDPClient(): Browser | null {
    return this.browser;
  }

  /** Expose the active browser context (e.g. for page enumeration by consumers). */
  getContext(): BrowserContext | null {
    return this.context;
  }

  // -- Network interception --------------------------------------------------

  /**
   * Register a network interception handler for URLs matching `pattern`.
   * Handler receives the Playwright Request object — can abort, respond, or observe.
   * Applied to all existing and future pages.
   */
  interceptRequests(pattern: string, handler: (request: Request) => void): void {
    this.interceptHandlers.set(pattern, handler);
    log.info({ pattern }, 'Network interception handler registered');
    if (this.context) {
      for (const page of this.context.pages()) this.applyInterceptionToPage(page, pattern, handler);
    }
  }

  // -- Screenshot ------------------------------------------------------------

  /** Capture a screenshot of the active session's page as a PNG Buffer. */
  async screenshot(options?: {
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Buffer> {
    this.requireConnected();
    const page = await this.requireActivePage();
    const buf = await page.screenshot({
      type: 'png', fullPage: options?.fullPage ?? false, clip: options?.clip,
    });
    log.info({ fullPage: options?.fullPage, size: buf.length }, 'Screenshot captured');
    return Buffer.from(buf);
  }

  // -- Private helpers -------------------------------------------------------

  /** Connect to an existing Chrome instance at the given CDP endpoint. */
  private async connectToEndpoint(endpoint: string): Promise<void> {
    log.info({ endpoint }, 'Connecting to existing Chrome via CDP');
    this.browser = await chromium.connectOverCDP(endpoint);
    const ctxs = this.browser.contexts();
    this.context = ctxs.length > 0 ? ctxs[0]! : await this.browser.newContext({ ignoreHTTPSErrors: true });
    this.cdpEndpoint = endpoint;
    this.wireDialogDismissal();
  }

  /** Launch a new Chromium instance with CDP endpoint exposed. */
  private async launchBrowser(): Promise<void> {
    log.info({ cdpPort: this.config.cdpPort, headless: this.config.headless }, 'Launching Chromium with CDP');
    this.browser = await chromium.launch({
      headless: this.config.headless,
      slowMo: this.config.slowMo,
      // Security-weakening flags gated behind SUDO_BROWSER_INSECURE=1; always
      // exposes the CDP port and the anti-automation-signal flags.
      args: buildLaunchArgs([`--remote-debugging-port=${this.config.cdpPort}`]),
    });
    this.context = await this.browser.newContext({
      ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 },
    });
    this.cdpEndpoint = `http://localhost:${this.config.cdpPort}`;
    this.wireDialogDismissal();
  }

  /** Auto-dismiss browser dialogs so they never block automation. */
  private wireDialogDismissal(): void {
    if (!this.context) return;
    this.context.on('dialog', async (d) => {
      log.info({ type: d.type() }, 'Auto-dismissing dialog');
      await d.dismiss().catch(() => {});
    });
  }

  /** Resolve the CDP targetId for a Playwright Page via a temporary CDP session. */
  private async resolveTargetId(page: Page): Promise<string> {
    try {
      const cdp = await page.context().newCDPSession(page);
      // The protocol result is { targetInfo } — the previous { target }
      // destructure was always undefined, so every session got a random ID.
      const { targetInfo } = await cdp.send('Target.getTargetInfo');
      await cdp.detach().catch(() => {});
      return targetInfo.targetId;
    } catch { return genId(); }
  }

  /** Find a Page object by its CDP targetId. */
  private async findPageByTargetId(targetId: string): Promise<Page | null> {
    if (!this.context) return null;
    for (const page of this.context.pages()) {
      try {
        const cdp = await page.context().newCDPSession(page);
        const { targetInfo } = await cdp.send('Target.getTargetInfo');
        await cdp.detach().catch(() => {});
        if (targetInfo.targetId === targetId) return page;
      } catch { continue; }
    }
    return null;
  }

  /** Throw if the manager is not in a connected state. */
  private requireConnected(): void {
    if (this.connectionState !== 'connected')
      throw new Error(`CDPManager is not connected (state: ${this.connectionState})`);
  }

  /** Get the Page for the active session, throwing if unavailable. */
  private async requireActivePage(): Promise<Page> {
    const session = this.getActiveSession();
    if (!session) throw new Error('No active CDP session');
    const page = await this.findPageByTargetId(session.targetId);
    if (!page || page.isClosed())
      throw new Error(`Active session page unavailable (sessionId: ${session.id})`);
    return page;
  }

  /** Apply all registered interception handlers to a page. */
  private applyInterception(page: Page): void {
    for (const [pattern, handler] of this.interceptHandlers)
      this.applyInterceptionToPage(page, pattern, handler);
  }

  /** Apply a single interception handler to a page via route filtering. */
  private applyInterceptionToPage(page: Page, pattern: string, handler: (request: Request) => void): void {
    try {
      page.route(`**/${pattern}**`, async (route) => {
        try { handler(route.request()); }
        catch (e) {
          log.warn({ pattern, err: e }, 'Interception handler error — continuing request');
          await route.continue().catch(() => {});
        }
      });
    } catch (e) { log.warn({ pattern, err: e }, 'Failed to apply route interception'); }
  }
}