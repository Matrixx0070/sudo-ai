/**
 * @file update.ts
 * @description skill.update — find and apply newer registry versions of
 * lockfile-pinned skills (Spec 9 step 3). Without yes=true it ONLY reports
 * (version, changelog, diffstat, scanner delta) — never a silent auto-update.
 * With yes=true each skill updates transactionally (snapshot → checksum-
 * verified fetch → scanner gate → swap → lockfile pin); a scanner-CRITICAL
 * candidate aborts THAT skill's update, and one failed skill never blocks or
 * half-applies the rest. Old versions are restorable with skill.rollback.
 */

import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { isSkillRegistryEnabled } from '../../../../skills/registry-client.js';
import { checkForUpdates, applyUpdates, type AvailableUpdate } from '../../../../skills/packaging/updater.js';
import { reloadSkillsLive } from '../../../../skills/live-reload.js';
import { packagingGate } from './packaging-gate.js';

const logger = createLogger('skill.update');

function describeUpdate(u: AvailableUpdate): string {
  const scanNote = u.scan.severity === 'critical'
    ? ` ⛔ scanner CRITICAL — will NOT be applied: ${u.scan.criticalReasons.join('; ')}`
    : u.scanNewReasons.length > 0
      ? ` ⚠ new scanner findings: ${u.scanNewReasons.join('; ')}`
      : '';
  return `- ${u.name} ${u.current} → ${u.latest} (+${u.diffstat.added}/-${u.diffstat.removed} lines)`
    + `${u.changelog ? ` — ${u.changelog}` : ''}${scanNote}`;
}

export const updateTool: ToolDefinition = {
  name: 'skill.update',
  description:
    'Check installed (lockfile-pinned) skills against the registry for newer versions and show '
    + 'changelog + diffstat + scanner delta per update. Default is CHECK-ONLY; set yes=true to apply '
    + '(all available updates, or one skill via name). Updates are transactional per skill, scanner '
    + 'CRITICAL aborts that skill, and skill.rollback restores the prior version. Owner-only; '
    + 'requires SUDO_SKILL_WORKSHOP=1 to apply.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 60_000,
  parameters: {
    name: {
      type: 'string',
      description: 'Update only this skill. Default: all lockfile-pinned skills ("update --all").',
    },
    yes: {
      type: 'boolean',
      description: 'Approve applying the updates. When false (default), only report what is available.',
      default: false,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const yes = params['yes'] === true || params['yes'] === 'true';
    const gate = packagingGate(ctx, { toolName: 'skill.update', ownerOnly: true, requireWorkshop: yes });
    if (gate) return gate;
    if (!isSkillRegistryEnabled()) {
      return { success: false, output: 'Skill registry is disabled (SUDO_SKILL_REGISTRY=0).' };
    }
    const name = typeof params['name'] === 'string' && params['name'].trim() ? params['name'].trim() : undefined;

    logger.info({ session: ctx.sessionId, name, yes }, 'skill.update invoked');
    let check;
    try {
      check = await checkForUpdates();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `skill.update check failed: ${msg}` };
    }

    let updates = check.updates;
    if (name) {
      updates = updates.filter((u) => u.name.toLowerCase() === name.toLowerCase());
      if (updates.length === 0) {
        return {
          success: true,
          output: `"${name}" is up to date (or not pinned in skills.lock.json / not in the registry).`,
          data: { updates: [], unmanaged: check.unmanaged },
        };
      }
    }
    const errorNote = check.errors.length > 0
      ? `\nCould not check (fetch/verify failed): ${check.errors.map((e) => `${e.name} (${e.error})`).join('; ')}.`
      : '';
    if (updates.length === 0) {
      return {
        success: check.errors.length === 0,
        output: `All pinned skills are up to date (registry: ${check.sourceUrl}).`
          + (check.unmanaged.length > 0 ? ` Not registry-managed: ${check.unmanaged.join(', ')}.` : '')
          + errorNote,
        data: { updates: [], unmanaged: check.unmanaged, errors: check.errors },
      };
    }

    const report = updates.map(describeUpdate).join('\n');
    if (!yes) {
      return {
        success: true,
        output: `${updates.length} update(s) available:\n${report}${errorNote}\n\nRe-run with yes=true to apply.`,
        data: { updates, unmanaged: check.unmanaged, errors: check.errors, applied: false },
      };
    }

    // Scanner CRITICAL aborts that skill's update up front (acceptance 4).
    const blocked = updates.filter((u) => u.scan.severity === 'critical');
    const toApply = updates.filter((u) => u.scan.severity !== 'critical');
    const result = await applyUpdates(toApply.map((u) => ({ name: u.name, latest: u.latest })));
    const reload = result.applied.length > 0 ? await reloadSkillsLive() : { reloaded: false, count: 0 };


    const checkErrors = name ? check.errors.filter((e) => e.name.toLowerCase() === name.toLowerCase()) : check.errors;
    const lines = [
      ...result.applied.map((a) => `✓ ${a.name} → ${a.version}${a.changelog ? ` — ${a.changelog}` : ''}`),
      ...blocked.map((b) => `⛔ ${b.name} ${b.current} → ${b.latest} ABORTED (scanner CRITICAL): ${b.scan.criticalReasons.join('; ')}`),
      ...result.failed.map((f) => `✗ ${f.name} failed (left at prior version): ${f.error}`),
      ...checkErrors.map((e) => `✗ ${e.name} failed (left at prior version): ${e.error}`),
    ];
    const ok = result.failed.length === 0 && blocked.length === 0 && checkErrors.length === 0;
    return {
      success: ok,
      output:
        `Applied ${result.applied.length}/${updates.length} update(s):\n${lines.join('\n')}`
        + (result.applied.length > 0
          ? `\n${reload.reloaded ? `Active now — no restart needed (${reload.count} skills live).` : 'Takes effect on the next restart.'} Use skill.rollback <name> to undo.`
          : ''),
      data: { applied: result.applied, failed: result.failed, blocked, reloaded: reload.reloaded },
    };
  },
};
