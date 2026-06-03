/**
 * @file skill-sandbox.ts
 * @description SkillSandbox — capability enforcement and trust tier policy.
 *
 * Trust tier enforcement:
 *   - 'bundled': all tools allowed (fs.read, fs.write, net.fetch, db.read, db.write, shell.exec, skill.load)
 *   - 'indexed': most tools (fs.read, net.fetch, db.read)
 *   - 'unreviewed': minimal (fs.read only)
 *   - 'workspace': user-override (fs.read, fs.write, net.fetch, db.read)
 *
 * Kill-switch: SUDO_SKILLS_SANDBOX_DISABLE=1 allows all tools (bypasses enforcement).
 */

import { createLogger } from '../shared/logger.js';
import type { SkillTrustTier, Capability } from '../shared/wave10-types.js';
import { DEFAULT_TIER_CAPS } from '../shared/wave10-types.js';
import type { InstalledSkill } from './skills-hub-types.js';

const log = createLogger('skills:sandbox');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All tool names by capability category. */
const TOOLS_BY_CAPABILITY: Record<string, string[]> = {
  'fs.read': ['coder.read-file', 'coder.list-directory', 'file.read', 'fs.readFile'],
  'fs.write': ['coder.write-file', 'coder.create-file', 'file.write', 'fs.writeFile', 'fs.appendFile'],
  'net.fetch': ['coder.fetch', 'web.search', 'http.get', 'http.post'],
  'db.read': ['db.query', 'db.read', 'sql.select'],
  'db.write': ['db.insert', 'db.update', 'db.delete', 'sql.insert', 'sql.update', 'sql.delete'],
  'shell.exec': ['system.shell', 'bash.exec', 'cmd.run'],
  'skill.load': ['skill.import', 'skill.activate'],
};

/** Flat list of all tool names. */
const ALL_TOOLS = Object.values(TOOLS_BY_CAPABILITY).flat();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if sandbox is disabled via kill-switch. */
function isSandboxDisabled(): boolean {
  return process.env['SUDO_SKILLS_SANDBOX_DISABLE'] === '1';
}

/**
 * Get the list of allowed tool names for a trust tier.
 * Uses DEFAULT_TIER_CAPS from wave10-types.ts as the source of truth.
 */
export function getCapabilityList(trustTier: SkillTrustTier): string[] {
  const caps = DEFAULT_TIER_CAPS[trustTier] ?? DEFAULT_TIER_CAPS.unreviewed;
  const tools: string[] = [];

  for (const cap of caps) {
    const toolList = TOOLS_BY_CAPABILITY[cap];
    if (toolList) {
      tools.push(...toolList);
    }
  }

  return tools;
}

// ---------------------------------------------------------------------------
// SkillSandbox class
// ---------------------------------------------------------------------------

export class SkillSandbox {
  /**
   * Check if a skill is allowed to use a specific tool based on its trust tier.
   *
   * @param skill - The installed skill with trust tier and caps.
   * @param requestedTool - The tool name being requested.
   * @returns True if the tool is allowed for this skill's trust tier.
   */
  checkCapabilities(skill: InstalledSkill, requestedTool: string): boolean {
    // Kill-switch bypass
    if (isSandboxDisabled()) {
      log.debug({ skillName: skill.name, tool: requestedTool }, 'sandbox disabled — allowing all tools');
      return true;
    }

    const { trustTier, caps } = skill;
    const allowedTools = getCapabilityList(trustTier);

    // Check if the requested tool is in the allowed list for this tier
    if (!allowedTools.includes(requestedTool)) {
      log.warn(
        { skillName: skill.name, trustTier, tool: requestedTool },
        'tool blocked by trust tier policy',
      );
      return false;
    }

    // Additional check: if skill declares specific caps, verify tool maps to allowed cap
    if (caps.length > 0) {
      const toolCap = this.findToolCapability(requestedTool);
      if (toolCap && !caps.includes(toolCap)) {
        log.warn(
          { skillName: skill.name, tool: requestedTool, skillCaps: caps },
          'tool blocked — skill does not declare required capability',
        );
        return false;
      }
    }

    log.debug({ skillName: skill.name, tool: requestedTool }, 'tool allowed');
    return true;
  }

  /**
   * Get the list of allowed tools for a skill based on its trust tier.
   *
   * @param skill - The installed skill.
   * @returns Array of allowed tool names.
   */
  getAllowedTools(skill: InstalledSkill): string[] {
    if (isSandboxDisabled()) {
      return [...ALL_TOOLS];
    }
    return getCapabilityList(skill.trustTier);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Find which capability category a tool belongs to. */
  private findToolCapability(toolName: string): Capability | null {
    for (const [cap, tools] of Object.entries(TOOLS_BY_CAPABILITY)) {
      if (tools.includes(toolName)) {
        return cap as Capability;
      }
    }
    return null;
  }
}
