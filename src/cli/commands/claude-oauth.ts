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

export async function runClaudeOAuthModels(refresh: boolean): Promise<number> {
  const { getClaudeOAuthManager } = await import('../../core/brain/claude-oauth-manager.js');
  const mgr = getClaudeOAuthManager();
  if (!mgr.isAvailable()) {
    console.error('Not connected — run `sudo-ai claude-oauth login` first.');
    return 1;
  }

  let models;
  try {
    models = refresh ? await mgr.refreshModels() : await mgr.getModelsLazy();
  } catch (err) {
    console.error(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (models.length === 0) {
    console.log('No models returned. Try `sudo-ai claude-oauth models --refresh`.');
    return 1;
  }

  const def = mgr.getDefaultModel();
  console.log('');
  console.log(`  Brain model string format: claude-oauth/<id>`);
  console.log(`  Default model: ${def ?? '(none)'}`);
  console.log('');
  // Pad columns for readable plain-text output.
  const idWidth = Math.max(...models.map((m) => m.id.length), 'MODEL ID'.length);
  const nameWidth = Math.max(...models.map((m) => m.displayName.length), 'DISPLAY NAME'.length);
  console.log(
    `  ${''.padEnd(2)} ${'MODEL ID'.padEnd(idWidth)}  ${'DISPLAY NAME'.padEnd(nameWidth)}  CREATED`,
  );
  console.log(`  ${''.padEnd(2)} ${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ----------`);
  for (const m of models) {
    const marker = m.id === def ? '* ' : '  ';
    const date = m.createdAt.slice(0, 10);
    console.log(`  ${marker}${m.id.padEnd(idWidth)}  ${m.displayName.padEnd(nameWidth)}  ${date}`);
  }
  console.log('');
  console.log('  Set a different default with: sudo-ai claude-oauth set-model <id>');
  console.log('');
  return 0;
}

export async function runClaudeOAuthSetModel(id: string): Promise<number> {
  const { getClaudeOAuthManager } = await import('../../core/brain/claude-oauth-manager.js');
  const mgr = getClaudeOAuthManager();
  if (!mgr.isAvailable()) {
    console.error('Not connected — run `sudo-ai claude-oauth login` first.');
    return 1;
  }
  // Refresh the cache so we validate against the live list — avoids the user
  // being stuck on an outdated cache after Anthropic publishes a new model.
  try {
    await mgr.getModelsLazy();
  } catch {
    /* non-fatal — setDefaultModel still works if the id is in the existing cache */
  }
  const ok = mgr.setDefaultModel(id);
  if (!ok) {
    console.error(`"${id}" is not in the cached model list. Run \`sudo-ai claude-oauth models\` to see what's available.`);
    return 1;
  }
  console.log(`Default model set: ${id}`);
  console.log(`Use this brain model string: claude-oauth/${id}`);
  return 0;
}
