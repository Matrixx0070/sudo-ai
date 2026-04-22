/**
 * Upgrade 60: Browser Session Control
 *
 * Lightweight session registry for named browser sessions.  Each session
 * tracks its URL, cookies, and active status.  The fill/click helpers are
 * stubs ready to be wired to a real CDP connection (e.g. the existing
 * browser-manager in this module tree).
 *
 * This module does NOT register a ToolDefinition — it is a utility layer
 * imported by higher-level tools or agent loops.
 */

import { createLogger } from '../../../shared/logger.js';

const log = createLogger('tool:browser-session');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserSession {
  id: string;
  url: string;
  title?: string;
  cookies?: Record<string, string>;
  active: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// In-memory registry
// ---------------------------------------------------------------------------

const sessions: Map<string, BrowserSession> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create and register a new browser session for the given URL.
 *
 * @param url The initial URL of the session.
 */
export function createSession(url: string): BrowserSession {
  if (!url?.trim()) throw new Error('URL is required to create a browser session');

  const session: BrowserSession = {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    url: url.trim(),
    active: true,
    createdAt: new Date().toISOString(),
  };

  sessions.set(session.id, session);
  log.info({ id: session.id, url: session.url }, 'Browser session created');
  return session;
}

/**
 * Retrieve a session by ID.  Returns undefined when not found.
 */
export function getSession(id: string): BrowserSession | undefined {
  return sessions.get(id);
}

/**
 * Return all registered sessions (active and inactive).
 */
export function listSessions(): BrowserSession[] {
  return Array.from(sessions.values());
}

/**
 * Deactivate a session (marks it inactive; does NOT close any real browser).
 */
export function closeSession(id: string): void {
  const s = sessions.get(id);
  if (!s) {
    log.warn({ id }, 'closeSession: session not found');
    return;
  }
  s.active = false;
  log.info({ id }, 'Browser session closed');
}

/**
 * Update the tracked URL for a session (e.g. after navigation).
 */
export function updateSessionUrl(id: string, url: string): void {
  const s = sessions.get(id);
  if (!s) {
    log.warn({ id }, 'updateSessionUrl: session not found');
    return;
  }
  s.url = url;
  log.debug({ id, url }, 'Session URL updated');
}

/**
 * Fill a form field in the browser session identified by sessionId.
 *
 * Currently a logged stub — wire to a real CDP Page.evaluate() call when
 * a live browser connection is available.
 *
 * @param sessionId  ID of the target session.
 * @param selector   CSS selector for the target input element.
 * @param value      Value to fill in.
 * @returns Human-readable confirmation string.
 */
export async function fillField(
  sessionId: string,
  selector: string,
  value: string,
): Promise<string> {
  if (!sessionId?.trim()) return 'ERROR: sessionId is required';
  if (!selector?.trim()) return 'ERROR: selector is required';

  const session = sessions.get(sessionId);
  if (!session) return `ERROR: session ${sessionId} not found`;
  if (!session.active) return `ERROR: session ${sessionId} is no longer active`;

  log.info({ sessionId, selector, valueLength: value.length }, 'fillField invoked');
  // TODO: wire to real CDP session via browser-manager.ts
  return `Filled "${selector}" with ${value.length} chars in session ${sessionId}`;
}

/**
 * Click an element in the browser session identified by sessionId.
 *
 * Currently a logged stub — wire to a real CDP Page.evaluate() / mouse click.
 *
 * @param sessionId  ID of the target session.
 * @param selector   CSS selector or text for the target element.
 * @returns Human-readable confirmation string.
 */
export async function clickElement(
  sessionId: string,
  selector: string,
): Promise<string> {
  if (!sessionId?.trim()) return 'ERROR: sessionId is required';
  if (!selector?.trim()) return 'ERROR: selector is required';

  const session = sessions.get(sessionId);
  if (!session) return `ERROR: session ${sessionId} not found`;
  if (!session.active) return `ERROR: session ${sessionId} is no longer active`;

  log.info({ sessionId, selector }, 'clickElement invoked');
  // TODO: wire to real CDP session via browser-manager.ts
  return `Clicked "${selector}" in session ${sessionId}`;
}
