/**
 * @file pack.ts
 * @description skill.pack — validate and pack a skill directory into a
 * versioned .tgz package (Spec 9 step 2). The scanner gate (CRITICAL blocks)
 * and manifest/size validation MUST pass before a tarball is produced; the
 * reported SHA-256 is the integrity pin for skill.install / skill.publish.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { PROJECT_ROOT } from '../../../../shared/paths.js';
import { packSkill, validateSkillPackage } from '../../../../skills/packaging/pack.js';
import { packagingGate } from './packaging-gate.js';

const logger = createLogger('skill.pack');

export const packTool: ToolDefinition = {
  name: 'skill.pack',
  description:
    'Validate a skill directory (manifest, size caps, security scanner) and pack it into a versioned '
    + '.tgz package under data/skill-packages/, reporting the tarball SHA-256 to pin in installs and '
    + 'publishes. validateOnly=true checks without producing a tarball. A scanner CRITICAL finding '
    + 'blocks packing. Owner-only.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 30_000,
  parameters: {
    name: {
      type: 'string',
      required: true,
      description: 'Skill directory name under skills/ (e.g. "eng-debug").',
    },
    validateOnly: {
      type: 'boolean',
      description: 'When true, run validation + scanner and report — no tarball is written.',
      default: false,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gate = packagingGate(ctx, { toolName: 'skill.pack', ownerOnly: true });
    if (gate) return gate;

    const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
    const validateOnly = params['validateOnly'] === true || params['validateOnly'] === 'true';
    if (!name) return { success: false, output: 'name is required.' };

    const skillDir = path.join(PROJECT_ROOT, 'skills', name);
    if (name.includes('..') || name.includes('/') || !existsSync(skillDir)) {
      return { success: false, output: `skills/${name}/ not found.` };
    }

    logger.info({ session: ctx.sessionId, name, validateOnly }, 'skill.pack invoked');
    try {
      if (validateOnly) {
        const v = validateSkillPackage(skillDir);
        const ok = v.problems.length === 0;
        return {
          success: ok,
          output: ok
            ? `Skill "${v.manifest.name}" v${v.manifest.version} is packable — ${v.files.length} file(s), `
              + `scanner ${v.scan.severity}${v.manifestSynthesized ? ' (manifest.json will be synthesized from SKILL.md)' : ''}.`
            : `Skill "${name}" is NOT packable:\n- ${v.problems.join('\n- ')}`,
          data: { manifest: v.manifest, files: v.files, scan: v.scan, problems: v.problems },
        };
      }
      const r = await packSkill(skillDir);
      return {
        success: true,
        output:
          `Packed "${r.manifest.name}" v${r.manifest.version} → ${r.tarballPath}\n`
          + `sha256: ${r.sha256}\n`
          + `${r.files.length} file(s); scanner ${r.scan.severity}. `
          + 'Install elsewhere with skill.install {path, sha256}, or share via skill.publish.',
        data: { tarballPath: r.tarballPath, sha256: r.sha256, manifest: r.manifest, files: r.files, scan: r.scan },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `skill.pack failed: ${msg}` };
    }
  },
};
