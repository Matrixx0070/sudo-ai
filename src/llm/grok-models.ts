/**
 * @file grok-models.ts
 * @description Subscription-free Grok model catalog + rate limits on the
 * user's grok.com web session — cookie-only, statsig-FREE (proven live
 * 2026-07-21), never the metered api.x.ai path:
 *   * catalog     -> POST grok.com/rest/models       {"locale":"en"}
 *   * rate limits -> POST grok.com/rest/rate-limits  {"requestKind","modelName"}
 *
 * Reuses GW3 (session manager) behind the shared `SUDO_GROK_WEBSESSION` flag
 * (default OFF). Secrets never logged; callers get catalog/limit data back —
 * never cookie material. No Playwright, no statsig oracle needed.
 */

import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import {
  callGrokModelsBridge,
  type GrokCatalogModel,
  type GrokModelDefaults,
} from './grok-models-bridge.js';
import type { GrokWebCreds } from './grok-web-bridge.js';
import { isGrokWebSessionEnabled, GrokWebDisabledError } from './grok-web-media.js';

const log = createLogger('llm:grok-models');

export interface GrokModelsDeps {
  manager: GrokWebSessionManager;
  bridge: typeof callGrokModelsBridge;
}

export interface GrokModelCatalog {
  models: GrokCatalogModel[];
  unavailableModels: GrokCatalogModel[];
  defaults: GrokModelDefaults;
}

export interface GrokRateLimits {
  modelName: string;
  requestKind: string;
  windowSizeSeconds: number;
  remainingQueries: number;
  totalQueries: number;
  lowEffortRateLimits: unknown;
  highEffortRateLimits: unknown;
}

function defaultDeps(): GrokModelsDeps {
  return { manager: getGrokWebSessionManager(), bridge: callGrokModelsBridge };
}

function credsOf(session: { cookie: string; userAgent: string }): GrokWebCreds {
  return { cookie: session.cookie, userAgent: session.userAgent };
}

/** Ensure the feature is on + the session is healthy (refreshing if needed). */
async function ready(deps: GrokModelsDeps): Promise<{ cookie: string; userAgent: string }> {
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
  return deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
}

/**
 * Fetch the seat's model catalog (available + unavailable models and the
 * free/pro/heavy/anon tier defaults). Free, browserless, statsig-free.
 */
export async function getGrokModelCatalog(
  opts: { locale?: string; deps?: GrokModelsDeps } = {},
): Promise<GrokModelCatalog> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);

  const r = await deps.bridge(
    { op: 'models', ...(opts.locale ? { locale: opts.locale } : {}) },
    credsOf(session),
  );
  if (!r.ok || !r.models || !r.defaults) {
    throw new Error(
      `Grok model catalog failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`,
    );
  }
  log.info(
    { models: r.models.length, unavailable: r.unavailableModels?.length ?? 0 },
    'grok model catalog fetched',
  );
  return {
    models: r.models,
    unavailableModels: r.unavailableModels ?? [],
    defaults: r.defaults,
  };
}

/**
 * Fetch remaining/total query windows for one model on the seat. Free,
 * browserless, statsig-free.
 */
export async function getGrokRateLimits(
  modelName: string,
  opts: { requestKind?: string; deps?: GrokModelsDeps } = {},
): Promise<GrokRateLimits> {
  const trimmed = (modelName ?? '').trim();
  if (!trimmed) throw new TypeError('getGrokRateLimits: modelName must be a non-empty string');
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);

  const r = await deps.bridge(
    {
      op: 'rate_limits',
      modelName: trimmed,
      ...(opts.requestKind ? { requestKind: opts.requestKind } : {}),
    },
    credsOf(session),
  );
  if (!r.ok || typeof r.remainingQueries !== 'number') {
    throw new Error(
      `Grok rate limits failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`,
    );
  }
  log.info(
    { modelName: trimmed, remaining: r.remainingQueries, total: r.totalQueries },
    'grok rate limits fetched',
  );
  return {
    modelName: trimmed,
    requestKind: r.requestKind ?? opts.requestKind ?? 'DEFAULT',
    windowSizeSeconds: r.windowSizeSeconds ?? 0,
    remainingQueries: r.remainingQueries,
    totalQueries: r.totalQueries ?? 0,
    lowEffortRateLimits: r.lowEffortRateLimits ?? null,
    highEffortRateLimits: r.highEffortRateLimits ?? null,
  };
}

export { GrokWebReloginRequiredError, GrokWebDisabledError, isGrokWebSessionEnabled };
