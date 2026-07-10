/**
 * @file mcp-connector.ts
 * @description mcp.connect / mcp.list / mcp.disconnect — agent-facing MCP
 * connector management, so the agent can attach remote (Streamable HTTP) or
 * local (stdio) MCP servers at runtime — e.g. GitHub's MCP at
 * https://api.githubcopilot.com/mcp/ — and keep them across restarts.
 *
 * Secrets: auth is referenced by ENV-VAR NAME (`authEnvKey`), resolved from
 * the process environment at connect time. Token values never appear in tool
 * params, tool output, or the persistence file.
 *
 * Persistence: connector configs (WITHOUT secrets — env-key names only) are
 * saved to `data/mcp-connectors.json` and replayed at boot by
 * `replayPersistedConnectors()` (wired in cli.ts, best-effort, never blocks
 * boot). Kill-switch: SUDO_MCP_CONNECTORS=0 disables replay.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { ToolRegistry } from '../../registry.js';
import {
  MCPAdapter,
  StreamableHTTPMCPAdapter,
  type MCPAdapterLike,
} from '../../mcp-adapter.js';
import { DATA_DIR } from '../../../shared/paths.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta:mcp-connector');

/** Persisted connector shape — never contains secret VALUES. */
export interface PersistedConnector {
  serverId: string;
  transport: 'http' | 'stdio';
  /** http: full MCP endpoint URL. */
  url?: string;
  /** stdio: executable + args. */
  command?: string;
  args?: string[];
  /** NAME of the env var holding the bearer token (http) — value resolved at connect time. */
  authEnvKey?: string;
}

function connectorsFile(): string {
  return path.join(DATA_DIR, 'mcp-connectors.json');
}

export function loadPersistedConnectors(): PersistedConnector[] {
  const file = connectorsFile();
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter((c): c is PersistedConnector =>
          !!c && typeof c === 'object'
          && typeof (c as PersistedConnector).serverId === 'string'
          && ((c as PersistedConnector).transport === 'http' || (c as PersistedConnector).transport === 'stdio'))
      : [];
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'mcp-connectors.json unreadable — ignoring');
    return [];
  }
}

function savePersistedConnectors(connectors: PersistedConnector[]): void {
  const file = connectorsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write can't truncate the file.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(connectors, null, 2), 'utf8');
  renameSync(tmp, file);
}

/**
 * serverId charset guard — becomes part of tool names and file content.
 * Consecutive underscores are rejected: "a__b" would make the flat
 * mcp__<serverId>__<tool> namespace ambiguous.
 */
