/**
 * @file tool-install.ts
 * @description tool.install-mcp — Install an MCP server package via npm and
 * register it as a live tool source.
 *
 * Safety: requiresConfirmation=true, safety='destructive'.
 * Security: packageName must match safe npm name pattern to prevent shell injection.
 *
 * Pipeline:
 *   1. Validate packageName against safe-npm regex
 *   2. execFile('npm', ['install', '-g', packageName]) — 120 s timeout
 *   3. Spawn MCPAdapter { id: serverId, transport:'stdio', command:'npx', args:[packageName] }
 *   4. adapter.connect() + adapter.listTools()
 *   5. ToolRegistry.getGlobal()?.registerMCPSource(adapter, serverId)
 *   6. Return registered tool names
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { ToolRegistry } from '../../registry.js';
import { MCPAdapter } from '../../mcp-adapter.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta:tool-install');
const execFileAsync = promisify(execFile);

/** 120-second npm install timeout */
const NPM_TIMEOUT_MS = 120_000;

/**
 * Allowed package name pattern: npm-safe characters only.
 * Prevents shell injection even though execFile is used (belt-and-suspenders).
 * Matches: @scope/package, package-name, package.name, etc.
 */
const SAFE_PKG_RE = /^@?[a-z0-9][a-z0-9._/-]*$/;

/** Reject obviously dangerous package names that might trick execFile. */
const DANGEROUS_PKG_RE = /\.\.|\/\/|\\|`|\$|\(|\)|;|&&|\|\||>|</;

export const installMcpTool: ToolDefinition = {
  name: 'tool.install-mcp',
  category: 'meta',
  description:
    'Install an MCP server package via npm and register it as a live tool source. Requires confirmation. Package must be a valid npm package name.',
  timeout: 130_000,
  requiresConfirmation: true,
  safety: 'destructive',
  parameters: {
    packageName: {
      type: 'string',
      required: true,
      description: 'npm package name to install globally (e.g. "@modelcontextprotocol/server-filesystem").',
    },
    serverId: {
      type: 'string',
      required: true,
      description: 'Unique ID for this MCP server in the registry (e.g. "filesystem-mcp").',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const packageName = params['packageName'] as string | undefined;
    const serverId = params['serverId'] as string | undefined;

    logger.info({ session: ctx.sessionId, packageName, serverId }, 'tool.install-mcp invoked');

    // --- Input validation ---
    if (!packageName?.trim()) {
      return { success: false, output: 'packageName is required.' };
    }
    if (!serverId?.trim()) {
      return { success: false, output: 'serverId is required.' };
    }

    const cleanPkg = packageName.trim().slice(0, 214); // npm max length
    if (!SAFE_PKG_RE.test(cleanPkg)) {
      logger.warn({ packageName: cleanPkg }, 'tool.install-mcp: unsafe package name rejected');
      return {
        success: false,
        output: `Package name "${cleanPkg}" contains unsafe characters. Only lowercase letters, numbers, hyphens, dots, underscores, and @scope/ prefixes are allowed.`,
      };
    }
    if (DANGEROUS_PKG_RE.test(cleanPkg)) {
      logger.warn({ packageName: cleanPkg }, 'tool.install-mcp: dangerous package name pattern rejected');
      return {
        success: false,
        output: `Package name "${cleanPkg}" contains dangerous characters that could indicate shell injection.`,
      };
    }

    const cleanServerId = serverId.trim().slice(0, 128);

    // --- Step 1: npm install -g <packageName> ---
    logger.info({ packageName: cleanPkg }, 'Running npm install -g');
    try {
      const { stdout, stderr } = await execFileAsync(
        'npm',
        ['install', '-g', cleanPkg],
        { timeout: NPM_TIMEOUT_MS },
      );
      logger.info({ packageName: cleanPkg, stdout: stdout.slice(0, 500) }, 'npm install succeeded');
      if (stderr) logger.warn({ packageName: cleanPkg, stderr: stderr.slice(0, 500) }, 'npm install stderr');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ packageName: cleanPkg, err: msg }, 'npm install failed');
      return { success: false, output: `npm install failed for "${cleanPkg}": ${msg}` };
    }

    // --- Step 2: Spawn MCPAdapter ---
    const adapter = new MCPAdapter({
      id: cleanServerId,
      transport: 'stdio',
      command: 'npx',
      args: [cleanPkg],
    });

    // --- Step 3: connect + listTools ---
    let toolDefs: import('../../mcp-adapter.js').MCPToolDef[];
    try {
      await adapter.connect();
      toolDefs = await adapter.listTools();
      logger.info({ serverId: cleanServerId, toolCount: toolDefs.length }, 'MCP adapter connected');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ serverId: cleanServerId, err: msg }, 'MCP adapter connect/listTools failed');
      return { success: false, output: `MCP adapter failed to connect for "${cleanServerId}": ${msg}` };
    }

    // --- Step 4: Register in global registry ---
    const registry = ToolRegistry.getGlobal();
    if (!registry) {
      logger.error({}, 'tool.install-mcp: ToolRegistry.getGlobal() is null');
      return { success: false, output: 'ToolRegistry not available — cannot register MCP source.' };
    }

    try {
      registry.registerMCPSource(adapter, cleanServerId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ serverId: cleanServerId, err: msg }, 'registerMCPSource failed');
      return { success: false, output: `Failed to register MCP source "${cleanServerId}": ${msg}` };
    }

    const toolNames = toolDefs.map((t) => t.name);
    const output = toolNames.length > 0
      ? `MCP server "${cleanServerId}" registered with ${toolNames.length} tool(s):\n${toolNames.join('\n')}`
      : `MCP server "${cleanServerId}" registered but returned 0 tools.`;

    logger.info({ serverId: cleanServerId, toolNames }, 'tool.install-mcp complete');
    return { success: true, output, data: { serverId: cleanServerId, toolNames } };
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerInstallTools(registry: ToolRegistry): void {
  registry.register(installMcpTool);
}
