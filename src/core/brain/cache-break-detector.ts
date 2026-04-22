import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:cache-break');

export type CacheBreakVector =
  | 'model_changed'
  | 'persona_changed'
  | 'tool_list_changed'
  | 'system_prompt_changed'
  | 'temperature_changed'
  | 'max_tokens_changed'
  | 'heartbeat_toggled'
  | 'consciousness_state_changed'
  | 'mood_changed'
  | 'workspace_file_changed'
  | 'memory_context_changed'
  | 'custom_instructions_changed'
  | 'session_reset'
  | 'manual_override';

export interface CacheBreakEvent {
  timestamp: string;
  vector: CacheBreakVector;
  previousValue: unknown;
  newValue: unknown;
  latched: boolean; // true = suppressed by sticky latch
}

export interface CacheState {
  model: string;
  persona: string;
  toolCount: number;
  temperature: number;
  maxTokens: number;
  heartbeat: boolean;
  mood: string;
  customInstructions: string;
}

export class CacheBreakDetector {
  private state: Partial<CacheState> = {};
  private events: CacheBreakEvent[] = [];

  // Sticky latches — if a vector fired in the last N ms, suppress it
  private readonly LATCH_DURATION_MS = 30_000; // 30 seconds
  private latchMap = new Map<CacheBreakVector, number>(); // vector → last fire timestamp

  /**
   * Check if updating a field would break the cache.
   * If yes, record the event. Uses sticky latches to suppress rapid re-fires.
   */
  check<K extends keyof CacheState>(field: K, newValue: CacheState[K]): boolean {
    const vector = this.fieldToVector(field);
    const prev = this.state[field];

    if (prev === undefined) {
      // First time setting — initialize, no break
      (this.state as Record<K, CacheState[K]>)[field] = newValue;
      return false;
    }

    if (prev === newValue) return false; // no change

    // Check sticky latch
    const lastFire = this.latchMap.get(vector) ?? 0;
    const latched = Date.now() - lastFire < this.LATCH_DURATION_MS;

    const event: CacheBreakEvent = {
      timestamp: new Date().toISOString(),
      vector,
      previousValue: prev,
      newValue,
      latched,
    };

    this.events.push(event);
    if (this.events.length > 500) this.events = this.events.slice(-500);

    if (!latched) {
      this.latchMap.set(vector, Date.now());
      log.debug({ vector, prev, new: newValue }, 'Cache break detected');
    }

    // Update state
    (this.state as Record<K, CacheState[K]>)[field] = newValue;

    return !latched; // returns true only if this is a real (un-latched) cache break
  }

  /** Record a session reset — always a cache break, no latch. */
  recordReset(): void {
    this.events.push({
      timestamp: new Date().toISOString(),
      vector: 'session_reset',
      previousValue: null,
      newValue: null,
      latched: false,
    });
    this.state = {};
    this.latchMap.clear();
  }

  /** Get break events in the last N minutes. */
  recent(minutes = 5): CacheBreakEvent[] {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return this.events.filter((e) => new Date(e.timestamp).getTime() > cutoff);
  }

  /** Count breaks by vector in the last hour. */
  breakCounts(): Record<CacheBreakVector, number> {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const counts = {} as Record<CacheBreakVector, number>;
    for (const e of this.events) {
      if (new Date(e.timestamp).getTime() > cutoff && !e.latched) {
        counts[e.vector] = (counts[e.vector] ?? 0) + 1;
      }
    }
    return counts;
  }

  private fieldToVector(field: keyof CacheState): CacheBreakVector {
    const map: Record<keyof CacheState, CacheBreakVector> = {
      model: 'model_changed',
      persona: 'persona_changed',
      toolCount: 'tool_list_changed',
      temperature: 'temperature_changed',
      maxTokens: 'max_tokens_changed',
      heartbeat: 'heartbeat_toggled',
      mood: 'mood_changed',
      customInstructions: 'custom_instructions_changed',
    };
    return map[field];
  }
}

// Singleton
export const cacheBreakDetector = new CacheBreakDetector();
