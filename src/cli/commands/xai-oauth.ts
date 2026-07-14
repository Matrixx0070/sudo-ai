/**
 * @file xai-oauth.ts
 * @description `sudo-ai xai-oauth` — manage the xAI subscription OAuth
 * (device flow) connection. Mirrors the claude-oauth subcommand shape.
 *
 * Subcommands:
 *   login   Run the device flow (prints verification URL + user code, waits
 *           for approval, persists tokens 0600 to <DATA_DIR>/xai-oauth.json).
 *   status  Show whether sudo-ai has a usable xAI OAuth token (no token
 *           material is ever printed).
 */

export async function runXaiOAuthLogin(): Promise<number> {
  const { getXaiOAuthManager } = await import('../../llm/xai-oauth-manager.js');
  const mgr = getXaiOAuthManager();
  try {
    await mgr.deviceLogin({
      onCode: (url, code) => {
        console.log('');
        console.log(`  Open:  ${url}`);
        console.log(`  Code:  ${code}`);
        console.log('');
        console.log('  Waiting for approval (up to 15 min)...');
      },
    });
    console.log('');
    console.log('  Connected — xAI OAuth tokens stored.');
    return 0;
  } catch (err) {
    console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function runXaiOAuthStatus(): Promise<number> {
  const { getXaiOAuthManager } = await import('../../llm/xai-oauth-manager.js');
  const s = getXaiOAuthManager().status();
  console.log('');
  console.log(`  Connected:      ${s.connected ? 'yes' : 'no'}`);
  if (s.expiresAt) console.log(`  Expires at:     ${s.expiresAt}`);
  if (s.needsRelogin) console.log('  Needs re-login: yes — run `sudo-ai xai-oauth login`');
  console.log('');
  return s.connected ? 0 : 1;
}