const SERVER_ID_RE = /^(?!.*__)[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Build the adapter for a connector config; resolves auth from env. */
function buildAdapter(c: PersistedConnector): MCPAdapterLike {
  if (c.transport === 'http') {
    const accessToken = c.authEnvKey ? process.env[c.authEnvKey] : undefined;
    if (c.authEnvKey && !accessToken) {
      throw new Error(
        `env var "${c.authEnvKey}" is not set — add it to config/.env (values are read at connect time, never stored)`,
      );
    }
    return new StreamableHTTPMCPAdapter({
      id: c.serverId,
      url: c.url ?? '',
      ...(accessToken ? { accessToken } : {}),
    });
  }
  return new MCPAdapter({
    id: c.serverId,
    transport: 'stdio',
    command: c.command ?? '',
    args: c.args ?? [],
  });
}

/** Connect + discover + register one connector into the live ToolRegistry. */
async function connectAndRegister(
  registry: ToolRegistry,
  c: PersistedConnector,
): Promise<{ toolNames: string[] }> {
  const adapter = buildAdapter(c);
  await adapter.connect();
  const toolDefs = await adapter.listTools();
  registry.registerMCPSource(adapter, c.serverId);
  return { toolNames: toolDefs.map((t) => t.name) };
}

/**
 * Boot replay: reconnect every persisted connector, best-effort. A dead
 * server logs and is skipped — boot never blocks on a remote endpoint.
 * Returns per-connector outcomes for the boot log.
 */
export async function replayPersistedConnectors(
  registry: ToolRegistry,
): Promise<Array<{ serverId: string; ok: boolean; toolCount: number; error?: string }>> {
  if (process.env['SUDO_MCP_CONNECTORS'] === '0') return [];
  const outcomes: Array<{ serverId: string; ok: boolean; toolCount: number; error?: string }> = [];
  const liveIds = new Set(registry.listMCPSources().map((src) => src.serverId));
  for (const c of loadPersistedConnectors()) {
    if (liveIds.has(c.serverId)) {
      // Another path (tool.install-mcp, .mcp.json boot ingest into this
      // registry, an earlier replay) already owns this id — overwriting would
      // hijack its mcp__<id>__* names and orphan its adapter.
      outcomes.push({ serverId: c.serverId, ok: false, toolCount: 0, error: 'serverId already registered — skipped' });
      logger.warn({ serverId: c.serverId }, 'persisted MCP connector skipped — serverId already registered');
      continue;
    }
    try {
      const { toolNames } = await connectAndRegister(registry, c);
      liveIds.add(c.serverId);
      outcomes.push({ serverId: c.serverId, ok: true, toolCount: toolNames.length });
      logger.info({ serverId: c.serverId, toolCount: toolNames.length }, 'persisted MCP connector replayed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcomes.push({ serverId: c.serverId, ok: false, toolCount: 0, error: msg });
      logger.warn({ serverId: c.serverId, err: msg }, 'persisted MCP connector failed to reconnect — skipped');
    }
  }
  return outcomes;
}

export const mcpConnectTool: ToolDefinition = {
  name: 'mcp.connect',
  category: 'meta',
  requiresConfirmation: true,
  safety: 'destructive',
  description:
    'Connect an MCP server and register its tools live. Remote (Streamable HTTP) servers: pass url (e.g. https://api.githubcopilot.com/mcp/ for GitHub) and, if auth is needed, authEnvKey — the NAME of an env var in config/.env holding the bearer token. Local servers: pass command (+ args). Persisted across restarts unless persist=false.',
  timeout: 60_000,
  parameters: {
    serverId: {
      type: 'string',
      required: true,
      description: 'Unique id for this server; tools register as mcp__<serverId>__<tool>. Letters/digits/_/-, max 64.',
    },
    url: {
      type: 'string',
      description: 'Streamable HTTP MCP endpoint URL (mutually exclusive with command).',
    },
    authEnvKey: {
      type: 'string',
      description: 'NAME of the env var holding the bearer token for this server (e.g. GITHUB_MCP_PAT). Never pass the token itself.',
    },
    command: {
      type: 'string',
      description: 'stdio transport: executable to spawn (mutually exclusive with url).',
    },
    args: {
      type: 'array',
      description: 'stdio transport: arguments for command.',
      items: { type: 'string', description: 'argument' },
    },
    persist: {
      type: 'boolean',
      description: 'Save this connector (without secrets) for automatic reconnect at boot. Default true.',
      default: true,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const serverId = typeof params['serverId'] === 'string' ? params['serverId'].trim() : '';
    const url = typeof params['url'] === 'string' ? params['url'].trim() : '';
    const command = typeof params['command'] === 'string' ? params['command'].trim() : '';
    const authEnvKey = typeof params['authEnvKey'] === 'string' ? params['authEnvKey'].trim() : '';
    const args = Array.isArray(params['args']) ? params['args'].filter((a): a is string => typeof a === 'string') : [];
    const persist = params['persist'] !== false;

    logger.info({ session: ctx.sessionId, serverId, transport: url ? 'http' : 'stdio' }, 'mcp.connect invoked');

    if (!SERVER_ID_RE.test(serverId)) {
      return { success: false, output: 'serverId must be 1-64 chars: letters, digits, "_", "-" (start alphanumeric, no consecutive underscores).' };
    }
    if ((url && command) || (!url && !command)) {
      return { success: false, output: 'Pass exactly one of url (Streamable HTTP) or command (stdio).' };
    }
    if (authEnvKey && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(authEnvKey)) {
      return { success: false, output: 'authEnvKey must be a valid env var NAME (the token value itself must never be passed).' };
    }

    const registry = ToolRegistry.getGlobal();
    if (!registry) {
      return { success: false, output: 'ToolRegistry not available — cannot register MCP source.' };
    }
    if (registry.listMCPSources().some((s) => s.serverId === serverId)) {
      return { success: false, output: `MCP server "${serverId}" is already connected. Use mcp.disconnect first to replace it.` };
    }

    const connector: PersistedConnector = url
      ? { serverId, transport: 'http', url, ...(authEnvKey ? { authEnvKey } : {}) }
      : { serverId, transport: 'stdio', command, ...(args.length ? { args } : {}) };

    let toolNames: string[];
    try {
      ({ toolNames } = await connectAndRegister(registry, connector));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ serverId, err: msg }, 'mcp.connect failed');
      return { success: false, output: `Failed to connect MCP server "${serverId}": ${msg}` };
    }

    if (persist) {
      try {
        const others = loadPersistedConnectors().filter((c) => c.serverId !== serverId);
        savePersistedConnectors([...others, connector]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ serverId, err: msg }, 'connector connected but persistence failed');
        return {
          success: true,
          output: `MCP server "${serverId}" connected with ${toolNames.length} tool(s), but persisting for boot replay FAILED (${msg}). It will not survive a restart.`,
          data: { serverId, toolNames, persisted: false },
        };
      }
    }

    const head = toolNames.slice(0, 25);
    return {
      success: true,
      output: `MCP server "${serverId}" connected — ${toolNames.length} tool(s) registered${persist ? ', persisted for boot replay' : ''}:\n${head.join('\n')}${toolNames.length > head.length ? `\n… and ${toolNames.length - head.length} more` : ''}`,
      data: { serverId, toolNames, persisted: persist },
    };
  },
};

