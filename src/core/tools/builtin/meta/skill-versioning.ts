/**
 * meta.skill-versioning — Git-like versioning for SUDO-AI compiled skills.
 *
 * Actions:
 *   versions     — List all stored versions for a skill
 *   rollback     — Activate a specific historical version by row id
 *   performance  — Show execution metrics per version
 *   diff         — Line-level diff between two version ids
 *   best-version — Return the version with highest historical success rate
 */

import path from 'node:path';
import { SkillVersioning } from '../../../skills/versioning.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { MIND_DB } from '../../../shared/paths.js';

const logger = createLogger('meta-skill-versioning');

const DB_PATH = MIND_DB;

// ---------------------------------------------------------------------------
// Lazy singleton — one DB connection per process
// ---------------------------------------------------------------------------

let _sv: SkillVersioning | null = null;

function getSv(): SkillVersioning {
  if (!_sv) {
    _sv = new SkillVersioning(DB_PATH);
  }
  return _sv;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtVersion(v: ReturnType<SkillVersioning['getActive']>): string {
  if (!v) return '(none)';
  const p = v.performance;
  const rate =
    p.executions > 0
      ? `${((p.successes / p.executions) * 100).toFixed(1)}%`
      : 'no data';
  return (
    `[id=${v.id}] v${v.version}${v.active ? ' (ACTIVE)' : ''}\n` +
    `  changelog : ${v.changelog || '—'}\n` +
    `  created   : ${v.createdAt}\n` +
    `  executions: ${p.executions}  successes: ${p.successes}  failures: ${p.failures}\n` +
    `  avg latency: ${p.avgLatencyMs.toFixed(2)} ms  success rate: ${rate}`
  );
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const skillVersioningTool: ToolDefinition = {
  name: 'meta.skill-versioning',
  description:
    'Version control for SUDO-AI self-compiled skills. View version history, ' +
    'roll back to any previous build, inspect per-version performance metrics, ' +
    'diff two versions, and identify the best-performing build. ' +
    'Actions: versions | rollback | performance | diff | best-version.',
  category: 'meta',
  timeout: 15_000,

  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['versions', 'rollback', 'performance', 'diff', 'best-version'],
    },
    skillName: {
      type: 'string',
      required: true,
      description:
        'Dot-namespaced skill name (e.g. "research.web-summary"). ' +
        'Required for all actions.',
    },
    versionId: {
      type: 'number',
      description:
        'Row id of the target version. Required for: rollback, diff (as versionA).',
    },
    versionIdB: {
      type: 'number',
      description:
        'Row id of the second version for diff comparison (the "after" build).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string | undefined;
    const skillName = params['skillName'] as string | undefined;

    logger.info({ session: ctx.sessionId, action, skillName }, 'meta.skill-versioning invoked');

    // Common validation
    if (!action?.trim()) {
      return { success: false, output: 'action is required.' };
    }
    if (!skillName?.trim()) {
      return { success: false, output: 'skillName is required.' };
    }

    try {
      const sv = getSv();

      switch (action) {
        // -------------------------------------------------------------------
        case 'versions': {
          const versions = sv.getVersions(skillName);
          if (versions.length === 0) {
            return {
              success: true,
              output: `No versions found for skill "${skillName}".`,
              data: { skillName, versions: [] },
            };
          }
          const lines = versions.map(fmtVersion).join('\n\n');
          return {
            success: true,
            output: `${versions.length} version(s) for "${skillName}":\n\n${lines}`,
            data: { skillName, versions },
          };
        }

        // -------------------------------------------------------------------
        case 'rollback': {
          const versionId = params['versionId'] as number | undefined;
          if (versionId === undefined || versionId === null) {
            return { success: false, output: 'versionId is required for rollback.' };
          }
          if (!Number.isInteger(Number(versionId)) || Number(versionId) <= 0) {
            return { success: false, output: `versionId must be a positive integer: got ${versionId}` };
          }

          sv.rollback(skillName, Number(versionId));
          const active = sv.getActive(skillName);

          logger.info({ skillName, versionId }, 'Skill rolled back successfully');
          return {
            success: true,
            output:
              `Skill "${skillName}" rolled back to version id=${versionId}.\n\n` +
              (active ? fmtVersion(active) : ''),
            data: { skillName, versionId, active },
          };
        }

        // -------------------------------------------------------------------
        case 'performance': {
          const versions = sv.getVersions(skillName);
          if (versions.length === 0) {
            return {
              success: true,
              output: `No versions found for skill "${skillName}".`,
              data: { skillName, versions: [] },
            };
          }

          const lines = versions.map(v => {
            const p = v.performance;
            const rate =
              p.executions > 0
                ? `${((p.successes / p.executions) * 100).toFixed(1)}%`
                : 'no data';
            return (
              `[id=${v.id}] v${v.version}${v.active ? ' *' : ''} — ` +
              `exec=${p.executions} ok=${p.successes} fail=${p.failures} ` +
              `rate=${rate} avg=${p.avgLatencyMs.toFixed(2)}ms`
            );
          });

          const best = sv.getBestVersion(skillName);
          const bestNote = best
            ? `\n\nBest performer: [id=${best.id}] v${best.version}`
            : '\n\nNo execution data to rank versions.';

          return {
            success: true,
            output: `Performance report for "${skillName}":\n\n${lines.join('\n')}${bestNote}`,
            data: { skillName, versions, best },
          };
        }

        // -------------------------------------------------------------------
        case 'diff': {
          const versionId = params['versionId'] as number | undefined;
          const versionIdB = params['versionIdB'] as number | undefined;

          if (versionId === undefined || versionId === null) {
            return { success: false, output: 'versionId (A) is required for diff.' };
          }
          if (versionIdB === undefined || versionIdB === null) {
            return { success: false, output: 'versionIdB (B) is required for diff.' };
          }

          const idA = Number(versionId);
          const idB = Number(versionIdB);

          if (!Number.isInteger(idA) || idA <= 0) {
            return { success: false, output: `versionId must be a positive integer: got ${versionId}` };
          }
          if (!Number.isInteger(idB) || idB <= 0) {
            return { success: false, output: `versionIdB must be a positive integer: got ${versionIdB}` };
          }

          const result = sv.diff(skillName, idA, idB);
          const addedStr = result.added.length > 0
            ? result.added.map(l => `+ ${l}`).join('\n')
            : '  (no new lines)';
          const removedStr = result.removed.length > 0
            ? result.removed.map(l => `- ${l}`).join('\n')
            : '  (no removed lines)';

          return {
            success: true,
            output:
              `Diff for "${skillName}" (A=id:${idA} → B=id:${idB}):\n\n` +
              `ADDED (${result.added.length} lines):\n${addedStr}\n\n` +
              `REMOVED (${result.removed.length} lines):\n${removedStr}`,
            data: { skillName, versionA: idA, versionB: idB, diff: result },
          };
        }

        // -------------------------------------------------------------------
        case 'best-version': {
          const best = sv.getBestVersion(skillName);
          if (!best) {
            return {
              success: true,
              output:
                `No executed versions found for skill "${skillName}". ` +
                'Run the skill at least once to collect performance data.',
              data: { skillName, best: null },
            };
          }

          return {
            success: true,
            output: `Best performing version of "${skillName}":\n\n${fmtVersion(best)}`,
            data: { skillName, best },
          };
        }

        // -------------------------------------------------------------------
        default:
          return { success: false, output: `Unknown action: "${action}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, skillName, err: msg }, 'meta.skill-versioning error');
      return { success: false, output: `Skill versioning error: ${msg}` };
    }
  },
};
