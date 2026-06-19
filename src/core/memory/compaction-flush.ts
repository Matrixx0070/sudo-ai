/**
 * @file compaction-flush.ts
 * @description Pre-compaction memory flusher.
 *
 * Before a context window compaction (the moment the agent summarises its
 * conversation to save tokens), this module extracts the most important
 * facts, decisions, and identifiers from the recent message history and
 * persists them as searchable chunks.
 *
 * Design goals:
 *  - Heuristic extraction (no LLM call required — keeps it fast and free)
 *  - Idempotent — running twice on the same messages stores the same hash,
 *    so no duplicates accumulate via better-sqlite3 UNIQUE constraint on hash.
 *  - Writes to path "memory/YYYY-MM-DD.md" so chunks are easy to filter.
 */

import type { MindDB } from './db.js';
import type { MessageRow } from './db.js';
import type { MemoryChunk } from './types.js';
import {
  isChunkContradictionEnabled,
  resolveChunkContradictions,
  type ChunkContradictionDeps,
} from './chunk-contradiction.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimum word count for a message to be considered for flushing */
const MIN_WORDS = 10;

/** Maximum characters per extracted chunk */
const MAX_CHUNK_CHARS = 1000;

/**
 * Heuristic patterns that signal an important piece of information.
 * Messages matching any of these are preferentially stored.
 */
const IMPORTANT_PATTERNS: RegExp[] = [
  /\b(decided?|decision|agreed?|agreement|conclusion)\b/i,
  /\b(must|should|will|going to|plan to)\b/i,
  /\b(error|bug|fixed?|resolved?|issue)\b/i,
  /\b(remember|note|important|critical|key|todo)\b/i,
  /\b(path|url|api[- ]?key|token|secret|config|setting)\b/i,
  /\b(version|release|deploy|update|upgrade)\b/i,
  /\b(user|owner|operator)\b/i,       // project-specific: named principals
  /\bsudo[- ]?ai\b/i,                // project name
  /```[\s\S]+?```/,                  // code blocks always matter
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist important memories before a context window compaction.
 *
 * Called by the brain/orchestrator whenever it detects the context is near
 * the compaction threshold. Extracts salient messages and stores them as
 * chunks in mind.db under a date-stamped path.
 *
 * @param db              - Open MindDB instance (synchronous writes)
 * @param sessionMessages - Full message array from the current session
 * @param contradiction   - Optional embedding+judge deps. When supplied AND
 *                          SUDO_CHUNK_CONTRADICT=1, each newly-stored chunk
 *                          supersedes any active chunk it semantically
 *                          contradicts. Absent → prior accrete behaviour.
 * @returns               - Array of chunks that were newly stored (empty if all were deduped)
 */
export async function flushBeforeCompaction(
  db: MindDB,
  sessionMessages: MessageRow[],
  contradiction?: ChunkContradictionDeps,
): Promise<MemoryChunk[]> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const path  = `memory/${today}.md`;

  const candidates = selectCandidates(sessionMessages);
  const stored: MemoryChunk[] = [];
  // Only attempt contradiction resolution when wired AND flag-enabled.
  const resolveContradictions = contradiction != null && isChunkContradictionEnabled();

  for (const text of candidates) {
    const trimmed = text.slice(0, MAX_CHUNK_CHARS).trim();
    if (!trimmed) continue;

    try {
      const chunk = db.storeChunk(trimmed, path, 'conversation', {
        isEvergreen: isEvergreen(trimmed),
      });
      stored.push(chunk);
      // Supersede older chunks this one contradicts (fail-open inside the helper).
      if (resolveContradictions) {
        await resolveChunkContradictions(chunk, contradiction!);
      }
    } catch (err) {
      // Log but do not throw — compaction must not be blocked by storage errors
      console.warn('[compaction-flush] Failed to store chunk:', err);
    }
  }

  if (stored.length > 0) {
    console.info(
      `[compaction-flush] Flushed ${stored.length} chunks to ${path} (${candidates.length} candidates evaluated)`,
    );
  }

  return stored;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Score and filter messages from the session history, returning the text
 * of messages worth persisting.
 */
function selectCandidates(messages: MessageRow[]): string[] {
  const scored: Array<{ text: string; score: number }> = [];

  for (const msg of messages) {
    // Skip system messages and empty content
    if (msg.role === 'system') continue;
    if (!msg.content || msg.content.trim().length === 0) continue;

    const text = buildChunkText(msg);
    if (wordCount(text) < MIN_WORDS) continue;

    const score = scoreMessage(msg);
    if (score > 0) {
      scored.push({ text, score });
    }
  }

  // Sort by descending importance score, take top 20 to avoid flooding DB
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((s) => s.text);
}

/**
 * Build a human-readable chunk text from a message row.
 * Includes role prefix and optional tool context.
 */
function buildChunkText(msg: MessageRow): string {
  const parts: string[] = [];

  if (msg.role === 'tool' && msg.tool_name) {
    parts.push(`[Tool: ${msg.tool_name}]`);
    if (msg.tool_output) {
      parts.push(msg.tool_output.slice(0, 500));
    }
  } else {
    const roleLabel = msg.role === 'assistant' ? 'AI' : 'User';
    parts.push(`[${roleLabel}] ${msg.content}`);
  }

  return parts.join('\n').trim();
}

/**
 * Heuristic importance score for a message.
 * Higher = more important. Messages scoring 0 are discarded.
 */
function scoreMessage(msg: MessageRow): number {
  let score = 0;
  const content = (msg.content ?? '').toLowerCase();

  // Assistant messages carry more extractable knowledge than echoes
  if (msg.role === 'assistant') score += 1;

  // Pattern matching — each match adds weight
  for (const pattern of IMPORTANT_PATTERNS) {
    if (pattern.test(content)) score += 2;
  }

  // Long messages are more likely to contain useful context
  const words = wordCount(content);
  if (words > 50)  score += 1;
  if (words > 150) score += 1;

  // Code blocks are always worth saving
  if (/```/.test(content)) score += 3;

  return score;
}

/**
 * Determine if a chunk text represents a permanent fact that should be
 * exempt from temporal decay.
 */
function isEvergreen(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\b(api[- ]?key|token|secret|config|setting|user preference|always|never)\b/.test(lower) ||
    /\bsudo[- ]?ai\b/.test(lower) ||
    // Absolute file paths are durable facts
    /\/root\/sudo-ai-v4\//.test(text)
  );
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
