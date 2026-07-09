/**
 * @file install.ts
 * @description skill.install — install a skill from the public SUDO skill
 * registry (sudoapi.shop) through the SAME fail-closed Workshop gate as
 * self-authored skills.
 *
 * Trust chain, in order:
 *   1. Registry index entry pins the skill's SHA-256; the client refuses
 *      content that does not hash to the pin (registry-client.ts).
 *   2. The verified markdown then runs the Workshop gate — prompt-injection
 *      scan, capability policy (workspace tier only), protected-path check.
 *   3. Only a gate-passing skill is written, versioned, and rollback-able
 *      (skill.rollback), taking effect on the next restart.
 *
 * dryRun defaults to TRUE (mirrors skill.apply): report the gate verdict
 * without writing. Requires SUDO_SKILL_WORKSHOP=1 (the write gate) and the
 * registry enabled (SUDO_SKILL_REGISTRY != 0).
 */

import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { SkillWorkshop, type WorkshopProposal } from '../../../../skills/workshop.js';
import {
  SkillRegistryClient,
  isSkillRegistryEnabled,
  type FetchedSkill,
} from '../../../../skills/registry-client.js';

const logger = createLogger('skill.install');

/** Build the Workshop proposal for a checksum-verified registry skill. */
export function buildInstallProposal(fetched: FetchedSkill): WorkshopProposal {
  return {
    skillName: fetched.entry.name,
    version: fetched.entry.version,
    markdown: fetched.markdown,
    changelog: `Installed from skill registry (${fetched.sourceUrl}), sha256 ${fetched.entry.sha256.slice(0, 12)}…`,
  };
}

export const installTool: ToolDefinition = {
  name: 'skill.install',
  description:
    'Install a community skill from the public SUDO skill registry (sudoapi.shop) by name. '
    + 'Fetches the skill, verifies its SHA-256 pin from the registry index, then runs the same '
    + 'security gate as skill.apply (injection scan + capability policy + protected paths) before '
    + 'writing. dryRun=true (default) reports the gate verdict WITHOUT installing; set '
    + 'dryRun=false to install. Installed skills take effect on the next restart and can be '
    + 'removed with skill.rollback. Use skill.search first to discover names. '
    + 'Requires SUDO_SKILL_WORKSHOP=1.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 30_000,
  parameters: {
    name: {
      type: 'string',
      required: true,
      description: 'Registry skill name exactly as listed by skill.search (e.g. "eli5").',
    },
    version: {
      type: 'string',
      description: 'Exact version to install. Default: the version listed in the registry index.',
    },
    dryRun: {
      type: 'boolean',
      description: 'When true (default) only fetch + verify + gate and report. Set false to install.',
      default: true,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
    const version = typeof params['version'] === 'string' && params['version'].trim() ? params['version'].trim() : undefined;
    const rawDryRun = params['dryRun'];
    const dryRun = !(rawDryRun === false || rawDryRun === 'false');

    if (!name) return { success: false, output: 'name is required (see skill.search for available skills).' };
    if (!isSkillRegistryEnabled()) {
      return { success: false, output: 'Skill registry is disabled (SUDO_SKILL_REGISTRY=0).' };
    }
    const workshop = new SkillWorkshop();
    if (!workshop.isEnabled()) {
      return { success: false, output: 'skill.install is disabled — set SUDO_SKILL_WORKSHOP=1 to enable the skill write gate.' };
    }

    logger.info({ session: ctx.sessionId, name, version, dryRun }, 'skill.install invoked');

    let fetched: FetchedSkill;
    try {
      fetched = await new SkillRegistryClient().fetchSkill(name, version);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ session: ctx.sessionId, name, err: msg }, 'skill.install fetch/verify failed');
      return { success: false, output: `skill.install failed before the gate: ${msg}` };
    }

    const proposal = buildInstallProposal(fetched);

    if (dryRun) {
      const g = workshop.gate(proposal);
      return {
        success: true,
        output: g.ok
          ? `Gate PASSED for registry skill "${proposal.skillName}" v${proposal.version} `
            + `(sha256 verified, source: ${fetched.sourceUrl}). Re-run with dryRun=false to install.`
          : `Gate BLOCKED registry skill "${proposal.skillName}":\n- ${g.reasons.join('\n- ')}`,
        data: { skill: fetched.entry, sourceUrl: fetched.sourceUrl, gate: g, dryRun: true },
      };
    }

    const result = workshop.apply(proposal);
    if (!result.applied) {
      return {
        success: false,
        output: `skill.install BLOCKED for "${proposal.skillName}":\n- ${(result.blockedReasons ?? []).join('\n- ')}`,
        data: { skill: fetched.entry, sourceUrl: fetched.sourceUrl, result },
      };
    }
    return {
      success: true,
      output:
        `Installed registry skill "${proposal.skillName}" v${proposal.version} `
        + `(version id ${result.versionId}) at ${result.skillPath} — sha256 verified against the registry pin. `
        + 'It takes effect on the next restart. Use skill.rollback to undo.',
      data: { skill: fetched.entry, sourceUrl: fetched.sourceUrl, result },
    };
  },
};
