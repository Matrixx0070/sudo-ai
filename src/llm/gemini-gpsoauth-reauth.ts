/**
 * @file gemini-gpsoauth-reauth.ts
 * @description Browserless re-auth for the Gemini web lane: when the persisted
 * __Secure-1PSID dies, re-mint a fresh Google web-session cookie jar from the durable
 * gpsoauth master token — no browser, no human. Wired as the session manager's reauth
 * hook (see getGeminiWebSessionManager). No-op (returns null) when no seed exists.
 *
 * The seed (data/gemini-gpsoauth-seed.json, 0600, gitignored) holds a master token that
 * was obtained once from a real human sign-in; this never defeats any anti-bot challenge.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';

const log = createLogger('llm:gemini-gpsoauth-reauth');

const DEFAULT_SEED = path.join(DATA_DIR, 'gemini-gpsoauth-seed.json');
// Resolve the python mint relative to this module (cwd-independent): src/llm -> scripts/.
const MINT_SCRIPT = fileURLToPath(new URL('../../scripts/gemini-web/gpsoauth_mint.py', import.meta.url));

/**
 * Re-mint gemini.google.com cookies via the gpsoauth master token. Returns the fresh
 * google cookie map (must contain __Secure-1PSID), or null if no seed / the mint failed.
 * Secrets are never logged; the minted cookies land only in a 0600 temp file, deleted here.
 */
export async function mintGeminiCookiesViaGpsoauth(
  seedFile: string = DEFAULT_SEED,
): Promise<Record<string, string> | null> {
  if (!existsSync(seedFile)) {
    log.debug('no gpsoauth seed — skipping browserless reauth');
    return null;
  }
  const out = path.join(tmpdir(), `gemini-gpsoauth-cookies-${process.pid}-${Date.now()}.json`);
  try {
    const r = spawnSync('python3', [MINT_SCRIPT, seedFile, out], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status !== 0) {
      log.warn({ code: r.status, stderr: (r.stderr?.toString() || '').slice(0, 200) }, 'gpsoauth mint failed');
      return null;
    }
    const parsed = JSON.parse(readFileSync(out, 'utf8')) as { cookies?: Record<string, string> };
    const cookies = parsed.cookies;
    if (!cookies?.['__Secure-1PSID']) {
      log.warn('gpsoauth mint produced no __Secure-1PSID');
      return null;
    }
    log.info({ cookieCount: Object.keys(cookies).length }, 'gpsoauth browserless mint OK');
    return cookies;
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'gpsoauth mint output unreadable');
    return null;
  } finally {
    rmSync(out, { force: true });
  }
}
