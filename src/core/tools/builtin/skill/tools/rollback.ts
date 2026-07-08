/**
 * @file rollback.ts
 * @description skill.rollback — restore a previous version of a self-authored
 * skill (or remove it if it had no prior version). Opt-in via
 * SUDO_SKILL_WORKSHOP=1. Pairs with skill.apply.
 */

import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { SkillWorkshop } from '../../../../skills/workshop.js';

const logger = createLogger('skill.rollback');

export const rollbackTool: ToolDefinition = {
  name: 'skill.rollback',
  description:
    'Undo the last change to one of your own skills, restoring the previous version (or removing the ' +
    'skill if it had no prior version). Takes effect on the next restart. Requires SUDO_SKILL_WORKSHOP=1.',
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
    const r = workshop.rollback(skillName, versionId);
    if (!r.restored) {
      return { success: false, output: `skill.rollback failed for "${skillName}": ${r.reason ?? 'unknown'}`, data: { skillName, r } };
    }
    return {
      success: true,
      output: `Rolled back "${skillName}" to ${r.version}. Takes effect on the next restart.`,
      data: { skillName, restoredTo: r.version },
    };
  },
};
