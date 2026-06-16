/**
 * One-off helper: drives the production ClaudeOAuthManager against the
 * real <DATA_DIR>/claude-oauth.json store. Two-step because the verifier
 * lives in memory and must survive across assistant turns.
 *
 *   start          → startLogin(), persist pending to /tmp, print URL
 *   complete CODE  → load pending, completeLogin(), then refreshModels()
 *                    + setDefaultModel('claude-opus-4-8'), print status
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { ClaudeOAuthManager, type PendingLogin } from '../src/core/brain/claude-oauth-manager.js';
import { dataPath } from '../src/core/shared/paths.js';

const PENDING_PATH = '/tmp/prod-oauth-pending.json';
const PROD_STORE = dataPath('claude-oauth.json');

async function start(): Promise<void> {
  if (existsSync(PENDING_PATH)) unlinkSync(PENDING_PATH);
  const mgr = new ClaudeOAuthManager(PROD_STORE);
  const pending = mgr.startLogin();
  writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
  console.log('Production store:', PROD_STORE);
  console.log('');
  console.log('AUTHORIZE URL (open in incognito):');
  console.log('');
  console.log(pending.authorizeUrl);
  console.log('');
}

async function complete(rawCode: string): Promise<void> {
  if (!existsSync(PENDING_PATH)) {
    console.error('Missing pending — run "start" first');
    process.exit(1);
  }
  const pending = JSON.parse(readFileSync(PENDING_PATH, 'utf8')) as PendingLogin;
  const mgr = new ClaudeOAuthManager(PROD_STORE);
  (mgr as unknown as { pending: PendingLogin }).pending = pending;

  console.log('completeLogin against', PROD_STORE);
  await mgr.completeLogin(rawCode);

  console.log('refreshModels...');
  const models = await mgr.refreshModels();
  console.log(`  fetched ${models.length} models, newest: ${models[0]?.id}`);

  console.log('setDefaultModel(claude-opus-4-8)...');
  const ok = mgr.setDefaultModel('claude-opus-4-8');
  console.log(`  setDefaultModel returned: ${ok}`);
  console.log(`  defaultModel now: ${mgr.getDefaultModel()}`);

  console.log('');
  console.log('Final status:');
  console.log(JSON.stringify(mgr.getStatus(), null, 2));

  try { unlinkSync(PENDING_PATH); } catch { /* ignore */ }
}

const mode = process.argv[2];
if (mode === 'start') {
  start().catch((e: unknown) => { console.error(e); process.exit(1); });
} else if (mode === 'complete') {
  const code = process.argv[3] ?? '';
  if (!code) { console.error('Usage: prod-oauth-step.ts complete <CODE>'); process.exit(1); }
  complete(code).catch((e: unknown) => { console.error(e); process.exit(1); });
} else {
  console.error('Usage: prod-oauth-step.ts {start | complete <CODE>}');
  process.exit(1);
}
