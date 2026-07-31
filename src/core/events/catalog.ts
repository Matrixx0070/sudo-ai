/**
 * @file catalog.ts
 * @description Platform event catalog — the single registry of every event type
 * the unified event bus can carry. Each entry declares a schema version and
 * whether the event is PERSISTENT (logged to events.db + eligible for webhook
 * delivery) or EPHEMERAL (realtime-only: WS push, never persisted/delivered —
 * high-frequency stream frames like output deltas).
 *
 * Publishers reference these names; the webhook CRUD API validates endpoint
 * subscriptions against this catalog (exact names or `prefix.*` patterns).
 */

export interface EventTypeSpec {
  /** Current schema version for this event type (rides in the envelope). */
  version: number;
  /** false = realtime-only: not written to the event log, never sent to webhooks. */
  persistent: boolean;
  description: string;
}

/** Persistent lifecycle events (webhook-eligible + WS). */
const PERSISTENT: Record<string, string> = {
  // Sessions
  'session.started': 'A session began processing its first/next turn',
  'session.updated': 'Session metadata changed',
  'session.idled': 'Session became idle',
  'session.terminated': 'Session ended',
  // Threads
  'thread.created': 'A conversation thread was created',
  'thread.updated': 'A conversation thread was updated',
  'thread.deleted': 'A conversation thread was deleted',
  // Messages
  'message.created': 'A message was accepted into a session',
  'message.completed': 'The assistant finished a reply',
  'message.failed': 'A turn failed before producing a reply',
  // Agents
  'agent.created': 'An agent definition was created',
  'agent.updated': 'An agent definition was updated',
  'agent.archived': 'An agent definition was archived',
  'agent.deleted': 'An agent definition was deleted',
  // Deployments
  'deployment.created': 'A deployment was created',
  'deployment.updated': 'A deployment was updated',
  'deployment.paused': 'A deployment was paused',
  'deployment.unpaused': 'A deployment was unpaused',
  'deployment.deleted': 'A deployment was deleted',
  'deployment_run.started': 'A deployment run started',
  'deployment_run.succeeded': 'A deployment run succeeded',
  'deployment_run.failed': 'A deployment run failed',
  // Memory
  'memory.created': 'A memory entry was created',
  'memory.updated': 'A memory entry was updated',
  'memory.deleted': 'A memory entry was deleted',
  // Tools
  'tool.started': 'A tool invocation started',
  'tool.completed': 'A tool invocation completed successfully',
  'tool.failed': 'A tool invocation failed',
  // Files
  'file.uploaded': 'A file was uploaded',
  'file.deleted': 'A file was deleted',
  // Ops
  'notification': 'Operator-facing notification',
};

/** Ephemeral realtime-only events (WS push; never persisted or webhooked). */
const EPHEMERAL: Record<string, string> = {
  'session.status': 'Live session status change (thinking/streaming/…)',
  'session.token': 'Live token-count progress frame',
  'session.output.delta': 'Streaming output chunk',
  'session.output.completed': 'Streaming output finished',
  'session.error': 'Live session error frame',
  'message.delta': 'Streaming message chunk',
  'agent.typing': 'Agent is composing output',
  'agent.thinking': 'Agent is reasoning',
  'deployment.logs': 'Live deployment log lines',
  'deployment.status': 'Live deployment status frame',
};

function build(): Record<string, EventTypeSpec> {
  const out: Record<string, EventTypeSpec> = {};
  for (const [k, description] of Object.entries(PERSISTENT)) out[k] = { version: 1, persistent: true, description };
  for (const [k, description] of Object.entries(EPHEMERAL)) out[k] = { version: 1, persistent: false, description };
  return out;
}

/** name → spec for every known event type. */
export const EVENT_CATALOG: Readonly<Record<string, EventTypeSpec>> = Object.freeze(build());

/** All persistent (webhook-eligible) event type names, sorted. */
export function persistentEventTypes(): string[] {
  return Object.entries(EVENT_CATALOG).filter(([, s]) => s.persistent).map(([k]) => k).sort();
}

export function isKnownEventType(type: string): boolean {
  return type in EVENT_CATALOG;
}

/**
 * True when `pattern` (an exact name, `prefix.*`, or `*`) is a valid
 * subscription pattern: `*` always; `prefix.*` if at least one persistent type
 * starts with `prefix.`; exact names must be persistent catalog entries.
 */
export function isValidSubscriptionPattern(pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // keep the trailing dot
    return persistentEventTypes().some((t) => t.startsWith(prefix));
  }
  return EVENT_CATALOG[pattern]?.persistent === true;
}

/** True when the event `type` matches one of the subscription `patterns`. */
export function matchesSubscription(type: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p === '*' || p === type) return true;
    if (p.endsWith('.*') && type.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}
