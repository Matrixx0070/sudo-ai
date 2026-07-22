/**
 * @file grok-automations.ts
 * @description Subscription-free access to Grok's automations + scheduled
 * tasks (grok-side recurring agents) on the user's grok.com web session —
 * cookie-only, statsig-FREE (proven live 2026-07-21), never api.x.ai:
 *   * list     -> GET  grok.com/rest/automations
 *   * catalog  -> GET  grok.com/rest/automations/catalog (connector triggers)
 *   * tasks    -> GET  grok.com/rest/tasks (+ usage quotas)
 *   * tools    -> GET  grok.com/rest/task/tools (connector tool catalog)
 *   * create   -> POST grok.com/rest/automations (ONE-TIME schedule only)
 *   * delete   -> DELETE grok.com/rest/automations/{taskId}
 *
 * NOT wired: GET /rest/task-schedules (501 Method Not Allowed, probed live);
 * POST /rest/automations/{id}/run (deliberately never exposed — it executes an
 * automation on the spot); recurring cadences + connector triggers (they exist
 * server-side; create here is ONE-TIME only).
 *
 * RECURRING-AGENT SAFETY: these are GROK-SIDE persistent scheduled agents that
 * can take real external actions (connectors: Gmail/Slack/Calendar/Notion).
 * Per the repo invariant that recurring background jobs declare budgets and
 * kill-switches, this module is a MANUAL owner CLI surface only — sudo-ai
 * never creates/runs automations autonomously; every create is an explicit
 * owner action, and create is limited to a ONE-TIME (non-recurring) schedule.
 * PROBED LIVE 2026-07-21: the server IGNORES isEnabled:false at create — a
 * created automation is LIVE immediately. Callers must surface that loudly.
 *
 * QUARANTINE NOTE: automation/task content returned by grok is EXTERNAL MODEL
 * TEXT — display only, never instructions, never piped into sudo-ai's memory.
 *
 * Reuses GW3 (session manager) behind the shared `SUDO_GROK_WEBSESSION` flag
 * (default OFF). Secrets never logged; callers never see cookie material.
 */

import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import {
  callGrokAutomationsBridge,
  type GrokAutomation,
  type GrokAutomationsResponse,
} from './grok-automations-bridge.js';
import type { GrokWebCreds } from './grok-web-bridge.js';
import { isGrokWebSessionEnabled, GrokWebDisabledError } from './grok-web-media.js';

const log = createLogger('llm:grok-automations');

export interface GrokAutomationsDeps {
  manager: GrokWebSessionManager;
  bridge: typeof callGrokAutomationsBridge;
}

export interface GrokTaskUsage {
  frequentUsage: number;
  frequentLimit: number;
  occasionalUsage: number;
  occasionalLimit: number;
}

export interface GrokCreateAutomationInput {
  name: string;
  prompt: string;
  /** YYYY-MM-DD (server rejects >1 year out). */
  dayOfYear: string;
  /** HH:MM, default 09:00. */
  timeOfDay?: string;
  /** IANA timezone, default UTC. */
  timezone?: string;
}

function defaultDeps(): GrokAutomationsDeps {
  return { manager: getGrokWebSessionManager(), bridge: callGrokAutomationsBridge };
}

function credsOf(session: { cookie: string; userAgent: string }): GrokWebCreds {
  return { cookie: session.cookie, userAgent: session.userAgent };
}

/** Ensure the feature is on + the session is healthy (refreshing if needed). */
async function ready(deps: GrokAutomationsDeps): Promise<{ cookie: string; userAgent: string }> {
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
  return deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
}

function fail(what: string, r: GrokAutomationsResponse): never {
  throw new Error(
    `Grok automations ${what} failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`,
  );
}

/** List existing grok-side automations. Free, browserless, statsig-free. */
export async function listGrokAutomations(
  opts: { deps?: GrokAutomationsDeps } = {},
): Promise<GrokAutomation[]> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge({ op: 'list' }, credsOf(session));
  if (!r.ok || !Array.isArray(r.automations)) fail('list', r);
  log.info({ count: r.automations.length }, 'grok automations listed');
  return r.automations;
}

