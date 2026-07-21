/**
 * @file grok-memory.ts
 * @description Subscription-free access to Grok's persistent user memory on
 * the user's grok.com web session — cookie-only, statsig-FREE (proven live
 * 2026-07-21), never the metered api.x.ai path:
 *   * blurb read  -> GET    grok.com/rest/app-chat/user-memory-blurb
 *   * blurb write -> PUT    grok.com/rest/app-chat/user-memory-blurb (accepted
 *     with 200 but silently dropped server-side on the current seat — every
 *     write is read-back verified and reports `persisted`)
 *   * blurb clear -> DELETE grok.com/rest/app-chat/user-memory-blurb
 *   * imported    -> GET    grok.com/rest/app-chat/import-memory (+ /status)
 *
 * NOT wired (server-side broken, probed live 2026-07-21): the per-conversation
 * memory list (POST /rest/app-chat/memory → 500 "Failed to get memory" even
 * with valid conversationIds) and the companion-scoped memories_v2 lanes. See
 * scripts/grok-web/grok_memory.py for the probe record.
 *
 * QUARANTINE NOTE: grok's memory content is EXTERNAL MODEL TEXT. This module
 * only reads/writes GROK's own memory store and surfaces it to the caller —
 * it must NOT be piped into sudo-ai's own memory system. Doing that would
 * require the F18 quarantine (inspectContent → memory API), a future step
 * that is deliberately out of scope here.
 *
 * Reuses GW3 (session manager) behind the shared `SUDO_GROK_WEBSESSION` flag
 * (default OFF). Secrets never logged; callers get memory text back — never
 * cookie material. No Playwright, no statsig oracle needed.
 */

import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import { callGrokMemoryBridge } from './grok-memory-bridge.js';
import type { GrokWebCreds } from './grok-web-bridge.js';
import { isGrokWebSessionEnabled, GrokWebDisabledError } from './grok-web-media.js';

const log = createLogger('llm:grok-memory');

export interface GrokMemoryDeps {
  manager: GrokWebSessionManager;
  bridge: typeof callGrokMemoryBridge;
}

export interface GrokMemoryBlurb {
  /** What grok persistently remembers about the user across chats. */
  memoryContent: string;
}

export interface GrokMemoryWriteResult {
  /** The content the write requested. */
  memoryContent: string;
  /**
   * TRUE only when a read-back after the write returned the new content. The
   * seat's PUT can return 200 yet be silently dropped server-side, so callers
   * MUST check this instead of trusting the HTTP status.
   */
  persisted: boolean;
  /** What the read-back actually returned. */
  readBack: string;
}

export interface GrokImportedMemory {
  /** Memory imported from X/Twitter grok (empty when none imported). */
  content: string;
  /** IMPORTED_MEMORY_STATUS_NONE | _PENDING | _COMPLETE | '' when unknown. */
  status: string;
}

function defaultDeps(): GrokMemoryDeps {
  return { manager: getGrokWebSessionManager(), bridge: callGrokMemoryBridge };
}

function credsOf(session: { cookie: string; userAgent: string }): GrokWebCreds {
  return { cookie: session.cookie, userAgent: session.userAgent };
}

/** Ensure the feature is on + the session is healthy (refreshing if needed). */
async function ready(deps: GrokMemoryDeps): Promise<{ cookie: string; userAgent: string }> {
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
  return deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
}

/**
 * Read grok's persistent memory blurb — what grok remembers about the user
 * across chats. Free, browserless, statsig-free.
 */
export async function getGrokMemoryBlurb(
  opts: { deps?: GrokMemoryDeps } = {},
): Promise<GrokMemoryBlurb> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);

  const r = await deps.bridge({ op: 'blurb_get' }, credsOf(session));
  if (!r.ok || typeof r.memoryContent !== 'string') {
    throw new Error(
      `Grok memory read failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`,
    );
  }
  log.info({ blurbLen: r.memoryContent.length }, 'grok memory blurb read');
  return { memoryContent: r.memoryContent };
}

/**
 * Write grok's persistent memory blurb. The write is read-back verified —
 * check `persisted` on the result (the seat's PUT can 200 yet be silently
 * dropped server-side). Free, browserless, statsig-free.
 */
export async function setGrokMemoryBlurb(
  memoryContent: string,
  opts: { deps?: GrokMemoryDeps } = {},
): Promise<GrokMemoryWriteResult> {
  const trimmed = (memoryContent ?? '').trim();
  if (!trimmed) {
    throw new TypeError('setGrokMemoryBlurb: memoryContent must be a non-empty string');
  }
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);

  const r = await deps.bridge({ op: 'blurb_set', memoryContent: trimmed }, credsOf(session));
  if (!r.ok) {
    throw new Error(
      `Grok memory write failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`,
    );
  }
  const persisted = r.persisted === true;
  log.info({ blurbLen: trimmed.length, persisted }, 'grok memory blurb write');
  return { memoryContent: trimmed, persisted, readBack: r.readBack ?? '' };
}

/**
 * Clear grok's persistent memory blurb. Read-back verified like the write.
 * Free, browserless, statsig-free.
 */
export async function clearGrokMemoryBlurb(
  opts: { deps?: GrokMemoryDeps } = {},
): Promise<{ persisted: boolean }> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);

  const r = await deps.bridge({ op: 'blurb_clear' }, credsOf(session));
  if (!r.ok) {
    throw new Error(
      `Grok memory clear failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`,
    );
  }
  const persisted = r.persisted === true;
  log.info({ persisted }, 'grok memory blurb cleared');
  return { persisted };
}

/**
 * Read the memory grok imported from X/Twitter (plus its import status).
 * Free, browserless, statsig-free.
 */
export async function getGrokImportedMemory(
  opts: { deps?: GrokMemoryDeps } = {},
): Promise<GrokImportedMemory> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);

  const r = await deps.bridge({ op: 'imported_get' }, credsOf(session));
  if (!r.ok || typeof r.content !== 'string') {
    throw new Error(
      `Grok imported-memory read failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`,
    );
  }
  log.info({ contentLen: r.content.length, status: r.importStatus ?? '' }, 'grok imported memory read');
  return { content: r.content, status: r.importStatus ?? '' };
}

export { GrokWebReloginRequiredError, GrokWebDisabledError, isGrokWebSessionEnabled };
