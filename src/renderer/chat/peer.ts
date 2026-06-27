/**
 * Stable per-browser peer identity for the web chat.
 *
 * Without this, every page load (and every WS reconnect) minted a fresh random
 * peerId server-side, so the server created a brand-new session each time —
 * losing both the visible history and the agent's conversational continuity.
 *
 * Resolution order:
 *   1. `?peer=` query param (explicit override — e.g. external API injection).
 *   2. a uuid persisted in localStorage (stable across reloads on this browser).
 *   3. an ephemeral id (private mode / no storage) — no persistence, but the
 *      session still works for the lifetime of the tab.
 */
const PEER_STORAGE_KEY = 'sudo-chat-peer';

let cachedPeerId: string | null = null;

export function getChatPeerId(): string {
  if (cachedPeerId) return cachedPeerId;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('peer');
    if (fromUrl) {
      cachedPeerId = fromUrl;
      return fromUrl;
    }
    let id = localStorage.getItem(PEER_STORAGE_KEY);
    if (!id) {
      id = `web-${crypto.randomUUID()}`;
      localStorage.setItem(PEER_STORAGE_KEY, id);
    }
    cachedPeerId = id;
    return id;
  } catch {
    cachedPeerId = `web-${Math.random().toString(36).slice(2, 14)}`;
    return cachedPeerId;
  }
}

/** Mint a fresh peer id (new server session) — used by "New chat". */
export function resetChatPeerId(): void {
  cachedPeerId = null;
  try {
    localStorage.setItem(PEER_STORAGE_KEY, `web-${crypto.randomUUID()}`);
  } catch { /* private mode — next getChatPeerId() returns a fresh ephemeral id */ }
}
