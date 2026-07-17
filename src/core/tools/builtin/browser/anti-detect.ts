/**
 * @file anti-detect.ts
 * @description Browser anti-detection helpers: launch args, UA spoofing, and
 * UA-Client-Hints headers. Mirrors Kimi K2's browser_guard.py approach.
 *
 * All functions are fail-open — they return safe defaults on any error.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('browser-anti-detect');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default Chrome version used when detection fails. */
const DEFAULT_VERSION = '120.0.6099.109';
const DEFAULT_MAJOR = '120';

/**
 * Launch args that suppress browser automation signals.
 * --disable-blink-features=AutomationControlled: hides navigator.webdriver.
 * --max_old_space_size=1024: V8 heap cap (mirrors Kimi K2 browser_guard.py).
 * --disable-features=TranslateUI: removes translate bar fingerprint.
 * --no-first-run: suppresses first-run UI.
 * --no-default-browser-check: suppresses default browser prompt.
 * --password-store=basic: avoids keychains that expose automation.
 * --use-mock-keychain: suppresses OS keychain dialogs (macOS).
 */
export const ANTI_DETECT_ARGS: string[] = [
  '--disable-blink-features=AutomationControlled',
  '--max_old_space_size=1024',
  '--disable-features=TranslateUI',
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--use-mock-keychain',
];

/**
 * Security-weakening flags that were previously always applied. They disable core
 * browser protections (same-origin policy, site isolation, cert validation) AND
 * make the browser MORE fingerprintable — real Chrome never runs like this, so
 * bot detectors flag it. Now opt-in only via SUDO_BROWSER_INSECURE=1 (e.g. for
 * scraping a site with a broken cert you control). Default off: safer and less
 * detectable.
 */
const INSECURE_ARGS: string[] = [
  '--disable-web-security',
  '--allow-running-insecure-content',
  '--ignore-certificate-errors',
  '--ignore-ssl-errors',
  '--disable-features=IsolateOrigins,site-per-process',
];

/** True when the operator has explicitly opted into the insecure launch flags. */
export function insecureBrowserEnabled(): boolean {
  return process.env['SUDO_BROWSER_INSECURE'] === '1';
}

/**
 * Build the Chromium launch args. Always includes the anti-automation-signal flags
 * and `--no-sandbox` (required to launch as root in this container). Includes the
 * security-weakening flags only when SUDO_BROWSER_INSECURE=1.
 *
 * @param extra - Additional caller-specific args (e.g. --remote-debugging-port).
 */
export function buildLaunchArgs(extra: string[] = []): string[] {
  const args = ['--no-sandbox', '--disable-dev-shm-usage', ...ANTI_DETECT_ARGS, ...extra];
  if (insecureBrowserEnabled()) args.push(...INSECURE_ARGS);
  return args;
}

// ---------------------------------------------------------------------------
// Real Chrome resolution (Google rejects Playwright's bundled Chromium)
// ---------------------------------------------------------------------------

/**
 * Candidate paths for a real Google Chrome / Chromium install.
 * Prefer google-chrome-stable — that binary is what Google trusts for login.
 * Playwright's bundled Chromium is intentionally last-resort (not listed here).
 */
const CHROME_CANDIDATES: string[] = [
  process.env['SUDO_BROWSER_EXECUTABLE'] ?? '',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

/**
 * Resolve a real Chrome/Chromium executable on the host.
 * Returns null when none is found (caller falls back to Playwright bundled).
 *
 * Override with SUDO_BROWSER_EXECUTABLE=/path/to/chrome.
 */
export function resolveChromeExecutable(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (existsSync(candidate)) {
        log.info({ executablePath: candidate }, 'Resolved real Chrome executable');
        return candidate;
      }
    } catch {
      // fail-open — try next
    }
  }
  log.info({}, 'No real Chrome executable found — Playwright bundled Chromium will be used');
  return null;
}

/**
 * Display for headed (non-headless) launches. Default `:10` (VPS XFCE).
 * Override with SUDO_BROWSER_DISPLAY.
 */
export function resolveBrowserDisplay(): string {
  return process.env['SUDO_BROWSER_DISPLAY']?.trim() || ':10';
}

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

/**
 * Attempt to determine the installed Chromium/Chrome version by running
 * the binary with `--version`. Tries google-chrome, chromium-browser, and
 * chromium in order. Returns the full version string (e.g. "120.0.6099.109")
 * or null if detection fails.
 *
 * @param executablePath - Optional explicit path to the Chrome/Chromium binary.
 */
export async function detectChromiumVersion(
  executablePath?: string,
): Promise<string | null> {
  const candidates = executablePath
    ? [executablePath]
    : ['google-chrome', 'chromium-browser', 'chromium', 'google-chrome-stable'];

  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5000 });
      // Output example: "Google Chrome 120.0.6099.109 \n" or "Chromium 125.0.6422.60 \n"
      const match = stdout.trim().match(/(\d+\.\d+\.\d+\.\d+)/);
      if (match?.[1]) {
        log.info({ bin, version: match[1] }, 'Detected Chromium version');
        return match[1];
      }
    } catch {
      // Silently try next candidate — fail-open
    }
  }

  log.info({}, 'Could not detect Chromium version — will use default');
  return null;
}

// ---------------------------------------------------------------------------
// User-Agent helpers
// ---------------------------------------------------------------------------

/**
 * Extract major version number from a full version string like "125.0.6422.60".
 * Falls back to DEFAULT_MAJOR on parse failure.
 */
function parseMajor(version: string | null): string {
  if (!version) return DEFAULT_MAJOR;
  const major = version.split('.')[0];
  return major && /^\d+$/.test(major) ? major : DEFAULT_MAJOR;
}

/**
 * Build a Mozilla/5.0 User-Agent string modelled on Kimi K2's browser_guard.py.
 *
 * @param version - Full Chrome version string (e.g. "125.0.6422.60") or null.
 * @param locale  - Locale string embedded in the UA (e.g. "en-US"). Defaults to "en-US".
 * @returns UA string like:
 *   "Mozilla/5.0 (X11; Linux x86_64; en-US) AppleWebKit/537.36 (KHTML, like Gecko)
 *    Chrome/125.0.6422.60 Safari/537.36"
 */
export function buildUserAgent(version: string | null, locale = 'en-US'): string {
  const safeVersion = version ?? DEFAULT_VERSION;
  const safeLocale =
    typeof locale === 'string' && locale.trim().length > 0 ? locale.trim() : 'en-US';

  return (
    `Mozilla/5.0 (X11; Linux x86_64; ${safeLocale}) ` +
    `AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${safeVersion} Safari/537.36`
  );
}

/**
 * Build UA-Client-Hints HTTP headers for the given Chrome version.
 * These prevent discrepancies between navigator.userAgent and the CH headers
 * that bot detectors inspect.
 *
 * @param version - Full Chrome version string or null (falls back to DEFAULT_VERSION).
 * @returns Object with Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Mobile headers.
 */
export function buildClientHintsHeaders(version: string | null): Record<string, string> {
  const major = parseMajor(version);

  return {
    'Sec-CH-UA': `"Not A(Brand)";v="99", "Chromium";v="${major}", "Google Chrome";v="${major}"`,
    'Sec-CH-UA-Platform': '"Linux"',
    'Sec-CH-UA-Mobile': '?0',
  };
}
