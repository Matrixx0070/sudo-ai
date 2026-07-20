/**
 * @file grok.ts
 * @description `sudo-ai grok` — unified provider-management view across the two
 * independent Grok providers (GP5). Shows both methods' auth status, credential
 * source, current default model, and billing semantics side by side, plus which
 * (if any) is ready to serve. Read-only; never prints credential material.
 */

interface ProviderView {
  provider: string;
  label: string;
  connected: boolean;
  detail: string;
  defaultModel: string | null;
  modelsCount: number;
  billing: string;
}

/** Build both provider views (pure — testable without console). */
export async function collectGrokProviders(): Promise<ProviderView[]> {
  const { getXaiOAuthManager } = await import('../../llm/xai-oauth-manager.js');
  const { getXaiApiKeyManager } = await import('../../llm/xai-apikey-manager.js');

  const oauthMgr = getXaiOAuthManager();
  const oauth = oauthMgr.status();
  const oauthDetail = oauth.needsRelogin
    ? 'needs re-login (`sudo-ai xai-oauth login`)'
    : oauth.connected
      ? `token valid until ${oauth.expiresAt ?? '?'}`
      : 'not connected (`sudo-ai xai-oauth login`)';

  const apiMgr = getXaiApiKeyManager();
  const api = apiMgr.status();
  const apiDetail = api.connected
    ? `key from ${api.source === 'store' ? 'store (data/xai-apikey.json)' : 'XAI_API_KEY env'}`
    : 'no key set (`sudo-ai xai apikey set`)';

  return [
    {
      provider: 'xai-oauth',
      label: 'Sign in with Grok (subscription)',
      connected: oauth.connected,
      detail: oauthDetail,
      defaultModel: oauthMgr.getDefaultModel(),
      modelsCount: oauthMgr.listModels().length,
      billing: 'subscription-covered (Grok seat)',
    },
    {
      provider: 'xai',
      label: 'Grok API Key (metered)',
      connected: api.connected,
      detail: apiDetail,
      defaultModel: apiMgr.getDefaultModel(),
      modelsCount: api.modelsCount,
      billing: 'pay-per-token (api.x.ai)',
    },
  ];
}

export async function runGrokStatus(): Promise<number> {
  const views = await collectGrokProviders();
  console.log('');
  console.log('  Grok providers (two independent methods — creds, models, and billing are separate):');
  console.log('');
  for (const v of views) {
    console.log(`  ${v.connected ? '●' : '○'} ${v.provider}  —  ${v.label}`);
    console.log(`      status:   ${v.connected ? 'ready' : 'not configured'} (${v.detail})`);
    console.log(`      default:  ${v.defaultModel ?? '(none — run `models` then `set-model`)'}`);
    console.log(`      models:   ${v.modelsCount} cached`);
    console.log(`      billing:  ${v.billing}`);
    console.log('');
  }
  const ready = views.filter((v) => v.connected).map((v) => v.provider);
  console.log(
    ready.length === 0
      ? '  No Grok provider is configured yet. Start with `sudo-ai xai-oauth login` or `sudo-ai xai apikey set`.'
      : `  Ready: ${ready.join(', ')}. (Enabling a Grok model in the failover chain is a separate operator decision.)`,
  );
  console.log('');
  // Exit 0 when at least one provider is ready.
  return ready.length > 0 ? 0 : 1;
}
