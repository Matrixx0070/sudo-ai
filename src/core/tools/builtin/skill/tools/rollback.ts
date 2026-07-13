/**
 * @file rollback.ts
 * @description skill.rollback — restore a previous version of a self-authored
 * skill (or remove it if it had no prior version). Opt-in via
 * SUDO_SKILL_WORKSHOP=1. Pairs with skill.apply.
 */

import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { SkillWorkshop } from '../../../../skills/workshop.js';
import { reloadSkillsLive } from '../../../../skills/live-reload.js';
import { latestSnapshot, restoreSnapshot } from '../../../../skills/packaging/versions-store.js';
import { updateLockEntry, removeLockEntry } from '../../../../skills/packaging/lockfile.js';

const logger = createLogger('skill.rollback');

export const rollbackTool: ToolDefinition = {
  name: 'skill.rollback',
  description:
    'Undo the last change to one of your own skills, restoring the previous version (or removing the ' +
    'skill if it had no prior version). Takes effect immediately (live reload, no restart). Requires SUDO_SKILL_WORKSHOP=1.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 15_000,
  parameters: {
    skillName: {
      type: 'string',
      required: true,
      description: 'Skill to roll back.',
    },
    versionId: {
      type: 'number',
      description: 'Optional specific version id to restore. Default: the most recent prior version.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const workshop = new SkillWorkshop();
    if (!workshop.isEnabled()) {
      return { success: false, output: 'skill.rollback is disabled — set SUDO_SKILL_WORKSHOP=1 to enable.' };
    }
    const skillName = typeof params['skillName'] === 'string' ? params['skillName'] : '';
    const versionId = typeof params['versionId'] === 'number' ? params['versionId'] : undefined;
    if (!skillName.trim()) return { success: false, output: 'skillName is required.' };

    logger.info({ session: ctx.sessionId, skillName, versionId }, 'skill.rollback invoked');

    // Packaged skills (Spec 9): restore the last on-disk snapshot — a whole-
    // directory copy (manifest + extra files) taken before the last
    // install/update — and re-pin the lockfile to it. Explicit versionId keeps
    // the legacy SQLite path below.
    if (versionId === undefined) {
      let snap;
      try {
        snap = latestSnapshot(skillName);
      } catch {
        snap = undefined; // unsafe name — legacy path rejects it with its own message
      }
      if (snap) {
        try {
          const meta = restoreSnapshot(skillName, snap);
          if (meta.sha256 === '' && meta.version === '0.0.0') removeLockEntry(skillName);
          else updateLockEntry(skillName, { version: meta.version, sha256: meta.sha256, source: meta.source, trustTier: meta.trustTier, updatedAt: new Date().toISOString() });
          const reloadSnap = await reloadSkillsLive();
          return {
            success: true,
            output: `Rolled back "${skillName}" to v${meta.version} (restored from skills/.versions snapshot). `
              + (reloadSnap.reloaded ? `Active now — no restart needed (${reloadSnap.count} skills live).` : 'Takes effect on the next restart.'),
            data: { skillName, restoredTo: meta.version, fromSnapshot: true, reloaded: reloadSnap.reloaded },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, output: `skill.rollback snapshot restore failed for "${skillName}": ${msg}` };
        }
      }
    }

    const r = workshop.rollback(skillName, versionId);
    if (!r.restored) {
      return { success: false, output: `skill.rollback failed for "${skillName}": ${r.reason ?? 'unknown'}`, data: { skillName, r } };
    }
    const reload = await reloadSkillsLive();
    return {
      success: true,
      output: `Rolled back "${skillName}" to ${r.version}. `
        + (reload.reloaded ? `Active now — no restart needed (${reload.count} skills live).` : 'Takes effect on the next restart.'),
      data: { skillName, restoredTo: r.version, reloaded: reload.reloaded },
    };
  },
};
