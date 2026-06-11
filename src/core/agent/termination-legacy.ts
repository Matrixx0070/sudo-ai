/**
 * @file termination-legacy.ts
 * @description Captures a snapshot of agent state at termination.
 *
 * Scans recent sleep sessions, distils insights, dumps deferred/pending goals,
 * and writes two human-readable markdown files atomically.
 */

import { writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';
import type { GoalEngineV2, GoalV2, GoalStatusV2 } from '../autonomy/goal-engine-v2.js';

const log = createLogger('agent:termination-legacy');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A session record extracted from a historical goal entry. */
export interface SleepSession {
  goalId: string;
  title: string;
  description: string;
  status: GoalStatusV2;
  progress: number;
  lastWorkedAt: string;
  milestones: Array<{ description: string; completed: boolean }>;
}

/** Output summary returned by runTerminationLegacy. */
export interface LegacySnapshot {
  capturedAt: string;
  sessionsScanned: number;
  insights: string[];
  legacyFilePath: string;
  deferredGoals: Array<{
    id: string;
    title: string;
    description: string;
    priority: string;
    progress: number;
  }>;
  pendingFilePath: string;
}

/** Dependencies for runTerminationLegacy. */
export interface TerminationLegacyDeps {
  goalEngine: GoalEngineV2;
  sessionWindow?: number;
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SLEEP_STATUSES: GoalStatusV2[] = ['sleeping', 'completed', 'paused', 'failed'];

function goalToSession(goal: GoalV2): SleepSession {
  return {
    goalId: goal.id,
    title: goal.title,
    description: goal.description,
    status: goal.status,
    progress: goal.progress,
    lastWorkedAt: goal.lastWorkedAt ?? goal.createdAt,
    milestones: goal.milestones.map((m) => ({
      description: m.description,
      completed: m.completed,
    })),
  };
}

function getRecentSessions(
  goalEngine: GoalEngineV2,
  sessionWindow: number,
): SleepSession[] {
  const goals = goalEngine.listGoals({ status: SLEEP_STATUSES });
  const sorted = [...goals].sort((a, b) => {
    const ta = a.lastWorkedAt ?? a.createdAt;
    const tb = b.lastWorkedAt ?? b.createdAt;
    return tb.localeCompare(ta);
  });
  return sorted.slice(0, sessionWindow).map(goalToSession);
}

function distilInsights(sessions: SleepSession[]): string[] {
  return sessions.map((s) => {
    let insight = `${s.title} reached ${s.progress}%`;
    const allMet =
      s.milestones.length > 0 && s.milestones.every((m) => m.completed);
    if (allMet) {
      insight += '; all milestones met';
    }
    if (s.progress < 10 && s.status !== 'completed') {
      insight += '; low-progress goal — review priority';
    }
    return insight;
  });
}

function formatLegacyMarkdown(
  sessions: SleepSession[],
  insights: string[],
  capturedAt: string,
): string {
  const lines: string[] = [
    '# Agent Legacy — Session Archive',
    '',
    `**Captured:** ${capturedAt}`,
    `**Sessions scanned:** ${sessions.length}`,
    '',
    '## Insights',
    '',
  ];
  if (insights.length === 0) {
    lines.push('_No sessions found._');
  } else {
    insights.forEach((ins, i) => {
      lines.push(`${i + 1}. ${ins}`);
    });
  }
  lines.push('', '## Session Details', '');
  sessions.forEach((s) => {
    lines.push(`### ${s.title}`);
    lines.push(`- **Status:** ${s.status}`);
    lines.push(`- **Progress:** ${s.progress}%`);
    lines.push(`- **Last worked:** ${s.lastWorkedAt}`);
    if (s.milestones.length > 0) {
      lines.push('- **Milestones:**');
      s.milestones.forEach((m) => {
        lines.push(`  - [${m.completed ? 'x' : ' '}] ${m.description}`);
      });
    }
    lines.push('');
  });
  return lines.join('\n');
}

function formatPendingMarkdown(
  goals: GoalV2[],
  capturedAt: string,
): string {
  const lines: string[] = [
    '# Pending Goals — For Human Review',
    '',
    `**Captured:** ${capturedAt}`,
    `**Active goals at termination:** ${goals.length}`,
    '',
  ];
  if (goals.length === 0) {
    lines.push('_No active goals at termination._');
  } else {
    goals.forEach((g, i) => {
      lines.push(`## ${i + 1}. ${g.title}`);
      lines.push(`- **ID:** ${g.id}`);
      lines.push(`- **Priority:** ${g.priority}`);
      lines.push(`- **Progress:** ${g.progress}%`);
      if (g.description) {
        lines.push(`- **Description:** ${g.description}`);
      }
      lines.push('');
    });
  }
  return lines.join('\n');
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // .tmp may not exist if writeFileSync failed — ignore
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Captures a termination legacy snapshot.
 *
 * Scans the last `sessionWindow` sleep sessions, distils insights,
 * writes `legacy.md` and `pending-for-human.md` atomically to `dataDir`.
 *
 * Never throws — returns a partial snapshot on any failure.
 */
export async function runTerminationLegacy(
  deps: TerminationLegacyDeps,
): Promise<LegacySnapshot> {
  const sessionWindow = deps.sessionWindow ?? 5;
  // Resolve the safe root at call time so an in-process DATA_DIR override
  // (e.g. the TUI adapter) is honored even though paths.ts captures at load.
  const envDataDir = process.env['DATA_DIR'];
  const safeRoot = envDataDir ? path.resolve(envDataDir) : DATA_DIR;
  const dataDir = deps.dataDir ?? safeRoot;

  // Security: reject dataDir paths that escape the safe root.
  const resolvedDataDir = path.resolve(dataDir);
  if (resolvedDataDir !== safeRoot && !resolvedDataDir.startsWith(safeRoot + path.sep)) {
    log.warn({ dataDir: '[redacted]' }, 'termination-legacy: dataDir outside safe root — refusing to write');
    return {
      capturedAt: new Date().toISOString(),
      sessionsScanned: 0,
      insights: [],
      legacyFilePath: '',
      deferredGoals: [],
      pendingFilePath: '',
    };
  }

  const capturedAt = new Date().toISOString();
  const legacyFilePath = path.join(dataDir, 'legacy.md');
  const pendingFilePath = path.join(dataDir, 'pending-for-human.md');

  let sessions: SleepSession[] = [];
  let insights: string[] = [];
  let deferredGoals: GoalV2[] = [];

  // Step 1: ensure dataDir exists
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    log.warn({ err: String(err), dataDir }, 'Could not ensure dataDir — proceeding');
  }

  // Step 2: fetch sessions
  try {
    sessions = getRecentSessions(deps.goalEngine, sessionWindow);
    insights = distilInsights(sessions);
    log.info({ sessionsScanned: sessions.length }, 'Sleep sessions scanned');
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to fetch sleep sessions — partial snapshot');
  }

  // Step 3: write legacy.md
  try {
    const content = formatLegacyMarkdown(sessions, insights, capturedAt);
    atomicWrite(legacyFilePath, content);
    log.info({ legacyFilePath }, 'legacy.md written');
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to write legacy.md');
  }

  // Step 4: fetch active goals
  try {
    deferredGoals = deps.goalEngine.listGoals({ status: 'active' });
    log.info({ deferredCount: deferredGoals.length }, 'Active goals fetched');
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to fetch active goals — partial snapshot');
  }

  // Step 5: write pending-for-human.md
  try {
    const content = formatPendingMarkdown(deferredGoals, capturedAt);
    atomicWrite(pendingFilePath, content);
    log.info({ pendingFilePath }, 'pending-for-human.md written');
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to write pending-for-human.md');
  }

  return {
    capturedAt,
    sessionsScanned: sessions.length,
    insights,
    legacyFilePath,
    deferredGoals: deferredGoals.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      priority: g.priority,
      progress: g.progress,
    })),
    pendingFilePath,
  };
}
