/**
 * @file injector.ts
 * @description WorkspaceInjector — injects daily memory notes and long-term
 * memory into a session's message array at the start of each turn.
 *
 * Reads:
 *  - workspace/memory/YYYY-MM-DD.md  (today's log)
 *  - workspace/memory/YYYY-MM-DD.md  (yesterday's log)
 *  - workspace/MEMORY.md             (long-term memory, mainPeer only)
 *
 * All injected messages are prepended to session.messages so they appear
 * before any user messages in the context window.
 *
 * Idempotent: if today's note was already injected this session, returns
 * immediately without re-reading or re-injecting any files.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('workspace:injector');

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface WorkspaceInjectorConfig {
  /** Absolute path to the workspace directory (the folder containing memory/). */
  workspaceDir: string;
  /**
   * If set, workspace/MEMORY.md is only injected when session.peerId matches
   * this value.  When undefined, MEMORY.md is never injected.
   */
  mainPeerId?: string;
}

export interface WorkspaceInjectorDeps {
  config: WorkspaceInjectorConfig;
}

// ---------------------------------------------------------------------------
// Duck-typed SessionLike — matches the interface exported from loop-helpers.ts
// without creating a circular import.
// ---------------------------------------------------------------------------

interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: unknown[];
  toolCallId?: string;
  toolName?: string;
}

interface SessionLike {
  id: string;
  messages: SessionMessage[];
  channel?: string;
  peerId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the ISO date string (YYYY-MM-DD) for a given offset in days relative
 * to now.  offset=0 → today, offset=-1 → yesterday.
 */
function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Attempt to read a file at the given absolute path.
 * Returns the trimmed content string, or null if the file does not exist or
 * any read error occurs.  Never throws.
 */
async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.trim() || null;
  } catch {
    // File missing or unreadable — silently skip.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Inject workspace context (daily memory notes + long-term MEMORY.md) into
 * the front of `session.messages`.
 *
 * Idempotency: checks whether a system message starting with '## Today\n' is
 * already present.  If found, returns immediately — safe to call multiple
 * times per session without duplicating context.
 *
 * @param session - The active agent session (duck-typed).
 * @param deps    - Injector dependencies (config with workspaceDir / mainPeerId).
 */
export async function injectWorkspaceContext(
  session: SessionLike,
  deps: WorkspaceInjectorDeps,
): Promise<void> {
  const { config } = deps;

  if (!config.workspaceDir || typeof config.workspaceDir !== 'string') {
    log.warn({ sessionId: session.id }, 'injectWorkspaceContext: workspaceDir is empty — skipping');
    return;
  }

  // --- Idempotency check ------------------------------------------------
  // If today's note was already injected (from a previous call this session),
  // bail out immediately to avoid duplicating context.
  const alreadyInjected = session.messages.some(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('## Today\n'),
  );
  if (alreadyInjected) {
    log.debug({ sessionId: session.id }, 'injectWorkspaceContext: already injected — skipping');
    return;
  }

  log.debug({ sessionId: session.id, workspaceDir: config.workspaceDir }, 'Injecting workspace context');

  const memoryDir = path.join(config.workspaceDir, 'memory');

  // Collect messages to prepend (built up in reverse insertion order because
  // we unshift each one; the final order in session.messages will be:
  //   [MEMORY.md] [yesterday] [today] [... existing messages ...]
  // We build the list in natural order then reverse-unshift so MEMORY.md ends
  // up first, giving the brain the clearest reading order.

  const toInject: SessionMessage[] = [];

  // 1. Today's daily log — memory/YYYY-MM-DD.md
  const todayPath = path.join(memoryDir, `${isoDate(0)}.md`);
  const todayContent = await tryReadFile(todayPath);
  if (todayContent) {
    toInject.push({ role: 'system', content: `## Today\n${todayContent}` });
    log.debug({ sessionId: session.id, path: todayPath }, 'Today memory injected');
  }

  // 2. Yesterday's daily log — memory/YYYY-MM-DD.md (offset -1)
  const yesterdayPath = path.join(memoryDir, `${isoDate(-1)}.md`);
  const yesterdayContent = await tryReadFile(yesterdayPath);
  if (yesterdayContent) {
    toInject.push({ role: 'system', content: `## Yesterday\n${yesterdayContent}` });
    log.debug({ sessionId: session.id, path: yesterdayPath }, 'Yesterday memory injected');
  }

  // 3. Long-term MEMORY.md — only when session.peerId matches mainPeerId
  if (config.mainPeerId !== undefined && session.peerId === config.mainPeerId) {
    const memoryFilePath = path.join(config.workspaceDir, 'MEMORY.md');
    const memoryContent = await tryReadFile(memoryFilePath);
    if (memoryContent) {
      toInject.push({ role: 'system', content: `## Long-Term Memory\n${memoryContent}` });
      log.debug({ sessionId: session.id, path: memoryFilePath }, 'Long-term MEMORY.md injected');
    }
  }

  if (toInject.length === 0) {
    log.debug({ sessionId: session.id }, 'injectWorkspaceContext: no memory files found — nothing injected');
    return;
  }

  // Prepend messages in reverse order so that after unshifting, the array
  // reads: [today, yesterday, MEMORY.md (if any), ...existing messages]
  // We want today first because the idempotency marker is on today's note.
  // Reverse the collected list then unshift each entry so the final order is
  // the same as the order in toInject (index 0 ends up at position 0).
  for (let i = toInject.length - 1; i >= 0; i--) {
    session.messages.unshift(toInject[i] as SessionMessage);
  }

  log.info(
    { sessionId: session.id, injectedCount: toInject.length },
    'Workspace context injected',
  );
}
