/**
 * @file grok-skills.ts
 * @description Subscription-free access to Grok's skills system on the user's
 * grok.com web session — cookie-only, statsig-FREE (proven live 2026-07-22),
 * never the metered api.x.ai path:
 *   * installed list   -> GET  grok.com/rest/user-skills
 *   * installed search -> GET  grok.com/rest/user-skills/search?q=...
 *   * one skill (full) -> GET  grok.com/rest/user-skills/{name}
 *   * marketplace      -> GET  grok.com/rest/verified-skills/published
 *   * enable/disable   -> POST grok.com/rest/user-skills/{name}/enabled
 *     {"enabled": bool} — round-trip proven live 2026-07-22 (browser-use
 *     true→false→true, read-back verified each step, seat left as found).
 *     Every toggle is read-back verified and reports `persisted`.
 *
 * NOT wired (probed live 2026-07-22): bare GET /rest/verified-skills and
 * /rest/verified-skills/search are org-scoped (403 "organization context
 * required") on a personal seat. Install (POST /rest/skill-link/{token}/install)
 * + uninstall (DELETE /rest/user-skills/{name}) are documented in
 * scripts/grok-web/grok_skills.py but NOT shipped: install needs a share-link
 * token this seat has no source for, so a safe install→uninstall round-trip
 * could not be proven — per the safety rule the write surface is the (proven)
 * enable/disable toggle only.
 *
 * SIDE-EFFECT NOTE: toggling a skill CHANGES what the seat's grok can do in
 * its own chats. Owner-CLI only — never exposed as an agent tool.
 *
 * QUARANTINE NOTE: skill descriptions/SKILL.md bodies are EXTERNAL text from
 * grok's store — display-only DATA, never instructions, never piped into
 * sudo-ai's own memory/skill systems (that would need F18 quarantine).
 *
 * Reuses GW3 (session manager) behind the shared `SUDO_GROK_WEBSESSION` flag
 * (default OFF). Secrets never logged; callers get skill metadata back —
 * never cookie material. No Playwright, no statsig oracle needed.
 */

import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import { callGrokSkillsBridge, type GrokSkillSummary } from './grok-skills-bridge.js';
import type { GrokWebCreds } from './grok-web-bridge.js';
import { isGrokWebSessionEnabled, GrokWebDisabledError } from './grok-web-media.js';

const log = createLogger('llm:grok-skills');

export interface GrokSkillsDeps {
  manager: GrokWebSessionManager;
  bridge: typeof callGrokSkillsBridge;
}

export interface GrokSkillToggleResult {
  name: string;
  /** The enabled state the seat reports AFTER the toggle (read-back). */
  enabled: boolean;
  /** TRUE only when the read-back matches the requested state. */
  persisted: boolean;
}

export type { GrokSkillSummary };

function defaultDeps(): GrokSkillsDeps {
  return { manager: getGrokWebSessionManager(), bridge: callGrokSkillsBridge };
}

function credsOf(session: { cookie: string; userAgent: string }): GrokWebCreds {
  return { cookie: session.cookie, userAgent: session.userAgent };
}

/** Ensure the feature is on + the session is healthy (refreshing if needed). */
async function ready(deps: GrokSkillsDeps): Promise<{ cookie: string; userAgent: string }> {
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
  return deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
}

function fail(what: string, r: { errorClass?: string; detail?: string }): never {
  throw new Error(
    `Grok skills ${what} failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`,
  );
}

/**
 * List the seat's installed skills (compact summaries), optionally filtered by
 * a search query. Free, browserless, statsig-free.
 */
export async function listGrokUserSkills(
  opts: { query?: string; deps?: GrokSkillsDeps } = {},
): Promise<GrokSkillSummary[]> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const query = opts.query?.trim();

  const r = await deps.bridge(
    query ? { op: 'search', q: query } : { op: 'list' },
    credsOf(session),
  );
  if (!r.ok || !Array.isArray(r.skills)) fail('list', r);
  log.info({ count: r.skills.length, filtered: Boolean(query) }, 'grok user skills listed');
  return r.skills;
}

/**
 * Read one installed skill in full (metadata + SKILL.md body). Free,
 * browserless, statsig-free.
 */
export async function getGrokUserSkill(
  name: string,
  opts: { deps?: GrokSkillsDeps } = {},
): Promise<GrokSkillSummary> {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new TypeError('getGrokUserSkill: name must be a non-empty string');
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);

  const r = await deps.bridge({ op: 'get', name: trimmed }, credsOf(session));
  if (!r.ok || !r.skill) fail('get', r);
  log.info({ name: trimmed, enabled: r.skill.enabled }, 'grok user skill read');
  return r.skill;
}

/**
 * List the published verified-skills marketplace visible to this seat
 * (empty on the current personal seat — org-scoped surfaces are 403).
 * Free, browserless, statsig-free.
 */
export async function listGrokVerifiedSkills(
  opts: { pageSize?: number; deps?: GrokSkillsDeps } = {},
): Promise<{ skills: GrokSkillSummary[]; nextPageToken: string }> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);

  const r = await deps.bridge(
    { op: 'verified_published', pageSize: opts.pageSize },
    credsOf(session),
  );
  if (!r.ok || !Array.isArray(r.skills)) fail('verified list', r);
  log.info({ count: r.skills.length }, 'grok verified skills listed');
  return { skills: r.skills, nextPageToken: r.nextPageToken ?? '' };
}

/**
 * Enable or disable an installed skill. SIDE-EFFECTING: changes what the
 * seat's grok can do. Read-back verified — callers MUST check `persisted`
 * (mirror of the grok-memory write pattern). Owner-CLI only.
 */
export async function setGrokUserSkillEnabled(
  name: string,
  enabled: boolean,
  opts: { deps?: GrokSkillsDeps } = {},
): Promise<GrokSkillToggleResult> {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new TypeError('setGrokUserSkillEnabled: name must be a non-empty string');
  if (typeof enabled !== 'boolean') {
    throw new TypeError('setGrokUserSkillEnabled: enabled must be a boolean');
  }
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);

  const r = await deps.bridge({ op: 'set_enabled', name: trimmed, enabled }, credsOf(session));
  if (!r.ok || typeof r.enabled !== 'boolean') fail('toggle', r);
  const persisted = r.persisted === true;
  log.info({ name: trimmed, requested: enabled, enabled: r.enabled, persisted }, 'grok skill toggled');
  return { name: trimmed, enabled: r.enabled, persisted };
}

export { GrokWebReloginRequiredError, GrokWebDisabledError, isGrokWebSessionEnabled };
