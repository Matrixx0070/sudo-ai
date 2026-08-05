/**
 * @file agent/mission/store.ts
 * @description Durable, cross-session persistence for missions.
 *
 * One JSON file per mission under data/missions/. Deliberately NOT SQLite and
 * NOT session-scoped: a mission must be readable by the chat session that
 * created it, the cron session that advances it, and a process started
 * tomorrow. Files are the smallest thing that satisfies all three.
 *
 * Writes are ATOMIC (tmp file + rename) because the advance loop updates a
 * mission at the end of every run; a torn write would lose the plan and the
 * cursor together — the two things the whole subsystem exists to keep.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../shared/paths.js';
import { createLogger } from '../../shared/logger.js';
import { genId } from '../../shared/utils.js';
import type { Mission, MissionStep, MissionBlocker } from './types.js';
import { isAdvanceable } from './types.js';

const log = createLogger('agent:mission:store');

const MISSIONS_DIR = path.join(DATA_DIR, 'missions');
/** Keep the history bounded — it rides in the advance prompt. */
const MAX_HISTORY = 200;

function missionPath(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return path.join(MISSIONS_DIR, `${safe}.json`);
}

/** Write a mission atomically. Throws only if the data dir is unwritable. */
export function saveMission(m: Mission): void {
  mkdirSync(MISSIONS_DIR, { recursive: true });
  m.updatedAt = new Date().toISOString();
  if (m.history.length > MAX_HISTORY) m.history = m.history.slice(-MAX_HISTORY);
  const file = missionPath(m.id);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
  renameSync(tmp, file); // atomic on the same filesystem
}

/** Load one mission, or null when absent/corrupt. Never throws. */
export function loadMission(id: string): Mission | null {
  try {
    const file = missionPath(id);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as Mission;
  } catch (err) {
    log.warn({ id, err: String(err) }, 'mission load failed (non-fatal)');
    return null;
  }
}

/** All missions, newest first. Skips unreadable files rather than failing. */
export function listMissions(): Mission[] {
  try {
    if (!existsSync(MISSIONS_DIR)) return [];
    const out: Mission[] = [];
    for (const f of readdirSync(MISSIONS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(path.join(MISSIONS_DIR, f), 'utf8')) as Mission);
      } catch { /* skip a corrupt/partial file */ }
    }
    // Total, stable order: newest first, id as tie-break. Two missions created
    // in the same millisecond would otherwise sort arbitrarily, making
    // nextAdvanceableMission() non-deterministic run to run.
    return out.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
  } catch (err) {
    log.warn({ err: String(err) }, 'mission list failed (non-fatal)');
    return [];
  }
}

/**
 * The mission the scheduler should advance next: the OLDEST advanceable one,
 * so a long mission cannot be starved by newer arrivals. Null when idle.
 */
export function nextAdvanceableMission(): Mission | null {
  const eligible = listMissions().filter(isAdvanceable);
  if (eligible.length === 0) return null;
  // listMissions is newest-first; oldest-first here = longest-waiting served.
  return eligible[eligible.length - 1] ?? null;
}

export interface CreateMissionInput {
  goal: string;
  maxSpendUsd?: number | null;
  deadline?: string | null;
  originChannel?: string;
  originPeerId?: string;
}

/** Create and persist a new mission in 'planning'. */
export function createMission(input: CreateMissionInput): Mission {
  const now = new Date().toISOString();
  const m: Mission = {
    id: `mission-${genId()}`,
    goal: input.goal.trim(),
    createdAt: now,
    updatedAt: now,
    status: 'planning',
    steps: [],
    cursor: 0,
    artifacts: [],
    blockers: [],
    spendUsd: 0,
    maxSpendUsd: input.maxSpendUsd ?? null,
    deadline: input.deadline ?? null,
    ...(input.originChannel ? { originChannel: input.originChannel } : {}),
    ...(input.originPeerId ? { originPeerId: input.originPeerId } : {}),
    consecutiveFailures: 0,
    history: [{ at: now, event: 'mission created' }],
  };
  saveMission(m);
  log.info({ id: m.id, goal: m.goal.slice(0, 80) }, 'Mission created');
  return m;
}

/** Append a history line (bounded by saveMission). */
export function recordHistory(m: Mission, event: string): void {
  m.history.push({ at: new Date().toISOString(), event });
}

/** Attach the plan and move the mission to 'active'. */
export function setPlan(m: Mission, steps: MissionStep[]): void {
  m.steps = steps;
  m.cursor = 0;
  m.status = 'active';
  recordHistory(m, `plan set — ${steps.length} steps`);
}

/** Park the mission on a blocker (owner-facing). Idempotent per detail. */
export function addBlocker(m: Mission, blocker: Omit<MissionBlocker, 'at'>): void {
  if (m.blockers.some((b) => !b.resolved && b.detail === blocker.detail)) return;
  m.blockers.push({ ...blocker, at: new Date().toISOString() });
  m.status = 'blocked';
  recordHistory(m, `blocked (${blocker.kind}): ${blocker.detail}`);
}

/** Clear every open blocker and resume. Returns how many were cleared. */
export function clearBlockers(m: Mission, note?: string): number {
  const open = m.blockers.filter((b) => !b.resolved);
  for (const b of open) b.resolved = true;
  if (open.length > 0 && m.status === 'blocked') m.status = 'active';
  recordHistory(m, `blockers cleared (${open.length})${note ? `: ${note}` : ''}`);
  return open.length;
}

/** Delete a mission file. Returns true when one was removed. */
export function deleteMission(id: string): boolean {
  try {
    const file = missionPath(id);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    return true;
  } catch (err) {
    log.warn({ id, err: String(err) }, 'mission delete failed (non-fatal)');
    return false;
  }
}
