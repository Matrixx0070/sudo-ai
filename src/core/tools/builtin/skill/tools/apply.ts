/**
 * @file apply.ts
 * @description skill.apply — the single gated write path for the agent to
 * author or revise one of its own skills. Runs the Workshop stage→scan-gate→
 * capability-gate→path-gate→versioned-apply loop. Opt-in (SUDO_SKILL_WORKSHOP=1)
 * and dryRun by default (reports the gate verdict without writing).
 */

import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { SkillWorkshop } from '../../../../skills/workshop.js';

const logger = createLogger('skill.apply');

export const applyTool: ToolDefinition = {
  name: 'skill.apply',
  description:
    'Create/author/build one of your OWN skills — writes a versioned SKILL.md of behavioral/persona/' +
    'workflow instructions (like a Claude-Code skill). Use THIS whenever asked to "build/create/author ' +
    'a skill" that shapes how you behave, write, or work. Runs a security gate (injection scan + ' +
    'capability policy + protected-path check) before writing. dryRun=true (default) runs the gate and ' +
    'reports the verdict WITHOUT writing; dryRun=false applies. Applied skills take effect on the next ' +
    'restart. Requires SUDO_SKILL_WORKSHOP=1. (To create an executable code TOOL with parameters and an ' +
    'execute() function, use meta.tool-creator instead — NOT this.)',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 15_000,
  parameters: {
    skillName: {
      type: 'string',
      required: true,
      description: 'Skill name (letters, digits, dots, hyphens — no slashes). Becomes skills/<name>/SKILL.md.',
    },
    markdown: {
      type: 'string',
      required: true,
      description: 'The full SKILL.md content (YAML frontmatter + body). Declared caps must be within the workspace tier (fs.read/write, net.fetch, db.read — no shell.exec).',
    },
    version: {
      type: 'string',
      description: 'Semantic version, e.g. "1.0.0". Default: "1.0.0".',
      default: '1.0.0',
    },
    changelog: {
      type: 'string',
      description: 'Short note describing this version.',
    },
    dryRun: {
      type: 'boolean',
      description: 'When true (default) only runs the gate and reports the verdict. Set false to apply.',
      default: true,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const workshop = new SkillWorkshop();
    if (!workshop.isEnabled()) {
      return { success: false, output: 'skill.apply is disabled — set SUDO_SKILL_WORKSHOP=1 to enable self-authoring.' };
    }
    const skillName = typeof params['skillName'] === 'string' ? params['skillName'] : '';
    const markdown = typeof params['markdown'] === 'string' ? params['markdown'] : '';
    const version = typeof params['version'] === 'string' && params['version'].trim() ? params['version'] : '1.0.0';
    const changelog = typeof params['changelog'] === 'string' ? params['changelog'] : undefined;
    const dryRun = params['dryRun'] !== false;

    if (!skillName.trim()) return { success: false, output: 'skillName is required.' };
    if (!markdown.trim()) return { success: false, output: 'markdown (the SKILL.md content) is required.' };

    const proposal = { skillName, version, markdown, changelog };
    logger.info({ session: ctx.sessionId, skillName, version, dryRun }, 'skill.apply invoked');

    if (dryRun) {
      const g = workshop.gate(proposal);
      return {
        success: true,
        output: g.ok
          ? `Gate PASSED for "${skillName}" v${version}. Re-run with dryRun=false to apply (takes effect next restart).`
          : `Gate BLOCKED for "${skillName}":\n- ${g.reasons.join('\n- ')}`,
        data: { skillName, version, gate: g, dryRun: true },
      };
    }

    const result = workshop.apply(proposal);
    if (!result.applied) {
      return {
        success: false,
        output: `skill.apply BLOCKED for "${skillName}":\n- ${(result.blockedReasons ?? []).join('\n- ')}`,
        data: { skillName, result },
      };
    }
    return {
      success: true,
      output: `Applied skill "${skillName}" v${version} (version id ${result.versionId}) at ${result.skillPath}. It takes effect on the next restart. Use skill.rollback to undo.`,
      data: { skillName, version, result },
    };
  },
};
