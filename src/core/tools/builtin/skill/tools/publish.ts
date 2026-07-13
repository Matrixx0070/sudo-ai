/**
 * @file publish.ts
 * @description skill.publish — publish a packed skill into a registry checkout
 * (Spec 9 step 4). Phase-1 registry is the existing GitHub-Pages/raw-repo
 * index (schema:1 index.json + skills/<name>/SKILL.md), so publishing means:
 * pack → write SKILL.md + tarball into the registry working copy → upsert the
 * index entry with the content SHA-256 pin + changelog. The owner then commits
 * and pushes/PRs the registry repo — this tool never pushes on its own.
 * Hash pin is phase 1; minisign signatures are deferred to phase 2.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { PROJECT_ROOT } from '../../../../shared/paths.js';
import type { RegistryIndex, RegistrySkillEntry } from '../../../../skills/registry-client.js';
import { packSkill } from '../../../../skills/packaging/pack.js';
import { findSkillMd } from '../../../../skills/packaging/manifest.js';
import { packagingGate } from './packaging-gate.js';

const logger = createLogger('skill.publish');

function loadIndex(indexPath: string): RegistryIndex {
  if (!existsSync(indexPath)) return { schema: 1, skills: [] };
  const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as RegistryIndex;
  if (parsed?.schema !== 1 || !Array.isArray(parsed.skills)) {
    throw new Error(`${indexPath} is not a schema:1 registry index`);
  }
  return parsed;
}

export const publishTool: ToolDefinition = {
  name: 'skill.publish',
  description:
    'Publish a skill to a registry working copy: packs it (scanner-gated), writes skills/<name>/SKILL.md '
    + 'and the .tgz into the registry directory, and upserts the index.json entry with the SHA-256 pin '
    + 'and changelog. The registry directory is a local checkout of the registry repo (param registryDir '
    + 'or SUDO_SKILL_PUBLISH_DIR); commit and push/PR it afterwards to go live. dryRun=true (default) '
    + 'reports what would be written. Owner-only.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 30_000,
  parameters: {
    name: {
      type: 'string',
      required: true,
      description: 'Skill directory name under skills/.',
    },
    changelog: {
      type: 'string',
      description: 'One-line "what changed" recorded in the index entry (shown by skill.update). Default: the manifest changelog.',
    },
    registryDir: {
      type: 'string',
      description: 'Registry working-copy directory (contains or will contain index.json). Default: SUDO_SKILL_PUBLISH_DIR.',
    },
    dryRun: {
      type: 'boolean',
      description: 'When true (default) pack + report without writing to the registry directory.',
      default: true,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gate = packagingGate(ctx, { toolName: 'skill.publish', ownerOnly: true });
    if (gate) return gate;

    const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
    const dryRun = !(params['dryRun'] === false || params['dryRun'] === 'false');
    const registryDir = (typeof params['registryDir'] === 'string' && params['registryDir'].trim())
      ? path.resolve(params['registryDir'].trim())
      : process.env['SUDO_SKILL_PUBLISH_DIR']?.trim();
    if (!name) return { success: false, output: 'name is required.' };
    if (name.includes('..') || name.includes('/')) return { success: false, output: `Invalid skill name "${name}".` };
    if (!registryDir) {
      return { success: false, output: 'No registry directory — pass registryDir or set SUDO_SKILL_PUBLISH_DIR to a local checkout of the registry repo.' };
    }

    const skillDir = path.join(PROJECT_ROOT, 'skills', name);
    if (!existsSync(skillDir)) return { success: false, output: `skills/${name}/ not found.` };

    logger.info({ session: ctx.sessionId, name, registryDir, dryRun }, 'skill.publish invoked');
    try {
      const packed = await packSkill(skillDir); // scanner-gated
      const skillMd = findSkillMd(skillDir)!;
      const markdown = readFileSync(skillMd, 'utf8');
      const contentSha = createHash('sha256').update(markdown, 'utf8').digest('hex');
      const changelog = (typeof params['changelog'] === 'string' && params['changelog'].trim())
        ? params['changelog'].trim()
        : packed.manifest.changelog;

      const entry: RegistrySkillEntry = {
        name: packed.manifest.name,
        version: packed.manifest.version,
        ...(packed.manifest.description ? { description: packed.manifest.description } : {}),
        ...(packed.manifest.author ? { author: packed.manifest.author } : {}),
        path: `skills/${packed.manifest.name}/SKILL.md`,
        sha256: contentSha,
        ...(changelog ? { changelog } : {}),
      };

      const indexPath = path.join(registryDir, 'index.json');
      const index = loadIndex(indexPath);
      const existing = index.skills.find((s) => s.name === entry.name);
      if (existing?.version === entry.version && existing.sha256 !== entry.sha256) {
        return {
          success: false,
          output: `Registry already has "${entry.name}"@${entry.version} with different content — bump the manifest version before publishing.`,
        };
      }

      if (dryRun) {
        return {
          success: true,
          output:
            `DRY RUN — would publish "${entry.name}" v${entry.version} to ${registryDir}:\n`
            + `- skills/${entry.name}/SKILL.md (sha256 ${contentSha.slice(0, 12)}…)\n`
            + `- packages/${path.basename(packed.tarballPath)} (sha256 ${packed.sha256.slice(0, 12)}…)\n`
            + `- index.json entry ${existing ? `updated (${existing.version} → ${entry.version})` : 'added'}\n`
            + 'Re-run with dryRun=false to write, then commit + push/PR the registry repo.',
          data: { entry, tarball: packed.tarballPath, tarballSha256: packed.sha256, dryRun: true },
        };
      }

      const destSkillDir = path.join(registryDir, 'skills', entry.name);
      const packagesDir = path.join(registryDir, 'packages');
      mkdirSync(destSkillDir, { recursive: true });
      mkdirSync(packagesDir, { recursive: true });
      writeFileSync(path.join(destSkillDir, 'SKILL.md'), markdown, 'utf8');
      copyFileSync(packed.tarballPath, path.join(packagesDir, path.basename(packed.tarballPath)));
      index.skills = [...index.skills.filter((s) => s.name !== entry.name), entry]
        .sort((a, b) => a.name.localeCompare(b.name));
      index.updated = new Date().toISOString();
      const tmp = `${indexPath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
      renameSync(tmp, indexPath);

      return {
        success: true,
        output:
          `Published "${entry.name}" v${entry.version} into ${registryDir} `
          + `(SKILL.md sha256 ${contentSha.slice(0, 12)}…, tarball ${packed.sha256.slice(0, 12)}…, index.json ${existing ? 'updated' : 'entry added'}). `
          + 'Now commit and push/PR the registry repo to make it installable.',
        data: { entry, indexPath, tarball: packed.tarballPath, tarballSha256: packed.sha256 },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `skill.publish failed: ${msg}` };
    }
  },
};
