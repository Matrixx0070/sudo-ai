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
import { reloadSkillsLive } from '../../../../skills/live-reload.js';
import {
  SkillRegistryClient,
  isSkillRegistryEnabled,
  type FetchedSkill,
} from '../../../../skills/registry-client.js';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extractSkillPackage, sha256OfFile } from '../../../../skills/packaging/pack.js';
import { installFromTarball } from '../../../../skills/packaging/installer.js';
import { parseManifest, findSkillMd, MANIFEST_FILENAME } from '../../../../skills/packaging/manifest.js';
import { updateLockEntry } from '../../../../skills/packaging/lockfile.js';
import { scanSkillContent } from '../../../../skills/packaging/scan-gate.js';
import { packagingGate } from './packaging-gate.js';

const logger = createLogger('skill.install');

/** Local .tgz install branch (Spec 9): verify pin → scan → transactional apply. */
async function executeTarballInstall(
  tarballPath: string,
  expectedSha256: string | undefined,
  dryRun: boolean,
  ctx: ToolContext,
): Promise<ToolResult> {
  const gate = packagingGate(ctx, { toolName: 'skill.install (tarball)', ownerOnly: true, requireWorkshop: true });
  if (gate) return gate;
  logger.info({ session: ctx.sessionId, tarballPath, dryRun }, 'skill.install tarball invoked');
  try {
    if (dryRun) {
      const actual = sha256OfFile(tarballPath);
      if (expectedSha256 && actual !== expectedSha256.toLowerCase()) {
        return { success: false, output: `Tarball checksum mismatch: expected ${expectedSha256.slice(0, 12)}…, got ${actual.slice(0, 12)}… — would refuse to install.` };
      }
      const staging = mkdtempSync(path.join(tmpdir(), 'skill-inspect-'));
      try {
        const topDir = await extractSkillPackage(tarballPath, staging);
        const manifest = parseManifest(readFileSync(path.join(staging, topDir, MANIFEST_FILENAME), 'utf8'));
        const skillMd = findSkillMd(path.join(staging, topDir));
        if (!skillMd) return { success: false, output: 'Package has no SKILL.md.' };
        const scan = scanSkillContent(readFileSync(skillMd, 'utf8'), 'skill-install');
        return {
          success: scan.severity !== 'critical',
          output: scan.severity === 'critical'
            ? `Gate BLOCKED package "${manifest.name}" v${manifest.version}:\n- ${scan.criticalReasons.join('\n- ')}`
            : `Gate PASSED for package "${manifest.name}" v${manifest.version} (tarball sha256 ${actual.slice(0, 12)}…). `
              + 'Re-run with dryRun=false to install.',
          data: { manifest, sha256: actual, scan, dryRun: true },
        };
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    const r = await installFromTarball(tarballPath, expectedSha256);
    const reload = await reloadSkillsLive();
    return {
      success: true,
      output:
        `Installed skill package "${r.name}" v${r.version} at ${r.skillDir} `
        + `(tarball sha256 ${r.sha256.slice(0, 12)}… pinned in skills.lock.json). `
        + (reload.reloaded
          ? `Active now — no restart needed (${reload.count} skills live). Use skill.rollback to undo.`
          : 'Takes effect on the next restart. Use skill.rollback to undo.'),
      data: { name: r.name, version: r.version, sha256: r.sha256, source: r.source, scan: r.scan, reloaded: reload.reloaded },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `skill.install (tarball) failed: ${msg}` };
  }
}

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
    + 'dryRun=false to install. Installed skills are activated immediately (live reload, no restart) and can be '
    + 'removed with skill.rollback. Use skill.search first to discover names. '
    + 'Alternatively pass path (+ optional sha256 pin) to install a local .tgz package built by skill.pack. '
    + 'Requires SUDO_SKILL_WORKSHOP=1.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 30_000,
  parameters: {
    name: {
      type: 'string',
      description: 'Registry skill name exactly as listed by skill.search (e.g. "eli5"). Required unless path is given.',
    },
    version: {
      type: 'string',
      description: 'Exact version to install. Default: the version listed in the registry index.',
    },
    path: {
      type: 'string',
      description: 'Local .tgz skill package (skill.pack output) to install instead of a registry skill. Owner-only.',
    },
    sha256: {
      type: 'string',
      description: 'Expected SHA-256 of the tarball (from the skill.pack report or a registry pin). Mismatch rejects the install.',
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

    const tarballPath = typeof params['path'] === 'string' && params['path'].trim() ? params['path'].trim() : undefined;
    if (tarballPath) {
      const expected = typeof params['sha256'] === 'string' && params['sha256'].trim() ? params['sha256'].trim() : undefined;
      return executeTarballInstall(tarballPath, expected, dryRun, ctx);
    }

    if (!name) return { success: false, output: 'name is required (see skill.search for available skills), or pass path for a local .tgz package.' };
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
    // Pin in skills.lock.json (Spec 9) so skill.update can find newer versions
    // and skill.changelog can report the installed source.
    updateLockEntry(fetched.entry.name, {
      version: fetched.entry.version,
      sha256: fetched.entry.sha256.toLowerCase(),
      source: fetched.sourceUrl,
      trustTier: 'workspace',
      updatedAt: new Date().toISOString(),
    });
    const reload = await reloadSkillsLive();
    return {
      success: true,
      output:
        `Installed registry skill "${proposal.skillName}" v${proposal.version} `
        + `(version id ${result.versionId}) at ${result.skillPath} — sha256 verified against the registry pin. `
        + (reload.reloaded
          ? `It is active now — no restart needed (${reload.count} skills live). Use skill.rollback to undo.`
          : 'It takes effect on the next restart. Use skill.rollback to undo.'),
      data: { skill: fetched.entry, sourceUrl: fetched.sourceUrl, result, reloaded: reload.reloaded },
    };
  },
};
