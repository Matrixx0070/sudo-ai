/**
 * @file packaging-gate.ts
 * @description Shared preconditions for the Spec 9 packaging tools
 * (skill.init/pack/publish/update/changelog and tarball installs):
 *   - SUDO_SKILL_PACKAGING kill-switch (default ON, =0 disables the suite)
 *   - SUDO_SKILL_WORKSHOP=1 for anything that writes into skills/
 *   - owner-only for anything that changes what code the agent runs
 *     (untrusted callers — hooks/email/community — get isOwner === false)
 */

import type { ToolContext, ToolResult } from '../../../types.js';
import { SkillWorkshop } from '../../../../skills/workshop.js';

/** Default ON per repo policy; SUDO_SKILL_PACKAGING=0 disables. */
export function isPackagingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_SKILL_PACKAGING'] !== '0';
}

export interface PackagingGateOpts {
  toolName: string;
  /** Require the skills/ write gate (SUDO_SKILL_WORKSHOP=1). */
  requireWorkshop?: boolean;
  /** Deny callers with isOwner === false (undefined = internal turn, allowed). */
  ownerOnly?: boolean;
}

/** Returns a failure ToolResult when a precondition fails, else null. */
export function packagingGate(ctx: ToolContext, opts: PackagingGateOpts): ToolResult | null {
  if (!isPackagingEnabled()) {
    return { success: false, output: `${opts.toolName} is disabled (SUDO_SKILL_PACKAGING=0).` };
  }
  if (opts.ownerOnly && ctx.isOwner === false) {
    return { success: false, output: `${opts.toolName} is owner-only — this caller is not the owner.` };
  }
  if (opts.requireWorkshop && !new SkillWorkshop().isEnabled()) {
    return { success: false, output: `${opts.toolName} is disabled — set SUDO_SKILL_WORKSHOP=1 to enable the skill write gate.` };
  }
  return null;
}