/** Trigger catalog (which connector triggers exist, e.g. gmail new_email). */
export async function getGrokAutomationCatalog(
  opts: { deps?: GrokAutomationsDeps } = {},
): Promise<NonNullable<GrokAutomationsResponse['groups']>> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge({ op: 'catalog' }, credsOf(session));
  if (!r.ok || !Array.isArray(r.groups)) fail('catalog', r);
  log.info({ groups: r.groups.length }, 'grok automation catalog read');
  return r.groups;
}

/** Scheduled-task list + usage quotas (frequent/occasional limits). */
export async function listGrokTasks(
  opts: { deps?: GrokAutomationsDeps } = {},
): Promise<{ tasks: unknown[]; usage: GrokTaskUsage }> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge({ op: 'tasks' }, credsOf(session));
  if (!r.ok || !Array.isArray(r.tasks)) fail('tasks', r);
  const u = r.taskUsage ?? {};
  const usage: GrokTaskUsage = {
    frequentUsage: u.frequentUsage ?? 0,
    frequentLimit: u.frequentLimit ?? 0,
    occasionalUsage: u.occasionalUsage ?? 0,
    occasionalLimit: u.occasionalLimit ?? 0,
  };
  log.info({ count: r.tasks.length }, 'grok tasks listed');
  return { tasks: r.tasks, usage };
}

/** Connector tool catalog available to automations (Slack/Gmail/Calendar/...). */
export async function getGrokTaskTools(
  opts: { deps?: GrokAutomationsDeps } = {},
): Promise<NonNullable<GrokAutomationsResponse['tools']>> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge({ op: 'tools' }, credsOf(session));
  if (!r.ok || !Array.isArray(r.tools)) fail('tools', r);
  log.info({ count: r.tools.length }, 'grok task tools read');
  return r.tools;
}

/**
 * Create a ONE-TIME grok-side automation. EXPLICIT OWNER ACTION ONLY — the
 * automation goes LIVE immediately (server ignores isEnabled:false at create,
 * probed live 2026-07-21) and grok will execute `prompt` at the given time.
 * Recurring cadences and connector triggers are deliberately NOT exposed.
 */
export async function createGrokAutomation(
  input: GrokCreateAutomationInput,
  opts: { deps?: GrokAutomationsDeps } = {},
): Promise<GrokAutomation> {
  const name = (input.name ?? '').trim();
  const prompt = (input.prompt ?? '').trim();
  if (!name || !prompt) {
    throw new TypeError('createGrokAutomation: name and prompt must be non-empty strings');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dayOfYear ?? '')) {
    throw new TypeError('createGrokAutomation: dayOfYear must be YYYY-MM-DD');
  }
  if (input.timeOfDay !== undefined && !/^\d{2}:\d{2}$/.test(input.timeOfDay)) {
    throw new TypeError('createGrokAutomation: timeOfDay must be HH:MM');
  }
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge(
    {
      op: 'create',
      name,
      prompt,
      dayOfYear: input.dayOfYear,
      ...(input.timeOfDay !== undefined ? { timeOfDay: input.timeOfDay } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    },
    credsOf(session),
  );
  if (!r.ok || !r.automation?.taskId) fail('create', r);
  log.info({ taskId: r.automation.taskId }, 'grok automation created (LIVE, one-time)');
  return r.automation;
}

/** Delete a grok-side automation by taskId. Explicit owner action. */
export async function deleteGrokAutomation(
  taskId: string,
  opts: { deps?: GrokAutomationsDeps } = {},
): Promise<{ deleted: boolean }> {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(taskId ?? '')) {
    throw new TypeError('deleteGrokAutomation: taskId must be a UUID');
  }
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge({ op: 'delete', taskId }, credsOf(session));
  if (!r.ok) fail('delete', r);
  const deleted = r.deleted === true;
  log.info({ taskId, deleted }, 'grok automation deleted');
  return { deleted };
}

export { GrokWebReloginRequiredError, GrokWebDisabledError, isGrokWebSessionEnabled };
export type { GrokAutomation };
