/**
 * @file browser-verify.ts
 * @description Task-end verification for BROWSER work.
 *
 * SelfVerify (self-verify.ts) is a CODE verifier — its checks (files modified,
 * diff, tests, goal alignment) are structured around code changes, so it abstains
 * on a browser task (no files change). That leaves the browser dimension
 * unverified: a turn can END while the active page is still stuck on a CAPTCHA /
 * bot-wall or an error page — i.e. the task did not actually complete.
 *
 * This fills that gap with a cheap, observable-only check at task end: if there is
 * a live browser session and its active page shows an unresolved blocker, surface
 * a note. It NEVER alters the agent's final response. Opt-in SUDO_BROWSER_VERIFY=1,
 * fail-open (any error → treated as "nothing to verify").
 */

/** Enabled only under SUDO_BROWSER_VERIFY=1 (default off → zero overhead). */
export function isBrowserVerifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_BROWSER_VERIFY'] === '1';
}

/** Snapshot of the active page's completion-relevant state. */
export interface BrowserProbe {
  url: string;
  /** Names of CAPTCHA / bot-wall signatures currently present. */
  captchas: string[];
}

export type ProbeFn = () => Promise<BrowserProbe | null>;

export interface BrowserVerifyResult {
  ok: boolean;
  /** Present when ok === false — an observable note describing the unresolved blocker. */
  note?: string;
}

/**
 * Verify a browser task actually completed. Returns null when there is no browser
 * session to verify (the common case — most turns are not browser turns).
 */
export async function verifyBrowserTaskCompletion(probe: ProbeFn = defaultProbe): Promise<BrowserVerifyResult | null> {
  let state: BrowserProbe | null;
  try {
    state = await probe();
  } catch {
    return null; // fail-open: nothing to verify
  }
  if (!state) return null;

  const problems: string[] = [];
  if (state.captchas.length > 0) problems.push(`an unresolved ${state.captchas.join(', ')} challenge`);
  if (state.url.startsWith('chrome-error://')) problems.push('an error page');

  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    note:
      `[BROWSER VERIFY] The turn ended with ${problems.join(' and ')} on ${state.url}. ` +
      `The browser task likely did NOT complete — a bot-wall/error was left unresolved.`,
  };
}

/** Default probe: inspect the live 'default' browser session, if any. */
async function defaultProbe(): Promise<BrowserProbe | null> {
  const { BrowserManager } = await import('../tools/builtin/browser/browser-manager.js');
  const inst = BrowserManager.getInstance().get('default');
  if (!inst) return null; // no browser session → nothing to verify

  const { resolveActivePage } = await import('../tools/builtin/browser/active-page.js');
  const { detectCaptchas } = await import('../tools/builtin/browser/captcha.js');
  const page = await resolveActivePage(inst);
  const caps = await detectCaptchas(page);
  return { url: page.url(), captchas: caps.map((c) => c.name) };
}