export const mcpListTool: ToolDefinition = {
  name: 'mcp.list',
  category: 'meta',
  description: 'List connector-managed MCP servers (mcp.connect / tool.install-mcp) with their tool counts, plus persisted connectors configured to reconnect at boot. Servers ingested from .mcp.json at boot are managed separately and not shown here.',
  timeout: 10_000,
  safety: 'readonly',
  parameters: {},

  async execute(): Promise<ToolResult> {
    const registry = ToolRegistry.getGlobal();
    if (!registry) return { success: false, output: 'ToolRegistry not available.' };
    const live = registry.listMCPSources();
    const persisted = loadPersistedConnectors();
    const liveIds = new Set(live.map((s) => s.serverId));
    const lines = live.map((s) => {
      const p = persisted.find((c) => c.serverId === s.serverId);
      const origin = p ? (p.transport === 'http' ? p.url : `${p.command} ${(p.args ?? []).join(' ')}`.trim()) : 'session-only';
      return `- ${s.serverId}: ${s.toolCount} tool(s) [${origin}]`;
    });
    const dormant = persisted.filter((c) => !liveIds.has(c.serverId));
    for (const c of dormant) {
      lines.push(`- ${c.serverId}: NOT CONNECTED (persisted ${c.transport}; will retry at next boot)`);
    }
    return {
      success: true,
      output: lines.length ? `MCP servers:\n${lines.join('\n')}` : 'No MCP servers connected or persisted.',
      data: { live, persisted },
    };
  },
};

export const mcpDisconnectTool: ToolDefinition = {
  name: 'mcp.disconnect',
  category: 'meta',
  description: 'Disconnect an MCP server, remove its tools, and (by default) forget its persisted connector so it stays gone after restart.',
  timeout: 15_000,
  parameters: {
    serverId: { type: 'string', required: true, description: 'Server id as shown by mcp.list.' },
    forget: {
      type: 'boolean',
      description: 'Also remove the persisted connector (default true). Pass false to disconnect for this session only.',
      default: true,
    },
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const serverId = typeof params['serverId'] === 'string' ? params['serverId'].trim() : '';
    const forget = params['forget'] !== false;
    if (!serverId) return { success: false, output: 'serverId is required.' };

    const registry = ToolRegistry.getGlobal();
    if (!registry) return { success: false, output: 'ToolRegistry not available.' };

    const removed = registry.removeMCPSource(serverId);
    let forgot = false;
    if (forget) {
      const persisted = loadPersistedConnectors();
      const remaining = persisted.filter((c) => c.serverId !== serverId);
      if (remaining.length !== persisted.length) {
        savePersistedConnectors(remaining);
        forgot = true;
      }
    }
    if (removed === 0 && !forgot) {
      return { success: false, output: `No connected or persisted MCP server named "${serverId}".` };
    }
    return {
      success: true,
      output: `MCP server "${serverId}": ${removed} tool(s) removed${forgot ? ', persisted connector forgotten' : forget ? '' : ' (persisted connector kept — will reconnect at boot)'}.`,
      data: { serverId, toolsRemoved: removed, forgot },
    };
  },
};

export function registerMcpConnectorTools(registry: ToolRegistry): void {
  registry.register(mcpConnectTool);
  registry.register(mcpListTool);
  registry.register(mcpDisconnectTool);
}
