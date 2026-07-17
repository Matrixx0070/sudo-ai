/**
 * @file agent/second-opinion-seam.ts
 * @description G-F32WIRE repair. F32 (second-opinion / anti-sycophancy) shipped
 * as Drive-side machinery (src/core/gdrive/second-opinion.ts: export packet →
 * independent reviewer writes a dissent memo → resolve) but had NO caller — the
 * live agent never requested a second opinion on anything.
 *
 * This is the injected seam that gives it one. The agent can't import
 * core/gdrive (hot-path isolation), and the review cycle does Drive I/O + a
 * second LLM call, so requests are FIRE-AND-FORGET: requestSecondOpinion()
 * returns immediately and never blocks a turn. cli.ts wires the requester to
 * the gdrive cycle with the reviewer pinned to the INDEPENDENT judge route
 * (G-JUDGE / invariant 7 — the reviewer must not be the decider's route).
 *
 * In-process dedup keeps a repeated decision from spamming the review queue.
 */

export interface SecondOpinionRequest {
  /** Stable key for dedup (e.g. a hash of the decision). [\w-]{1,64}. */
  key: string;
  /** Neutral question — NO conclusion (the gdrive side re-validates this). */
  question: string;
  evidence: string[];
  constraints: string[];
  impact: 'high' | 'critical';
}

export type SecondOpinionRequester = (req: SecondOpinionRequest) => Promise<void>;

let requester: SecondOpinionRequester | null = null;
const seen = new Set<string>();

/** cli.ts wires this to the gdrive second-opinion cycle; null to unwire. */
export function setSecondOpinionRequester(fn: SecondOpinionRequester | null): void {
  requester = fn;
  if (!fn) seen.clear();
}

/** Whether a live requester is wired (lets callers skip building a packet). */
export function secondOpinionEnabled(): boolean {
  return requester !== null;
}

/**
 * Fire-and-forget request. Returns true if a NEW request was dispatched, false
 * if unwired or a duplicate. Never throws, never awaits the cycle — the turn
 * proceeds; the dissent memo lands in the review queue asynchronously.
 */
export function requestSecondOpinion(req: SecondOpinionRequest): boolean {
  if (!requester) return false;
  if (seen.has(req.key)) return false;
  seen.add(req.key);
  void requester(req).catch(() => {
    // Fail-open: a failed review request must never disturb the turn. Allow a
    // later retry of the same decision by forgetting the key.
    seen.delete(req.key);
  });
  return true;
}

/** Test hook. */
export function _resetSecondOpinionSeam(): void {
  requester = null;
  seen.clear();
}
