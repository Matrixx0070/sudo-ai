/**
 * @file src/llm/grok-warm-browser.ts
 * @description GWV6 — a managed, persistent, Cloudflare-cleared grok.com browser
 * that the statsig oracle attaches to (see grok-statsig-oracle.ts). Grok's video
 * token needs a real rendering engine that genuinely solved Cloudflare, and — a
 * live finding — a *freshly-launched* Chrome (headed or headless, and via
 * Playwright) is CF-challenged, while a PLAIN chromium spawned directly with a
 * logged-in profile and NO automation flags passes. So this manager spawns the
 * chromium BINARY directly (child_process, not Playwright), keeps it warm on a
 * durable SSO profile + virtual display, and exposes its CDP endpoint.
 *
 * Lifecycle: `ensureRunning()` adopts an already-running CF-clear browser, else
 * spawns one and waits until grok's app is loaded (CF cleared). Idempotent.
 * Secrets: never logs cookies; the profile holds the SSO session (0700-ish dir).
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolveBrowserDisplay } from '../core/tools/builtin/browser/anti-detect.js';
import { createLogger } from '../core/shared/logger.js';

const log = createLogger('llm:grok-warm-browser');

const DEFAULT_PORT = 9223;
const DEFAULT_PROFILE = 'data/grok-warm-profile';
const DEFAULT_NAV_URL = 'https://grok.com/imagine';
const DEFAULT_READY_TIMEOUT_MS = 45_000;

/** A page target as reported by `/json`. */
interface CdpTarget {
  type?: string;
  url?: string;
  title?: string;
}

/** Injectable seams (real network / process by default; faked in tests). */
export interface WarmGrokBrowserDeps {
  spawnProcess?: (cmd: string, args: string[], display: string) => { unref: () => void };
  fetchJson?: (url: string) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WarmGrokBrowserOptions {
  /** Durable grok profile dir (SSO logged-in). Required to spawn. */
  profileDir?: string;
  /** CDP port. Env SUDO_GROK_WARM_PORT wins. */
  port?: number;
  /** X display for the headed browser. Env SUDO_GROK_WARM_DISPLAY wins. */
  display?: string;
  /** chromium binary. Env SUDO_GROK_WARM_CHROMIUM wins. */
  chromiumPath?: string;
  navigateUrl?: string;
  readyTimeoutMs?: number;
  deps?: WarmGrokBrowserDeps;
}

export class GrokWarmBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrokWarmBrowserError';
  }
}

function resolveChromiumBinary(explicit?: string): string {
  return (
    explicit ??
    process.env['SUDO_GROK_WARM_CHROMIUM'] ??
    (existsSync('/snap/bin/chromium')
      ? '/snap/bin/chromium'
      : existsSync('/usr/bin/chromium-browser')
        ? '/usr/bin/chromium-browser'
        : 'chromium')
  );
}

export class WarmGrokBrowser {
  private readonly profileDir: string;
  private readonly port: number;
  private readonly display: string;
  private readonly chromiumPath: string;
  private readonly navigateUrl: string;
  private readonly readyTimeoutMs: number;
  private readonly fetchJson: (url: string) => Promise<unknown>;
  private readonly spawnProcess: (cmd: string, args: string[], display: string) => { unref: () => void };
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private ensuring: Promise<string> | null = null;

  constructor(opts: WarmGrokBrowserOptions = {}) {
    this.profileDir = opts.profileDir ?? process.env['SUDO_GROK_WARM_PROFILE'] ?? DEFAULT_PROFILE;
    this.port = opts.port ?? (Number.parseInt(process.env['SUDO_GROK_WARM_PORT'] ?? '', 10) || DEFAULT_PORT);
    this.display = opts.display ?? process.env['SUDO_GROK_WARM_DISPLAY'] ?? resolveBrowserDisplay();
    this.chromiumPath = resolveChromiumBinary(opts.chromiumPath);
    this.navigateUrl = opts.navigateUrl ?? DEFAULT_NAV_URL;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const d = opts.deps ?? {};
    this.fetchJson = d.fetchJson ?? (async (url) => (await fetch(url)).json());
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.spawnProcess =
      d.spawnProcess ??
      ((cmd, args, display) => {
        const p = spawn(cmd, args, {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, DISPLAY: display },
        });
        return { unref: () => p.unref() };
      });
  }

  cdpUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Return a CDP URL for a CF-clear, logged-in grok browser — adopting a running
   * one or spawning and waiting for it. Single-flight; safe to call per request.
   */
  async ensureRunning(): Promise<string> {
    if (!this.ensuring) {
      this.ensuring = this.doEnsure().finally(() => {
        this.ensuring = null;
      });
    }
    return this.ensuring;
  }

  private async doEnsure(): Promise<string> {
    if (await this.isReady()) return this.cdpUrl();
    if (await this.isReachable()) {
      // Reachable but not CF-clear yet — a real browser solves it in a few seconds.
      if (await this.waitReady()) return this.cdpUrl();
    }
    if (!existsSync(this.profileDir)) {
      throw new GrokWarmBrowserError(
        `No durable grok profile at ${this.profileDir} — run \`sudo-ai grok websession setup\` (one-time SSO login).`,
      );
    }
    this.spawn();
    if (await this.waitReady()) return this.cdpUrl();
    throw new GrokWarmBrowserError('warm grok browser did not become Cloudflare-clear in time');
  }

  /** GET /json/version succeeds → a browser is listening. */
  private async isReachable(): Promise<boolean> {
    try {
      await this.fetchJson(`${this.cdpUrl()}/json/version`);
      return true;
    } catch {
      return false;
    }
  }

  /** A grok page target exists and is NOT on a Cloudflare challenge. */
  private async isReady(): Promise<boolean> {
    try {
      const tabs = (await this.fetchJson(`${this.cdpUrl()}/json`)) as CdpTarget[];
      const grok = tabs.find((t) => t.type === 'page' && (t.url ?? '').includes('grok.com'));
      if (!grok) return false;
      const title = grok.title ?? '';
      // Ready ONLY when grok's app has actually rendered (title like "Imagine -
      // Grok"). During load the title is empty and the Cloudflare interstitial is
      // "Just a moment..." — neither contains "grok", so both read as not-ready.
      if (!/grok/i.test(title)) return false;
      if (/just a moment/i.test(title)) return false;
      if ((grok.url ?? '').includes('/cdn-cgi/challenge')) return false;
      return true;
    } catch {
      return false;
    }
  }

  private async waitReady(): Promise<boolean> {
    const deadline = this.now() + this.readyTimeoutMs;
    while (this.now() < deadline) {
      if (await this.isReady()) return true;
      await this.sleep(1_000);
    }
    return false;
  }

  private spawn(): void {
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try {
        rmSync(this.profileDir + '/' + f, { force: true });
      } catch {
        /* best effort: strip stale single-instance locks before spawn */
      }
    }
    const args = [
      '--no-sandbox',
      '--no-first-run',
      '--disable-gpu',
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      this.navigateUrl,
    ];
    // No automation flags — those are exactly what Cloudflare fingerprints.
    this.spawnProcess(this.chromiumPath, args, this.display).unref();
    log.info({ port: this.port, display: this.display }, 'spawned warm grok browser');
  }
}

let singleton: WarmGrokBrowser | null = null;

export function getWarmGrokBrowser(opts: WarmGrokBrowserOptions = {}): WarmGrokBrowser {
  if (!singleton) singleton = new WarmGrokBrowser(opts);
  return singleton;
}

/** Test-only reset of the process-wide singleton. */
export function __resetWarmGrokBrowser(): void {
  singleton = null;
}
