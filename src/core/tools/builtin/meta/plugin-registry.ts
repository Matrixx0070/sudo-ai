/**
 * @file plugin-registry.ts
 * @description plugin.search / plugin.install — the Directory "Plugins" tab as
 * agent tools. A SUDO plugin is a ROLE BUNDLE (skills + connectors); installing
 * one fans out to skill.install and connector.install for its members, so a
 * single call gives the agent role-level expertise (mirrors claude.ai plugins).
 *
 * Reuses the proven install paths: skill.install (registry + Workshop gate +
 * sha256) and connector.install (mcp.connect). Kill-switch:
 * SUDO_PLUGIN_REGISTRY=0 disables both tools.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult, ToolCategory } from '../../types.js';
import {
  PluginRegistryClient,
  isPluginRegistryEnabled,
  type RegistryPluginEntry,
} from '../../../skills/plugin-registry-client.js';
import { installTool as skillInstallTool } from '../skill/tools/install.js';
import { connectorInstallTool } from './connector-registry.js';

const logger = createLogger('plugin.registry');

function summarize(p: RegistryPluginEntry): string {
  const skills = (p.skills ?? []).join(', ') || '—';
  const connectors = (p.connectors ?? []).join(', ') || '—';
  return `- ${p.name}${p.displayName ? ` (${p.displayName})` : ''} — ${p.category ?? 'other'}\n    ${p.description ?? ''}\n    skills: ${skills} | connectors: ${connectors}`;
}

export const pluginSearchTool: ToolDefinition = {
  name: 'plugin.search',
  description:
    'Browse the SUDO plugin catalog (sudoapi.shop) — role bundles that install a set of skills + '
    + 'connectors together (e.g. "engineering", "productivity"). Read-only. Optional query '
    + 'substring-matches name/description/tags; category filters by category.',
  category: 'skill' as ToolCategory,
  timeout: 15_000,
  safety: 'readonly',
  parameters: {
    query: { type: 'string', description: 'Substring matched against name, description, and tags. Omit to list all.' },
    category: { type: 'string', description: 'Exact category filter (e.g. development, productivity).' },
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    if (!isPluginRegistryEnabled()) {
      return { success: false, output: 'Plugin registry is disabled (SUDO_PLUGIN_REGISTRY=0).' };
    }
    const query = typeof params['query'] === 'string' ? params['query'].trim().toLowerCase() : '';
    const category = typeof params['category'] === 'string' ? params['category'].trim().toLowerCase() : '';
    let index;
    try {
      ({ index } = await new PluginRegistryClient().fetchIndex());
    } catch (err) {
      return { success: false, output: `plugin.search failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const matches = index.plugins.filter((p) => {
      if (category && (p.category ?? '').toLowerCase() !== category) return false;
      if (!query) return true;
      const hay = `${p.name} ${p.displayName ?? ''} ${p.description ?? ''} ${(p.tags ?? []).join(' ')}`.toLowerCase();
      return hay.includes(query);
    });
    if (matches.length === 0) return { success: true, output: 'No plugins matched.', data: { plugins: [] } };
    return { success: true, output: `${matches.length} plugin(s):\n${matches.map(summarize).join('\n')}`, data: { plugins: matches } };
  },
};

export const pluginInstallTool: ToolDefinition = {
  name: 'plugin.install',
  description:
    'Install a role bundle from the SUDO plugin catalog by name — fans out to skill.install (for '
    + 'each skill) and connector.install (for each connector) in the bundle. dryRun=true (default) '
    + 'lists what would be installed without installing; set dryRun=false to install everything. '
    + 'Installed skills take effect on the next restart; connectors connect immediately. Use '
    + 'plugin.search first to discover bundle names. Requires SUDO_PLUGIN_REGISTRY != 0 (and, to '
    + 'actually write skills, SUDO_SKILL_WORKSHOP=1).',
  category: 'skill' as ToolCategory,
  requiresConfirmation: true,
  safety: 'destructive',
  timeout: 180_000,
  parameters: {
    name: { type: 'string', required: true, description: 'Bundle name exactly as listed by plugin.search (e.g. "engineering").' },
    dryRun: { type: 'boolean', description: 'When true (default) preview only. Set false to install.', default: true },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!isPluginRegistryEnabled()) {
      return { success: false, output: 'Plugin registry is disabled (SUDO_PLUGIN_REGISTRY=0).' };
    }
    const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
    const rawDryRun = params['dryRun'];
    const dryRun = !(rawDryRun === false || rawDryRun === 'false');
    if (!name) return { success: false, output: 'name is required (see plugin.search for available plugins).' };

    let hit;
    try {
      hit = await new PluginRegistryClient().resolve(name);
    } catch (err) {
      return { success: false, output: `plugin.install failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!hit) return { success: false, output: `Plugin "${name}" not found in the catalog.` };
    const { entry, sourceUrl } = hit;
    const skills = entry.skills ?? [];
    const connectors = entry.connectors ?? [];

    logger.info({ session: ctx.sessionId, name: entry.name, skills: skills.length, connectors: connectors.length, dryRun }, 'plugin.install invoked');

    if (dryRun) {
      return {
        success: true,
        output:
          `Would install bundle "${entry.name}":\n`
          + `  skills (via skill.install): ${skills.join(', ') || '—'}\n`
          + `  connectors (via connector.install): ${connectors.join(', ') || '—'}\n`
          + 'Re-run with dryRun=false to install. Skills take effect on next restart; connectors connect immediately.',
        data: { plugin: entry, sourceUrl, dryRun: true },
      };
    }

    const results: Array<{ kind: 'skill' | 'connector'; name: string; ok: boolean; detail: string }> = [];
    for (const s of skills) {
      try {
        const r = await skillInstallTool.execute({ name: s, dryRun: false }, ctx);
        results.push({ kind: 'skill', name: s, ok: r.success, detail: r.output.split('\n')[0] ?? '' });
      } catch (err) {
        results.push({ kind: 'skill', name: s, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const c of connectors) {
      try {
        const r = await connectorInstallTool.execute({ name: c, dryRun: false }, ctx);
        results.push({ kind: 'connector', name: c, ok: r.success, detail: r.output.split('\n')[0] ?? '' });
      } catch (err) {
        results.push({ kind: 'connector', name: c, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    const lines = results.map((r) => `  ${r.ok ? '✅' : '❌'} ${r.kind} ${r.name}: ${r.detail}`);
    return {
      success: okCount > 0,
      output:
        `Installed plugin "${entry.name}" — ${okCount}/${results.length} member(s) succeeded:\n${lines.join('\n')}\n`
        + 'Newly installed skills take effect on the next restart.',
      data: { plugin: entry, sourceUrl, results, installed: okCount, total: results.length },
    };
  },
};

/** Register the plugin-registry Directory tools. */
export function registerPluginRegistryTools(registry: import('../../registry.js').ToolRegistry): void {
  registry.register(pluginSearchTool);
  registry.register(pluginInstallTool);
}
