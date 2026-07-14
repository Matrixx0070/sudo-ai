/**
 * textproc.capabilities — report which text-processing tools are available
 * on this backend and which provider serves each abstract role (Spec 10).
 *
 * This is the "intelligent tool selection" primitive: the agent calls it
 * (or reads the router's summary line) before composing pipelines, instead
 * of guessing which binaries exist.
 */

import type { ToolDefinition, ToolResult } from '../../types.js';
import {
  fullCatalog,
  getManifest,
  resolveAllRoles,
  resolveRole,
  summaryLine,
} from './capabilities.js';

export const capabilitiesTool: ToolDefinition = {
  name: 'textproc.capabilities',
  description:
    'List available text-processing tools (rg/jq/mlr/sd/yq/…) grouped by role, with the best ' +
    'provider per role (native binary, alias, or python fallback) and usage hints. Call this ' +
    'before composing shell pipelines over logs, CSV, JSON, YAML, XML, or HTML so you use tools ' +
    'that actually exist. role: narrow to one role (e.g. "csv-stats", "yaml", "find-replace"). ' +
    'refresh: re-probe the PATH (after installing something).',
  category: 'textproc',
  parameters: {
    role: {
      type: 'string',
      description: 'Optional single role to resolve (e.g. "csv", "yaml", "find-replace", "search").',
    },
    refresh: {
      type: 'boolean',
      description: 'Re-probe the PATH instead of using the cached manifest.',
      default: false,
    },
  },
  safety: 'readonly',
  timeout: 20_000,
  async execute(params): Promise<ToolResult> {
    const manifest = await getManifest({ refresh: params['refresh'] === true });
    const role = typeof params['role'] === 'string' && params['role'].length > 0
      ? params['role']
      : undefined;

    if (role) {
      const r = resolveRole(role, manifest);
      const line = r.via === 'none'
        ? `${role}: UNAVAILABLE (no binary and no python fallback on backend '${manifest.backend}')`
        : `${role}: ${r.provider} (${r.via})${r.binary ? ` at ${r.binary}` : ''}${r.hint ? ` — ${r.hint}` : ''}`;
      return { success: true, output: line, data: { resolution: r, backend: manifest.backend } };
    }

    const resolutions = resolveAllRoles(manifest);
    const catalog = fullCatalog();
    const present = catalog.filter((c) => manifest.tools[c.name]?.path);
    const missing = catalog.filter((c) => !manifest.tools[c.name]?.path && !c.safety?.banned);

    const lines: string[] = [
      `Text-processing capabilities (backend: ${manifest.backend}, probed ${manifest.createdAt})`,
      `Summary: ${summaryLine(manifest)}`,
      '',
      'Roles:',
      ...resolutions.map((r) => {
        if (r.via === 'none') return `  ${r.role}: UNAVAILABLE`;
        const hint = r.hint ? ` — ${r.hint}` : '';
        return `  ${r.role}: ${r.provider} (${r.via})${hint}`;
      }),
      '',
      `Present binaries (${present.length}): ${present.map((c) => c.name).join(', ')}`,
    ];
    if (missing.length > 0) {
      lines.push(`Missing (${missing.length}): ${missing.map((c) => c.name).join(', ')} — operator can run scripts/provision-textproc.sh`);
    }
    return {
      success: true,
      output: lines.join('\n'),
      data: {
        backend: manifest.backend,
        summary: summaryLine(manifest),
        roles: resolutions,
        present: present.map((c) => c.name),
        missing: missing.map((c) => c.name),
      },
    };
  },
};
