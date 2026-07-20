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
      billing: 'pay-per-token (metered xAI API)',
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

// ---------------------------------------------------------------------------
// GW5 — subscription-free web-session media (image primary / video best-effort)
// ---------------------------------------------------------------------------

/** `sudo-ai grok image "<prompt>"` — generate on the Grok subscription (free). */
export async function runGrokImage(
  prompt: string,
  opts: { aspect?: string; num?: number; pro?: boolean } = {},
): Promise<number> {
  const media = await import('../../llm/grok-web-media.js');
  try {
    const genOpts: { aspectRatio?: string; numGenerations?: number; pro?: boolean } = {};
    if (opts.aspect) genOpts.aspectRatio = opts.aspect;
    if (opts.num) genOpts.numGenerations = opts.num;
    if (opts.pro) genOpts.pro = opts.pro;
    const r = await media.generateGrokImage(prompt, genOpts);
    console.log('');
    console.log(`  Generated ${r.files.length} image(s) on your Grok subscription (no metered spend):`);
    for (const f of r.files) console.log(`    ${f}`);
    if (r.url) console.log(`  URL: ${r.url}`);
    console.log('');
    return 0;
  } catch (err) {
    return reportMediaError(err);
  }
}

/** `sudo-ai grok video "<prompt>"` — best-effort image→video on the subscription. */
export async function runGrokVideo(
  prompt: string,
  opts: { aspect?: string; length?: number; res?: string } = {},
): Promise<number> {
  const media = await import('../../llm/grok-web-media.js');
  try {
    const genOpts: { aspectRatio?: string; videoLength?: number; resolutionName?: string } = {};
    if (opts.aspect) genOpts.aspectRatio = opts.aspect;
    if (opts.length) genOpts.videoLength = opts.length;
    if (opts.res) genOpts.resolutionName = opts.res;
    const r = await media.generateGrokVideo(prompt, genOpts);
    console.log('');
    console.log('  Generated a video on your Grok subscription (no metered spend):');
    console.log(`    ${r.videoUrl}`);
    if (r.thumbnailUrl) console.log(`    thumbnail: ${r.thumbnailUrl}`);
    console.log('');
    return 0;
  } catch (err) {
    return reportMediaError(err);
  }
}

/** `sudo-ai grok websession status` — capture health without printing secrets. */
export async function runGrokWebsessionStatus(): Promise<number> {
  const { getGrokWebSessionManager } = await import('../../llm/grok-web-session-manager.js');
  const { isGrokWebSessionEnabled } = await import('../../llm/grok-web-media.js');
  const st = getGrokWebSessionManager().status();
  console.log('');
  console.log('  Grok web-session (subscription-free image/video):');
  console.log(`    flag:      SUDO_GROK_WEBSESSION=${isGrokWebSessionEnabled() ? 'on' : 'off (default)'}`);
  console.log(`    captured:  ${st.connected ? `yes (${st.capturedAt ?? '?'})` : st.needsRelogin ? 'needs re-login' : 'no'}`);
  console.log(`    video:     ${st.hasStatsig ? 'statsig present (video ready)' : 'no statsig (image only; video best-effort)'}`);
  console.log('');
  return st.connected ? 0 : 1;
}

function reportMediaError(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${msg}\n`);
  return 1;
}
