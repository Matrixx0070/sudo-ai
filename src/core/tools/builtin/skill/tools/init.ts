/**
 * @file init.ts
 * @description skill.init — scaffold a new versioned skill package:
 * skills/<name>/SKILL.md + manifest.json (0.1.0). Spec 9 step 2. Owner-only,
 * gated by SUDO_SKILL_WORKSHOP=1 (the skills/ write gate) and the packaging
 * kill-switch SUDO_SKILL_PACKAGING (default on, =0 disables).
 */

import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { PROJECT_ROOT } from '../../../../shared/paths.js';
import { SkillWorkshop } from '../../../../skills/workshop.js';
import { MANIFEST_FILENAME, type SkillManifest } from '../../../../skills/packaging/manifest.js';
import { updateLockEntry } from '../../../../skills/packaging/lockfile.js';
import { packagingGate } from './packaging-gate.js';

const logger = createLogger('skill.init');

const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

function skillMdTemplate(name: string, description: string): string {
  return `---
name: ${name}
version: 0.1.0
description: ${description}
triggers: []
caps: []
---

# ${name}

Describe when this skill applies and the steps to follow.
`;
}

export const initTool: ToolDefinition = {
  name: 'skill.init',
  description:
    'Scaffold a new versioned skill package: creates skills/<name>/ with a SKILL.md template and a '
    + 'manifest.json at version 0.1.0, and pins it in skills.lock.json. Follow with skill.apply to '
    + 'write real content, skill.pack to build a distributable tarball, and skill.publish to share it. '
    + 'Owner-only; requires SUDO_SKILL_WORKSHOP=1.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 10_000,
  parameters: {
    name: {
      type: 'string',
      required: true,
      description: 'New skill name (lowercase letters, digits, dots, dashes; e.g. "eng-debug").',
    },
    description: {
      type: 'string',
      description: 'One-line description placed in the SKILL.md frontmatter and manifest.',
    },
    author: {
      type: 'string',
      description: 'Author recorded in the manifest.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gate = packagingGate(ctx, { requireWorkshop: true, ownerOnly: true, toolName: 'skill.init' });
    if (gate) return gate;

    const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
    const description = typeof params['description'] === 'string' && params['description'].trim()
      ? params['description'].trim()
      : 'TODO: describe this skill';
    const author = typeof params['author'] === 'string' && params['author'].trim() ? params['author'].trim() : undefined;

    if (!NAME_RE.test(name) || name.includes('..')) {
      return { success: false, output: `Invalid skill name "${name}" — use lowercase letters, digits, dots, dashes (max 64 chars).` };
    }
    const skillsRoot = path.join(PROJECT_ROOT, 'skills');
    const skillDir = path.join(skillsRoot, name);
    if (!skillDir.startsWith(skillsRoot + path.sep)) {
      return { success: false, output: `Unsafe skill name "${name}".` };
    }
    if (existsSync(skillDir)) {
      return { success: false, output: `skills/${name}/ already exists — use skill.apply to edit it or pick another name.` };
    }

    const manifest: SkillManifest = { name, version: '0.1.0', description, ...(author ? { author } : {}) };
    const markdown = skillMdTemplate(name, description);

    // Same fail-closed gate as skill.apply — a template passes, but keep the invariant.
    const workshop = new SkillWorkshop();
    const g = workshop.gate({ skillName: name, version: '0.1.0', markdown });
    if (!g.ok) {
      return { success: false, output: `skill.init blocked by gate:\n- ${g.reasons.join('\n- ')}` };
    }

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), markdown, 'utf8');
    writeFileSync(path.join(skillDir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    updateLockEntry(name, {
      version: '0.1.0',
      sha256: '',
      source: 'local',
      trustTier: 'workspace',
      updatedAt: new Date().toISOString(),
    }, skillsRoot);

    logger.info({ session: ctx.sessionId, name }, 'skill.init scaffolded');
    return {
      success: true,
      output:
        `Scaffolded skill package "${name}" v0.1.0 at skills/${name}/ (SKILL.md + ${MANIFEST_FILENAME}, pinned in skills.lock.json). `
        + 'Next: skill.apply to write the real content, then skill.pack to build a tarball.',
      data: { name, skillDir, manifest },
    };
  },
};
