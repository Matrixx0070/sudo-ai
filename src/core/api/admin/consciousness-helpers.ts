/**
 * @file admin/consciousness-helpers.ts
 * @description DB helpers and constants for consciousness.handler.ts.
 */

import { existsSync } from 'node:fs';
import { createLogger } from '../../shared/logger.js';
import { dataPath } from '../../shared/paths.js';
import type { IncomingMessage } from 'node:http';

const log = createLogger('api:admin:consciousness-helpers');

export const DB_PATH = dataPath('consciousness.db');

export const CONSCIOUSNESS_MODULES = [
  'embodied-state',
  'spreading-activation',
  'emotional-memory',
  'attention-system',
  'cognitive-stream',
  'episodic-memory',
  'drive-system',
  'world-model',
  'self-model',
  'theory-of-mind',
  'prospective-memory',
  'relationship-model',
  'internal-dialogue',
  'metacognition',
  'counterfactual-engine',
  'temporal-self',
  'sleep-cycle',
  'self-evolution',
  'surprise-engine',
  'procedural-memory',
] as const;

/** Primary table that indicates recent activity for each module. */
export const MODULE_TABLE_MAP: Record<string, string> = {
  'embodied-state':        'body_state_log',
  'spreading-activation':  'concept_nodes',
  'emotional-memory':      'somatic_markers',
  'attention-system':      'thoughts',
  'cognitive-stream':      'thoughts',
  'episodic-memory':       'episodes',
  'drive-system':          'drive_log',
  'world-model':           'world_model',
  'self-model':            'capability_assessments',
  'theory-of-mind':        'user_models',
  'prospective-memory':    'intentions',
  'relationship-model':    'relationships',
  'internal-dialogue':     'debates',
  'metacognition':         'reflections',
  'counterfactual-engine': 'counterfactuals',
  'temporal-self':         'self_snapshots',
  'sleep-cycle':           'sleep_sessions',
  'self-evolution':        'evolution_proposals',
  'surprise-engine':       'surprise_events',
  'procedural-memory':     'procedures',
};

export type BetterSqliteDb = import('better-sqlite3').Database;

/** Open the consciousness DB read-only. Returns null when the file is absent. */
export async function openDb(): Promise<BetterSqliteDb | null> {
  if (!existsSync(DB_PATH)) {
    log.debug({ dbPath: DB_PATH }, 'consciousness.db not found');
    return null;
  }
  try {
    const Database = (await import('better-sqlite3')).default;
    return new Database(DB_PATH, { readonly: true });
  } catch (err) {
    log.error({ err }, 'openDb: failed to open consciousness.db');
    return null;
  }
}

/** Safely close the DB handle. */
export function closeDb(db: BetterSqliteDb | null): void {
  try {
    if (db && db.open) db.close();
  } catch (err) {
    log.warn({ err }, 'closeDb: error closing consciousness.db');
  }
}

/** Parse a query-string integer parameter with bounds. */
export function parseIntParam(
  req: IncomingMessage,
  name: string,
  def: number,
  min: number,
  max: number,
): number {
  const url = req.url ?? '';
  const qs = url.includes('?')
    ? new URLSearchParams(url.split('?')[1])
    : new URLSearchParams();
  const raw = qs.get(name);
  if (raw === null) return def;
  const n = parseInt(raw, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Attempt to JSON-parse a value, returning a fallback on failure. */
export function tryParseJson(raw: string, fallback: unknown): unknown {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
