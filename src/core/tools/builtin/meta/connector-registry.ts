/**
 * @file connector-registry.ts
 * @description connector.search / connector.install — the Directory
 * "Connectors" tab as agent tools. Browse the remote connector catalog
 * (connectors.json on sudoapi.shop) and install a LIVE connector by name,
 * which wires it up through the SAME proven mcp.connect path (adapter connect
 * + discover + register + persist for boot replay).
 *
 * No secrets in the catalog: an http connector references its bearer token by
 * env-var NAME (authEnvKey), resolved from config/.env at connect time. Catalog
 * entries flagged requiresOAuth are browsable but not auto-installable here.
 *
 * Kill-switch: SUDO_CONNECTOR_REGISTRY=0 disables both tools.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult, ToolCategory } from '../../types.js';
import { ToolRegistry } from '../../registry.js';
import {
  ConnectorRegistryClient,
  isConnectorRegistryEnabled,
  type RegistryConnectorEntry,
} from '../../../skills/connector-registry-client.js';
import { mcpConnectTool } from './mcp-connector.js';

const logger = createLogger('connector.registry');

/** serverId charset the mcp.connect tool accepts (no dots, no consecutive "_"). */
const SERVER_ID_RE = /^(?!.*__)[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function summarize(c: RegistryConnectorEntry): string {
  const tag = c.live ? 'LIVE' : c.requiresOAuth ? 'OAuth' : 'catalog';
  const auth = c.authEnvKey ? ` [auth env: ${c.authEnvKey}]` : '';
  return `- ${c.name}${c.displayName ? ` (${c.displayName})` : ''} — ${c.category ?? 'other'} — ${tag}${auth}\n    ${c.description ?? ''}`;
}

export const connectorSearchTool: ToolDefinition = {
  name: 'connector.search',
  description:
    'Browse the SUDO connector catalog (sudoapi.shop) — MCP servers you can add. Read-only. '
    + 'Returns name, category, description, whether it is LIVE (auto-installable via connector.install) '
    + 'or requires OAuth (connect out-of-band), and the auth env-var name if any. '
    + 'Optional query substring-matches name/description/tags; category filters by category.',
  category: 'mcp' as ToolCategory,
  timeout: 15_000,
  safety: 'readonly',
  parameters: {
    query: {
      type: 'string',
      description: 'Substring matched against name, description, and tags. Omit to list everything.',
    },
    category: {
      type: 'string',
      description: 'Exact category filter (e.g. development, productivity, communication).',
    },
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    if (!isConnectorRegistryEnabled()) {
      return { success: false, output: 'Connector registry is disabled (SUDO_CONNECTOR_REGISTRY=0).' };
    }
    const query = typeof params['query'] === 'string' ? params['query'].trim().toLowerCase() : '';
    const category = typeof params['category'] === 'string' ? params['category'].trim().toLowerCase() : '';

    let index;
    try {
      ({ index } = await new ConnectorRegistryClient().fetchIndex());
    } catch (err) {
      return { success: false, output: `connector.search failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    const matches = index.connectors.filter((c) => {
      if (category && (c.category ?? '').toLowerCase() !== category) return false;
      if (!query) return true;
      const hay = `${c.name} ${c.displayName ?? ''} ${c.description ?? ''} ${(c.tags ?? []).join(' ')}`.toLowerCase();
      return hay.includes(query);
    });

    if (matches.length === 0) {
      return { success: true, output: 'No connectors matched.', data: { connectors: [] } };
    }
    return {
      success: true,
      output: `${matches.length} connector(s):\n${matches.map(summarize).join('\n')}`,
      data: { connectors: matches },
    };
  },
};

export const connectorInstallTool: ToolDefinition = {
  name: 'connector.install',
  description:
    'Install a LIVE connector from the SUDO catalog by name — wires up its MCP server via the '
    + 'proven mcp.connect path (connect + discover tools + register + persist for boot replay). '
    + 'dryRun=true (default) previews what would be connected without connecting; set dryRun=false '
    + 'to actually connect. http connectors resolve their bearer token from config/.env by the '
    + "catalog's authEnvKey (never a token value). Catalog entries needing OAuth cannot be installed "
    + 'here — use connector.search to discover names. Requires SUDO_CONNECTOR_REGISTRY != 0.',
  category: 'mcp' as ToolCategory,
  requiresConfirmation: true,
  safety: 'destructive',
  timeout: 60_000,
  parameters: {
    name: {
      type: 'string',
      required: true,
      description: 'Catalog connector name exactly as listed by connector.search (e.g. "github").',
    },
    serverId: {
      type: 'string',
      description: 'Override the registered serverId (defaults to the connector name). Letters/digits/_/-, max 64.',
    },
    dryRun: {
      type: 'boolean',
      description: 'When true (default) preview only. Set false to actually connect.',
      default: true,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!isConnectorRegistryEnabled()) {
      return { success: false, output: 'Connector registry is disabled (SUDO_CONNECTOR_REGISTRY=0).' };
    }
    const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
    const overrideId = typeof params['serverId'] === 'string' ? params['serverId'].trim() : '';
    const rawDryRun = params['dryRun'];
    const dryRun = !(rawDryRun === false || rawDryRun === 'false');
    if (!name) return { success: false, output: 'name is required (see connector.search for available connectors).' };

    let hit;
    try {
      hit = await new ConnectorRegistryClient().resolve(name);
    } catch (err) {
      return { success: false, output: `connector.install failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!hit) return { success: false, output: `Connector "${name}" not found in the catalog.` };
    const { entry, sourceUrl } = hit;

    if (!entry.live) {
      return {
        success: false,
        output:
          `"${entry.name}" is a catalog-only connector${entry.requiresOAuth ? ' that requires OAuth' : ''} — `
          + 'it cannot be auto-installed here. Connect it out-of-band (interactive OAuth / a hosted connector).',
        data: { connector: entry, sourceUrl },
      };
    }

    const serverId = overrideId || entry.name;
    if (!SERVER_ID_RE.test(serverId)) {
      return { success: false, output: `serverId "${serverId}" is invalid (letters/digits/_/-, no consecutive "_", max 64). Pass serverId to override.` };
    }

    logger.info({ session: ctx.sessionId, name: entry.name, serverId, transport: entry.transport, dryRun }, 'connector.install invoked');

    if (dryRun) {
      const how = entry.transport === 'http'
        ? `Streamable HTTP → ${entry.url}${entry.authEnvKey ? ` (auth env: ${entry.authEnvKey})` : ''}`
        : `stdio → ${entry.command} ${(entry.args ?? []).join(' ')}`;
      const authNote = entry.transport === 'http' && entry.authEnvKey && !process.env[entry.authEnvKey]
        ? `\n⚠️ env var ${entry.authEnvKey} is NOT set — add it to config/.env before installing.`
        : '';
      return {
        success: true,
        output: `Would connect "${entry.name}" as serverId "${serverId}" via ${how}.${authNote}\nRe-run with dryRun=false to connect.`,
        data: { connector: entry, serverId, sourceUrl, dryRun: true },
      };
    }

    // Delegate to the proven mcp.connect path (validation, connect, persist, dedup).
    const connectParams: Record<string, unknown> = { serverId, persist: true };
    if (entry.transport === 'http') {
      connectParams['url'] = entry.url;
      if (entry.authEnvKey) connectParams['authEnvKey'] = entry.authEnvKey;
    } else {
      connectParams['command'] = entry.command;
      if (entry.args?.length) connectParams['args'] = entry.args;
    }
    const result = await mcpConnectTool.execute(connectParams, ctx);
    return {
      ...result,
      data: {
        ...(typeof result.data === 'object' && result.data ? result.data : {}),
        connector: entry,
        sourceUrl,
        installedFromCatalog: true,
      },
    };
  },
};

/** Register the connector-registry Directory tools. */
export function registerConnectorRegistryTools(registry: ToolRegistry): void {
  registry.register(connectorSearchTool);
  registry.register(connectorInstallTool);
}
