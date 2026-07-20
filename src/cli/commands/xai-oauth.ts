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

export async function runXaiOAuthModels(refresh: boolean): Promise<number> {
  const { getXaiOAuthManager } = await import('../../llm/xai-oauth-manager.js');
  const { XaiNotConnectedError } = await import('../../llm/xai-models.js');
  const { getModelsForDisplay, printModelsTable } = await import('./xai-picker-shared.js');
  const mgr = getXaiOAuthManager();
  if (!mgr.status().connected) {
    console.error('Not connected — run `sudo-ai xai-oauth login` first.');
    return 1;
  }
  try {
    const { models, live } = await getModelsForDisplay('oauth', mgr, refresh);
    if (models.length === 0) {
      console.log('No models returned. Try `sudo-ai xai-oauth models --refresh`.');
      return 1;
    }
    printModelsTable(models, mgr.getDefaultModel(), 'xai-oauth');
    console.log(`  Source: ${live ? 'live (cli-chat-proxy.grok.com)' : 'cached — use --refresh for live'}`);
    console.log('  All models above are subscription-covered (billed to your Grok seat, not per-token).');
    console.log('  Set a default with: sudo-ai xai-oauth set-model <id>');
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

export async function runXaiOAuthSetModel(id: string): Promise<number> {
  const { getXaiOAuthManager } = await import('../../llm/xai-oauth-manager.js');
  const { getModelsForDisplay } = await import('./xai-picker-shared.js');
  const mgr = getXaiOAuthManager();
  if (!mgr.status().connected) {
    console.error('Not connected — run `sudo-ai xai-oauth login` first.');
    return 1;
  }
  // Validate against the LIVE list (avoids being stuck on a stale cache).
  try {
    await getModelsForDisplay('oauth', mgr, true);
  } catch {
    /* non-fatal — setDefaultModel still validates against the existing cache */
  }
  if (!mgr.setDefaultModel(id)) {
    console.error(`"${id}" is not in the model list. Run \`sudo-ai xai-oauth models\` to see what's available.`);
    return 1;
  }
  console.log(`Default model set: ${id}`);
  console.log(`Use this brain model string: xai-oauth/${id}`);
  return 0;
}
