/**
 * Local persistence of the web-chat conversation so a reload restores the
 * visible history (the stable peer id in peer.ts separately resumes the server
 * session). Media bytes are NOT persisted — blob: object URLs are invalid after
 * a reload and data: URLs are large — so each media message is stored as a
 * compact text marker. History is capped to the most recent MAX_STORED entries.
 */
import type { Message } from './hooks/useChatSession';

export type StoredMessage = { role: 'user' | 'ai'; content: string; timestamp: string };

export const MAX_STORED = 100;

/** Reduce live messages to a compact, media-free form for localStorage. */
export function serializeHistory(messages: Message[], max = MAX_STORED): StoredMessage[] {
  return messages
    .slice(-max)
    .map((m) => ({
      role: m.role,
      content: m.content?.trim()
        ? m.content
        : m.imageUrl
        ? '🖼 Image'
        : m.audioUrl
        ? '🔊 Voice note'
        : m.fileUrl || m.fileName
        ? `📎 ${m.fileName ?? 'File'}`
        : '',
      timestamp: m.timestamp.toISOString(),
    }))
    .filter((m) => m.content.length > 0);
}

/** Parse stored history back into renderable messages (timestamps → Date). */
export function deserializeHistory(json: string): Message[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Message[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if ((o['role'] !== 'user' && o['role'] !== 'ai') || typeof o['content'] !== 'string') continue;
    const parsed = typeof o['timestamp'] === 'string' ? new Date(o['timestamp']) : new Date(NaN);
    out.push({
      role: o['role'],
      content: o['content'],
      timestamp: isNaN(parsed.getTime()) ? new Date() : parsed,
    });
  }
  return out;
}

export function loadHistory(key: string): Message[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? deserializeHistory(raw) : [];
  } catch {
    return [];
  }
}

export function saveHistory(key: string, messages: Message[]): void {
  try {
    const serialized = serializeHistory(messages);
    // An empty conversation gets no key — so "New chat"/clear leaves no orphaned
    // `[]` entry behind (the persist effect re-runs on the empty state).
    if (serialized.length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(serialized));
    }
  } catch {
    /* quota exceeded / private mode — skip persistence */
  }
}

export function clearHistory(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
