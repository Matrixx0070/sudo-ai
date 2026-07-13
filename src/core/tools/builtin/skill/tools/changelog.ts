/**
 * @file changelog.ts
 * @description skill.changelog — the version history of one skill, read-only:
 * current lockfile pin, registry latest (with its changelog line), CHANGELOG.md
 * when the package ships one, and the SQLite version rows recorded by
 * apply/install/update. Spec 9 UX surface.
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { PROJECT_ROOT, MIND_DB } from '../../../../shared/paths.js';
import { SkillVersioning } from '../../../../skills/versioning.js';
import { SkillRegistryClient, isSkillRegistryEnabled } from '../../../../skills/registry-client.js';
import { readLockfile } from '../../../../skills/packaging/lockfile.js';
import { packagingGate } from './packaging-gate.js';

const logger = createLogger('skill.changelog');

const MAX_CHANGELOG_MD = 8 * 1024;

export const changelogTool: ToolDefinition = {
  name: 'skill.changelog',
  description:
    'Show a skill\'s version history: the currently pinned version (skills.lock.json), the latest '
    + 'registry version and its changelog, the package\'s CHANGELOG.md if it ships one, and locally '
    + 'recorded version rows. Read-only.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 20_000,
  parameters: {
    name: {
      type: 'string',
      required: true,
      description: 'Skill name.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gate = packagingGate(ctx, { toolName: 'skill.changelog' });
    if (gate) return gate;
    const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
    if (!name || name.includes('..') || name.includes('/')) return { success: false, output: 'A valid skill name is required.' };

    logger.info({ session: ctx.sessionId, name }, 'skill.changelog invoked');
    const lines: string[] = [];
    const pinned = readLockfile().skills[name];
    lines.push(pinned
      ? `Pinned: v${pinned.version} (source: ${pinned.source}, tier: ${pinned.trustTier}, updated ${pinned.updatedAt})`
      : 'Not pinned in skills.lock.json.');

    let registryEntry;
    if (isSkillRegistryEnabled()) {
      try {
        registryEntry = (await new SkillRegistryClient().resolve(name))?.entry;
        if (registryEntry) {
          lines.push(`Registry latest: v${registryEntry.version}${registryEntry.changelog ? ` — ${registryEntry.changelog}` : ''}`);
        }
      } catch {
        lines.push('Registry unreachable — showing local history only.');
      }
    }

    const changelogMd = path.join(PROJECT_ROOT, 'skills', name, 'CHANGELOG.md');
    if (existsSync(changelogMd)) {
      lines.push('', 'CHANGELOG.md:', readFileSync(changelogMd, 'utf8').slice(0, MAX_CHANGELOG_MD).trim());
    }

    const versioning = new SkillVersioning(MIND_DB);
    let history;
    try {
      history = versioning.getVersions(name);
    } finally {
      versioning.close();
    }
    if (history.length > 0) {
      lines.push('', 'Local version history (newest first):');
      for (const v of history.slice(0, 10)) {
        lines.push(`- v${v.version}${v.active ? ' (active)' : ''} · ${v.createdAt}${v.changelog ? ` — ${v.changelog}` : ''}`);
      }
    } else if (!pinned) {
      lines.push('No local version history.');
    }

    return {
      success: true,
      output: `Changelog for "${name}":\n${lines.join('\n')}`,
      data: { name, pinned, registry: registryEntry, history: history.slice(0, 10) },
    };
  },
};
