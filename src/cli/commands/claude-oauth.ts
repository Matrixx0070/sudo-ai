/**
 * @file claude-oauth.ts
 * @description `sudo-ai claude-oauth` — manage Claude.ai subscription OAuth.
 *
 * Subcommands:
 *   login       Run the PKCE OAuth flow (prints authorize URL, waits for
 *               the user to paste the code from console.anthropic.com).
 *   status      Show whether sudo-ai has a usable token and when it expires.
 *   refresh     Force a token refresh now.
 *   disconnect  Wipe the stored credentials.
 */

import readline from 'node:readline';

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

function formatExpiry(expiresInSec: number | null): string {
  if (expiresInSec === null) return 'n/a';
  if (expiresInSec <= 0) return 'expired';
  const h = Math.floor(expiresInSec / 3600);
  const m = Math.floor((expiresInSec % 3600) / 60);
  return `${h}h ${m}m`;
}

export async function runClaudeOAuthLogin(): Promise<number> {
  const { getClaudeOAuthManager } = await import('../../core/brain/claude-oauth-manager.js');
  const mgr = getClaudeOAuthManager();

  const pending = mgr.startLogin();

  console.log('');
  console.log('  Open this URL in your browser, approve the request, then');
  console.log('  copy the authorization code shown on the callback page:');
  console.log('');
  console.log(`    ${pending.authorizeUrl}`);
  console.log('');

  const code = await prompt('Paste the authorization code here: ');
  if (!code) {
    console.error('No code entered — login cancelled.');
    mgr.cancelLogin();
    return 1;
  }

  try {
    const creds = await mgr.completeLogin(code);
    const expiresInMin = Math.round((creds.expiresAt - Date.now()) / 60_000);
    console.log('');
    console.log(`  Connected. Token valid for ${expiresInMin} min, scopes: ${creds.scopes.join(' ')}`);
    if (creds.subscriptionType) {
      console.log(`  Subscription: ${creds.subscriptionType}`);
    }
    console.log('');
    console.log('  The brain router can now use models prefixed with "claude-oauth/",');
    console.log('  e.g. claude-oauth/claude-sonnet-4-5. Restart sudo-ai for the new');
    console.log('  provider to load (or it will pick up on next initProviders()).');
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Login failed: ${msg}`);
    return 1;
  }
}

export async function runClaudeOAuthStatus(): Promise<number> {
  const { getClaudeOAuthManager } = await import('../../core/brain/claude-oauth-manager.js');
  const mgr = getClaudeOAuthManager();
  const s = mgr.getStatus();
  console.log('');
  console.log(`  Connected:     ${s.connected ? 'yes' : 'no'}`);
  console.log(`  Store:         ${s.storePath}`);
  if (s.connected) {
    console.log(`  Expires in:    ${formatExpiry(s.expiresInSec)}`);
    console.log(`  Scopes:        ${s.scopes.join(' ')}`);
    if (s.subscriptionType) console.log(`  Subscription:  ${s.subscriptionType}`);
  }
  console.log('');
  return s.connected ? 0 : 1;
}

export async function runClaudeOAuthRefresh(): Promise<number> {
  const { getClaudeOAuthManager } = await import('../../core/brain/claude-oauth-manager.js');
  const mgr = getClaudeOAuthManager();
  if (!mgr.isAvailable()) {
    console.error('Not connected — run `sudo-ai claude-oauth login` first.');
    return 1;
  }
  const ok = await mgr.refreshToken();
  console.log(ok ? 'Refreshed.' : 'Refresh failed.');
  return ok ? 0 : 1;
}

export async function runClaudeOAuthDisconnect(): Promise<number> {
  const { getClaudeOAuthManager } = await import('../../core/brain/claude-oauth-manager.js');
  const mgr = getClaudeOAuthManager();
  mgr.disconnect();
  console.log('Disconnected — local credentials wiped.');
  return 0;
}
