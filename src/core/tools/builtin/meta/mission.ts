/**
 * meta.mission — create and steer long-running, multi-day goals.
 *
 * This is the control surface for the mission spine: a goal given here becomes
 * a durable record on disk with a verified plan, so it survives the end of this
 * turn, the end of this session, and a daemon restart. The scheduler advances
 * it while nobody is typing.
 *
 * Actions:
 *   create  — accept a goal, persist it (planning happens on the first advance)
 *   list    — all missions with progress and stall reasons
 *   status  — one mission in detail (plan, cursor, blockers, spend)
 *   unblock — clear blockers after the owner supplied what was missing
 *   pause / resume / cancel — owner control over an in-flight mission
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import {
  createMission, listMissions, loadMission, saveMission, clearBlockers, recordHistory,
} from '../../../agent/mission/store.js';
import { progressLine, stallReason, type Mission } from '../../../agent/mission/types.js';

const logger = createLogger('meta.mission');

function renderMission(m: Mission): string {
  const lines = [
    `${m.id} — ${m.status.toUpperCase()}`,
    `Goal: ${m.goal}`,
    `Progress: ${progressLine(m)}`,
  ];
  const stall = stallReason(m);
  if (stall) lines.push(`Stalled: ${stall}`);
  if (m.steps.length > 0) {
    lines.push('Plan:');
    m.steps.forEach((s, i) => {
      const mark = s.status === 'done' ? 'x' : i === m.cursor ? '>' : ' ';
      lines.push(`  [${mark}] ${i + 1}. ${s.description}`);
      if (i === m.cursor && s.status !== 'done') lines.push(`        done when: ${s.doneWhen}`);
      if (s.note) lines.push(`        note: ${s.note}`);
    });
  }
  const open = m.blockers.filter((b) => !b.resolved);
  if (open.length > 0) {
    lines.push('Blockers (need you):');
    for (const b of open) lines.push(`  - [${b.kind}] ${b.detail}`);
  }
  if (m.artifacts.length > 0) lines.push(`Artifacts: ${m.artifacts.slice(-15).join(', ')}`);
  return lines.join('\n');
}

export const missionTool: ToolDefinition = {
  name: 'meta.mission',
  description:
    'Manage long-running (multi-day) goals that must survive across sessions and restarts. ' +
    'Use action="create" when the owner gives a goal too big for one turn — it is persisted to ' +
    'disk with a verified plan and advanced autonomously. Also list/status/unblock/pause/resume/cancel.',
  category: 'meta',
  timeout: 30_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: ['create', 'list', 'status', 'unblock', 'pause', 'resume', 'cancel'],
      description: 'Operation to perform.',
    },
    goal: { type: 'string', description: 'The goal (required for create). State the outcome, not the steps.' },
    missionId: { type: 'string', description: 'Target mission (required for status/unblock/pause/resume/cancel).' },
    maxSpendUsd: { type: 'number', description: 'Optional mission-wide USD ceiling. Omit for none.' },
    deadline: { type: 'string', description: 'Optional ISO date the mission must finish by.' },
    note: { type: 'string', description: 'Context for unblock/cancel (e.g. what you supplied).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(params['action'] ?? '');
    const missionId = typeof params['missionId'] === 'string' ? params['missionId'] : '';
    logger.info({ session: ctx.sessionId, action, missionId }, 'meta.mission invoked');

    const need = (m: Mission | null): m is Mission => m !== null;

    try {
      switch (action) {
        case 'create': {
          const goal = typeof params['goal'] === 'string' ? params['goal'].trim() : '';
          if (!goal) return { success: false, output: 'goal is required for action="create".' };
          const m = createMission({
            goal,
            maxSpendUsd: typeof params['maxSpendUsd'] === 'number' ? params['maxSpendUsd'] : null,
            deadline: typeof params['deadline'] === 'string' ? params['deadline'] : null,
          });
          return {
            success: true,
            output:
              `Mission created: ${m.id}\nGoal: ${m.goal}\n` +
              'It will be planned and advanced autonomously on the next mission tick. ' +
              'Use meta.mission action="status" to follow it.',
            data: { missionId: m.id },
          };
        }

        case 'list': {
          const all = listMissions();
          if (all.length === 0) return { success: true, output: 'No missions.' };
          const lines = all.map((m) => {
            const stall = stallReason(m);
            return `${m.id} [${m.status}] ${progressLine(m)} — ${m.goal.slice(0, 70)}${stall ? ` (${stall})` : ''}`;
          });
          return { success: true, output: lines.join('\n'), data: { count: all.length } };
        }

        case 'status': {
          const m = loadMission(missionId);
          if (!need(m)) return { success: false, output: `No mission ${missionId}.` };
          return { success: true, output: renderMission(m), data: { status: m.status, cursor: m.cursor } };
        }

        case 'unblock': {
          const m = loadMission(missionId);
          if (!need(m)) return { success: false, output: `No mission ${missionId}.` };
          const note = typeof params['note'] === 'string' ? params['note'] : undefined;
          const cleared = clearBlockers(m, note);
          saveMission(m);
          return {
            success: true,
            output: cleared > 0
              ? `Cleared ${cleared} blocker(s); mission is ${m.status} and will advance on the next tick.`
              : 'No open blockers.',
          };
        }

        case 'pause':
        case 'resume':
        case 'cancel': {
          const m = loadMission(missionId);
          if (!need(m)) return { success: false, output: `No mission ${missionId}.` };
          if (m.status === 'completed' || m.status === 'cancelled') {
            return { success: false, output: `Mission is already ${m.status}.` };
          }
          m.status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
          recordHistory(m, `owner ${action}${params['note'] ? `: ${String(params['note'])}` : ''}`);
          saveMission(m);
          return { success: true, output: `Mission ${m.id} is now ${m.status}.` };
        }

        default:
          return { success: false, output: `Unknown action "${action}".` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, action }, 'meta.mission failed');
      return { success: false, output: `meta.mission failed: ${msg}` };
    }
  },
};
