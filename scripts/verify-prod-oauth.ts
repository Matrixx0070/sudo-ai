/**
 * End-to-end verification of the production ClaudeOAuthManager.
 *
 * Unlike scripts/test-claude-pkce.ts (which used inline fetch to verify the
 * Anthropic protocol), this script drives the real ClaudeOAuthManager class
 * the CLI and admin routes use, against a TEMP credentials store so it does
 * not touch the real <DATA_DIR>/claude-oauth.json.
 *
 *   start          → instantiate the prod manager, call startLogin(),
 *                    persist its pending state to /tmp so a second invocation
 *                    can complete it, print the authorize URL.
 *   complete CODE  → re-instantiate the prod manager, splice the pending
 *                    state back in, call completeLogin(), then exercise
 *                    refreshModels / getDefaultModel / getStatus and print
 *                    the results so we can see the prod paths worked.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { ClaudeOAuthManager, type PendingLogin } from '../src/core/brain/claude-oauth-manager.js';

const PENDING_PATH = '/tmp/verify-prod-pending.json';
const STORE_PATH = '/tmp/verify-prod-store.json';

function newMgr(): ClaudeOAuthManager {
  return new ClaudeOAuthManager(STORE_PATH);
}

async function start(): Promise<void> {
  // Reset prior runs.
  if (existsSync(PENDING_PATH)) unlinkSync(PENDING_PATH);
  if (existsSync(STORE_PATH)) unlinkSync(STORE_PATH);

  const mgr = newMgr();
  const pending = mgr.startLogin();
  writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));

  console.log('');
  console.log('PROD MANAGER startLogin() returned:');
  console.log(`  authorizeUrl: ${pending.authorizeUrl}`);
  console.log(`  redirectUri:  ${pending.redirectUri}`);
  console.log(`  state(len):   ${pending.state.length}`);
  console.log('');
  console.log(`Then run:  npx tsx scripts/verify-prod-oauth.ts complete <PASTED_CODE>`);
}

async function complete(rawCode: string): Promise<void> {
  if (!existsSync(PENDING_PATH)) {
    console.error(`Missing pending state at ${PENDING_PATH} — run "start" first.`);
    process.exit(1);
  }
  const pending = JSON.parse(readFileSync(PENDING_PATH, 'utf8')) as PendingLogin;

  const mgr = newMgr();
  // The prod manager holds `pending` privately in memory; in this two-process
  // verification we splice it back in. The CLI does this in one process, so
  // production never needs the splice — this is purely so verification can
  // span two assistant turns.
  (mgr as unknown as { pending: PendingLogin }).pending = pending;

  console.log('Calling prod ClaudeOAuthManager.completeLogin()...');
  let creds;
  try {
    creds = await mgr.completeLogin(rawCode);
  } catch (err) {
    console.error('completeLogin threw:', err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  console.log('');
  console.log('completeLogin() success:');
  console.log(`  access_token prefix:  ${creds.accessToken.substring(0, 14)}...  len=${creds.accessToken.length}`);
  console.log(`  refresh_token prefix: ${creds.refreshToken.substring(0, 14)}...  len=${creds.refreshToken.length}`);
  console.log(`  expires in min:       ${Math.round((creds.expiresAt - Date.now()) / 60_000)}`);
  console.log(`  scopes:               ${creds.scopes.join(' ')}`);
  console.log(`  subscriptionType:     ${creds.subscriptionType ?? '(none returned)'}`);

  console.log('');
  console.log('Reading back via getStatus()...');
  console.log(JSON.stringify(mgr.getStatus(), null, 2));

  console.log('');
  console.log('Calling refreshModels() (live /v1/models)...');
  let models;
  try {
    models = await mgr.refreshModels();
  } catch (err) {
    console.error('refreshModels threw:', err instanceof Error ? err.message : String(err));
    process.exit(3);
  }
  console.log(`Got ${models.length} models. Newest 3:`);
  for (const m of models.slice(0, 3)) {
    console.log(`  ${m.id.padEnd(36)}  ${m.displayName.padEnd(28)}  ${m.createdAt.slice(0, 10)}`);
  }

  console.log('');
  console.log(`getDefaultModel() (auto-resolved):  ${mgr.getDefaultModel()}`);

  console.log('');
  console.log('Calling setDefaultModel("claude-opus-4-8")...');
  const setOk = mgr.setDefaultModel('claude-opus-4-8');
  console.log(`  setDefaultModel returned: ${setOk}`);
  console.log(`  getDefaultModel() now:    ${mgr.getDefaultModel()}`);

  console.log('');
  console.log('Status after picking default:');
  console.log(JSON.stringify(mgr.getStatus(), null, 2));

  console.log('');
  console.log('Re-instantiating a fresh manager from disk to verify persistence...');
  const mgr2 = newMgr();
  console.log(`  isAvailable:        ${mgr2.isAvailable()}`);
  console.log(`  getDefaultModel:    ${mgr2.getDefaultModel()}`);
  console.log(`  listModels count:   ${mgr2.listModels().length}`);
  console.log(`  status:             ${JSON.stringify(mgr2.getStatus())}`);

  // Cleanup
  try { unlinkSync(PENDING_PATH); } catch { /* ignore */ }
  console.log('');
  console.log('Verification complete. Temp store left at', STORE_PATH, 'for inspection.');
}

const mode = process.argv[2];
if (mode === 'start') {
  start().catch((e: unknown) => { console.error(e); process.exit(1); });
} else if (mode === 'complete') {
  const code = process.argv[3] ?? '';
  if (!code) {
    console.error('Usage: npx tsx scripts/verify-prod-oauth.ts complete <CODE>');
    process.exit(1);
  }
  complete(code).catch((e: unknown) => { console.error(e); process.exit(1); });
} else {
  console.error('Usage: npx tsx scripts/verify-prod-oauth.ts {start | complete <CODE>}');
  process.exit(1);
}
