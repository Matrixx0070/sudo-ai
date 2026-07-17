/**
 * @file agent/debate-seam.ts
 * @description F48 trigger seam. The debate chamber (symmetric FOR/AGAINST pack)
 * lives under notebooklm/gdrive; the agent can't import it (hot-path isolation),
 * so — exactly like the F32 second-opinion seam — the veto gate requests a
 * debate through this injected, fire-and-forget seam. cli.ts wires the requester
 * to exportDebatePack with both advocates pinned to the independent judge route.
 * In-process dedup; never blocks a turn; default no-op.
 */

export interface DebateRequest {
  /** Stable dedup + packet id. [\w-]{1,64}. */
  key: string;
  /** Neutral question — NO conclusion (the debate side re-validates this). */
  question: string;
  evidence: string[];
  constraints: string[];
}

export type DebateRequester = (req: DebateRequest) => Promise<void>;

let requester: DebateRequester | null = null;
const seen = new Set<string>();

export function setDebateRequester(fn: DebateRequester | null): void {
  requester = fn;
  if (!fn) seen.clear();
}

export function debateEnabled(): boolean {
  return requester !== null;
}

/** Fire-and-forget. True if a NEW debate was dispatched; false if unwired/dup. */
export function requestDebate(req: DebateRequest): boolean {
  if (!requester) return false;
  if (seen.has(req.key)) return false;
  seen.add(req.key);
  void requester(req).catch(() => {
    seen.delete(req.key); // allow a later retry
  });
  return true;
}

/** Test hook. */
export function _resetDebateSeam(): void {
  requester = null;
  seen.clear();
}
