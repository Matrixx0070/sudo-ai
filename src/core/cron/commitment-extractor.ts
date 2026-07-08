/**
 * @file commitment-extractor.ts
 * @description Post-turn hook that detects when the agent promised a future
 * follow-up ("I'll remind you tomorrow", "I'll check back in 10 minutes") and
 * schedules it as a one-shot cron job fired via the existing scheduler — so
 * the agent actually keeps conversational commitments.
 *
 * Bounded by design (safe autonomy): a cheap regex pre-filter gates the LLM
 * call, extractions must clear a confidence floor and a horizon cap, the total
 * number of pending commitments is capped, and identical follow-ups are deduped
 * against the persisted cron store.
 */

import { createLogger } from '../shared/logger.js';
import { normaliseHeartbeatMessage, hashHeartbeatMessage } from './heartbeat-dedup.js';
import type { CronStore } from './store.js';

const log = createLogger('cron:commitments');

/** Duck-typed brain — only the image-free text call is needed. */
interface BrainLike {
  call(
    request: { messages: Array<{ role: string; content: string }>; source?: string },
    opts?: { tier?: string; strategy?: string },
  ): Promise<{ content?: string }>;
}

export interface ExtractedCommitment {
  action: string;
  when: string; // ISO datetime
  confidence: number;
}

/** Reply text must contain a future-intent marker before we spend an LLM call. */
const FUTURE_INTENT_RE =
  /\b(i['’]ll|i will|i'?m going to|later|tomorrow|tonight|remind|follow[ -]?up|check back|get back to you|in \d+\s*(second|minute|hour|day|week)s?)\b/i;

function intEnv(key: string, dflt: number, min: number, max: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt;
}

export class CommitmentExtractor {
  constructor(private readonly brain: BrainLike, private readonly store: CronStore) {}

  isEnabled(): boolean {
    return process.env['SUDO_COMMITMENTS'] === '1';
  }

  private maxJobs(): number {
    return intEnv('SUDO_COMMITMENTS_MAX_JOBS', 10, 1, 100);
  }

  private maxHorizonMs(): number {
    return intEnv('SUDO_COMMITMENTS_MAX_HORIZON_DAYS', 7, 1, 90) * 24 * 60 * 60 * 1000;
  }

  /**
   * Extract and schedule any future follow-up the agent committed to this turn.
   * Fail-open and non-blocking — the caller should not await the result on the
   * user's critical path.
   */
  async onTurnEnd(_sessionId: string, userMessage: string, finalResponse: string): Promise<void> {
    if (!FUTURE_INTENT_RE.test(finalResponse)) return; // cheap gate — no LLM unless plausible

    let commitments: ExtractedCommitment[];
    try {
      commitments = await this.extract(userMessage, finalResponse);
    } catch (err) {
      log.warn({ err: String(err) }, 'commitment extraction failed — skipping');
      return;
    }
    if (commitments.length === 0) return;

    const nowMs = Date.now();
    const horizonMs = this.maxHorizonMs();
    const existing = this.store.list();
    let pending = existing.filter((j) => j.name.startsWith('commitment:')).length;

    for (const c of commitments) {
      if (c.confidence < 0.7) continue;
      const whenMs = Date.parse(c.when);
      if (!Number.isFinite(whenMs) || whenMs <= nowMs || whenMs - nowMs > horizonMs) continue;
      if (pending >= this.maxJobs()) {
        log.warn({ cap: this.maxJobs() }, 'commitment cap reached — dropping further follow-ups');
        break;
      }
      const hash = hashHeartbeatMessage(normaliseHeartbeatMessage(c.action)).slice(0, 8);
      const name = `commitment:${hash}`;
      if (existing.some((j) => j.name === name)) continue; // dedup vs persisted store

      this.store.upsert({
        name,
        schedule: { kind: 'at', datetime: new Date(whenMs).toISOString() },
        payload: {
          kind: 'agentTurn',
          message: `[commitment follow-up] You earlier told the user: "${c.action}". It is now due — carry it out and report back to the user.`,
          lightContext: true,
        },
        sessionTarget: 'main',
        enabled: true,
        consecutiveErrors: 0,
      });
      pending++;
      log.info({ name, when: c.when, action: c.action.slice(0, 80) }, 'commitment scheduled');
    }
  }

  private async extract(userMessage: string, finalResponse: string): Promise<ExtractedCommitment[]> {
    const nowIso = new Date().toISOString();
    const prompt = [
      `Current time (ISO): ${nowIso}.`,
      'Read the exchange below. Did the ASSISTANT commit to a SPECIFIC future follow-up action with a time?',
      'Return ONLY JSON: {"commitments":[{"action":"...","when":"<ISO datetime>","confidence":0..1}]}',
      'Rules: only concrete promised follow-ups (a reminder, a check-back, a scheduled report) — NOT vague intentions.',
      'Resolve relative times ("in 10 minutes", "tomorrow 9am") to an absolute ISO datetime from the current time above.',
      'If there is no clear future commitment, return {"commitments":[]}.',
      '',
      `USER: ${userMessage.slice(0, 1500)}`,
      `ASSISTANT: ${finalResponse.slice(0, 4000)}`,
    ].join('\n');

    const resp = await this.brain.call(
      { messages: [{ role: 'user', content: prompt }], source: 'agent' },
      { tier: 'fast', strategy: 'single' },
    );
    return parseCommitments(resp.content ?? '');
  }
}

/** Parse the extractor's JSON reply defensively (strips code fences). Exported for tests. */
export function parseCommitments(text: string): ExtractedCommitment[] {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(t.slice(start, end + 1));
  } catch {
    return [];
  }
  const arr = (parsed as { commitments?: unknown }).commitments;
  if (!Array.isArray(arr)) return [];
  const out: ExtractedCommitment[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const action = typeof o['action'] === 'string' ? o['action'].trim() : '';
    const when = typeof o['when'] === 'string' ? o['when'].trim() : '';
    const confidence = typeof o['confidence'] === 'number' ? o['confidence'] : 0;
    if (action && when) out.push({ action, when, confidence });
  }
  return out;
}
