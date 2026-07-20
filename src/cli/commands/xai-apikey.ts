/**
 * @file xai-apikey.ts
 * @description `sudo-ai xai apikey` — manage the metered xAI API-key provider
 * (`xai`), independent of the subscription OAuth path. Mirrors the claude-oauth
 * / xai-oauth picker shape: set the key, list live models, pick a default.
 *
 * Subcommands:
 *   set        Prompt for an xAI API key (console.x.ai → API Keys), validate it
 *              by listing models live, then store it 0600 (data/xai-apikey.json).
 *   status     Show whether a key is set + the active default model.
 *   models     List the account's live models (from api.x.ai/v1/models).
 *   set-model  Pick the default `xai` model.
 *   disconnect Wipe the stored key (a XAI_API_KEY env key, if any, is kept).
 */

import readline from 'node:readline';

async function promptHidden(question: string): Promise<string> {
  // API keys are secrets — read without echoing to the terminal.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = process.stdout;
  const onData = (): void => {
    // Overwrite the just-typed char with nothing (mute echo).
    readline.clearLine(out, 0);
    readline.cursorTo(out, 0);
    out.write(question);
  };
  try {
    return await new Promise<string>((resolve) => {
      process.stdin.on('data', onData);
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    process.stdin.off('data', onData);
    rl.close();
    out.write('\n');
  }
}

export async function runXaiApiKeySet(): Promise<number> {
  const { getXaiApiKeyManager } = await import('../../llm/xai-apikey-manager.js');
  const { getXaiModelDiscovery } = await import('../../llm/xai-models.js');
  const mgr = getXaiApiKeyManager();

  const key = await promptHidden('Paste your xAI API key (console.x.ai → API Keys): ');
  if (!key) {
    console.error('No key entered — cancelled.');
    return 1;
  }
  // Persist first so the discovery credential seam can read it, then validate
  // by a live model list. On validation failure the key stays (the user may be
  // offline); we warn rather than discard.
  mgr.setApiKey(key);
  try {
    const models = await getXaiModelDiscovery().refresh('apikey');
    mgr.setModels(models);
    console.log('');
    console.log(`  Key stored (data/xai-apikey.json, 0600) — ${models.length} model(s) discovered.`);
    console.log('  These are METERED (pay-per-token) via api.x.ai.');
    console.log('  Pick a default with: sudo-ai xai apikey set-model <id>');
    console.log('');
    return 0;
  } catch (err) {
    console.log('');
    console.log('  Key stored, but a live model list could not be fetched:');
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    console.log('  Verify the key at console.x.ai, then run `sudo-ai xai apikey models`.');
    console.log('');
    return 0;
  }
}

export async function runXaiApiKeyStatus(): Promise<number> {
  const { getXaiApiKeyManager } = await import('../../llm/xai-apikey-manager.js');
  const s = getXaiApiKeyManager().status();
  console.log('');
  console.log(`  Connected:      ${s.connected ? 'yes' : 'no'}`);
  if (s.source) console.log(`  Key source:     ${s.source === 'store' ? 'stored (data/xai-apikey.json)' : 'XAI_API_KEY env'}`);
  console.log(`  Default model:  ${s.defaultModel ?? '(none)'}`);
  console.log(`  Cached models:  ${s.modelsCount}`);
  console.log('  Billing:        metered (pay-per-token via api.x.ai)');
  console.log('');
  return s.connected ? 0 : 1;
}

export async function runXaiApiKeyModels(refresh: boolean): Promise<number> {
  const { getXaiApiKeyManager } = await import('../../llm/xai-apikey-manager.js');
  const { XaiNotConnectedError } = await import('../../llm/xai-models.js');
  const { getModelsForDisplay, printModelsTable } = await import('./xai-picker-shared.js');
  const mgr = getXaiApiKeyManager();
  if (!mgr.status().connected) {
    console.error('No API key set — run `sudo-ai xai apikey set` first.');
    return 1;
  }
  try {
    const { models, live } = await getModelsForDisplay('apikey', mgr, refresh);
    if (models.length === 0) {
      console.log('No models returned. Try `sudo-ai xai apikey models --refresh`.');
      return 1;
    }
    printModelsTable(models, mgr.getDefaultModel(), 'xai');
    console.log(`  Source: ${live ? 'live (api.x.ai)' : 'cached — use --refresh for live'}`);
    console.log('  All models above are METERED (pay-per-token).');
    console.log('  Set a default with: sudo-ai xai apikey set-model <id>');
    console.log('');
    return 0;
  } catch (err) {
    if (err instanceof XaiNotConnectedError) {
      console.error(err.message);
      return 1;
    }
    console.error(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function runXaiApiKeySetModel(id: string): Promise<number> {
  const { getXaiApiKeyManager } = await import('../../llm/xai-apikey-manager.js');
  const { getModelsForDisplay } = await import('./xai-picker-shared.js');
  const mgr = getXaiApiKeyManager();
  if (!mgr.status().connected) {
    console.error('No API key set — run `sudo-ai xai apikey set` first.');
    return 1;
  }
  try {
    await getModelsForDisplay('apikey', mgr, true);
  } catch {
    /* non-fatal — validate against the existing cache */
  }
  if (!mgr.setDefaultModel(id)) {
    console.error(`"${id}" is not in the model list. Run \`sudo-ai xai apikey models\` to see what's available.`);
    return 1;
  }
  console.log(`Default model set: ${id}`);
  console.log(`Use this brain model string: xai/${id}`);
  return 0;
}

export async function runXaiApiKeyDisconnect(): Promise<number> {
  const { getXaiApiKeyManager } = await import('../../llm/xai-apikey-manager.js');
  getXaiApiKeyManager().disconnect();
  console.log('Disconnected — stored xAI API key wiped (XAI_API_KEY env, if set, is kept).');
  return 0;
}
