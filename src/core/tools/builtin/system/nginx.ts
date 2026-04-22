/**
 * system.nginx — nginx site configuration management.
 * Generates server blocks, manages sites-available/sites-enabled symlinks.
 */

import { readdir, readFile, writeFile, unlink, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd, handleNotInstalled } from './exec.js';

const logger = createLogger('system.nginx');

const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------

function generateServerBlock(params: {
  domain: string;
  upstream: string;
  port: number;
  ssl: boolean;
}): string {
  const { domain, upstream, port, ssl } = params;

  const httpBlock = `server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://${upstream}:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}`;

  if (!ssl) return httpBlock;

  return `${httpBlock}

server {
    listen 443 ssl http2;
    server_name ${domain};

    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://${upstream}:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}`;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function listSites(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Listing nginx sites');
  const [available, enabled] = await Promise.all([
    readdir(SITES_AVAILABLE).catch(() => [] as string[]),
    readdir(SITES_ENABLED).catch(() => [] as string[]),
  ]);
  const sites = available.map((site) => ({
    name: site,
    enabled: enabled.includes(site),
  }));
  return { success: true, output: `${sites.length} site(s) configured`, data: { sites } };
}

async function addSite(
  params: { domain: string; upstream: string; port: number; ssl: boolean },
  ctx: ToolContext,
): Promise<ToolResult> {
  const { domain } = params;
  logger.warn({ session: ctx.sessionId, domain }, 'Adding nginx site');

  const configPath = join(SITES_AVAILABLE, domain);
  const enabledPath = join(SITES_ENABLED, domain);
  const config = generateServerBlock(params);

  await writeFile(configPath, config, 'utf8');

  // Create symlink if not already enabled.
  try {
    await access(enabledPath);
  } catch {
    await symlink(configPath, enabledPath);
  }

  // Test config before declaring success.
  const { exitCode, stderr } = await runCmd('nginx', ['-t'], { signal: ctx.signal, allowFailure: true });
  if (exitCode !== 0) {
    // Remove the broken config
    await unlink(configPath).catch(() => undefined);
    await unlink(enabledPath).catch(() => undefined);
    return { success: false, output: `nginx config test failed: ${stderr}`, data: { domain } };
  }

  return {
    success: true,
    output: `Site "${domain}" added and enabled. Run reload to apply.`,
    data: { domain, configPath, config },
    artifacts: [{ path: configPath, action: 'created' }],
  };
}

async function removeSite(domain: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, domain }, 'Removing nginx site');
  const configPath = join(SITES_AVAILABLE, domain);
  const enabledPath = join(SITES_ENABLED, domain);

  await unlink(enabledPath).catch(() => undefined);
  await unlink(configPath).catch(() => undefined);

  return {
    success: true,
    output: `Site "${domain}" removed`,
    data: { domain },
    artifacts: [{ path: configPath, action: 'deleted' }],
  };
}

async function testConfig(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Testing nginx config');
  const { stdout, stderr, exitCode } = await runCmd('nginx', ['-t'], { signal: ctx.signal, allowFailure: true });
  const ok = exitCode === 0;
  return { success: ok, output: ok ? 'nginx config OK' : stderr, data: { stdout, stderr } };
}

async function reloadNginx(ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId }, 'Reloading nginx');
  await runCmd('nginx', ['-s', 'reload'], { signal: ctx.signal });
  return { success: true, output: 'nginx reloaded', data: {} };
}

async function showConfig(domain: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, domain }, 'Reading nginx site config');
  const configPath = join(SITES_AVAILABLE, domain);
  const content = await readFile(configPath, 'utf8');
  return { success: true, output: content, data: { domain, configPath, content } };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const nginxTool: ToolDefinition = {
  name: 'system.nginx',
  description: 'Manage nginx virtual host configurations: list, add, remove sites, test config, reload nginx.',
  category: 'system',
  requiresConfirmation: true,
  timeout: 30_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'Operation: list-sites | add-site | remove-site | test | reload | show-config',
      required: true,
      enum: ['list-sites', 'add-site', 'remove-site', 'test', 'reload', 'show-config'],
    },
    domain: { type: 'string', description: 'Domain name (e.g. example.com)' },
    upstream: { type: 'string', description: 'Upstream host (e.g. localhost or 127.0.0.1)', default: '127.0.0.1' },
    port: { type: 'number', description: 'Upstream port number', default: 3000 },
    ssl: { type: 'boolean', description: 'Generate SSL server block (requires certbot certs)', default: false },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const op = params['operation'] as string;
    const domain = params['domain'] as string | undefined;
    const upstream = (params['upstream'] as string | undefined) ?? '127.0.0.1';
    const port = typeof params['port'] === 'number' ? params['port'] : 3000;
    const ssl = params['ssl'] === true;

    const requireDomain = (): string => {
      if (!domain || !/^[\w.-]+$/.test(domain)) {
        throw new Error('Valid domain is required');
      }
      return domain;
    };

    // Validate upstream to prevent nginx config injection
    if (!/^[\w.-]+$/.test(upstream)) {
      return { success: false, output: 'Invalid upstream: must be alphanumeric, dots, hyphens, or underscores only', data: {} };
    }

    // Validate port is a safe integer in the valid range
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { success: false, output: 'Invalid port: must be an integer between 1 and 65535', data: {} };
    }

    try {
      switch (op) {
        case 'list-sites':   return listSites(ctx);
        case 'add-site':     return addSite({ domain: requireDomain(), upstream, port, ssl }, ctx);
        case 'remove-site':  return removeSite(requireDomain(), ctx);
        case 'test':         return testConfig(ctx);
        case 'reload':       return reloadNginx(ctx);
        case 'show-config':  return showConfig(requireDomain(), ctx);
        default:
          return { success: false, output: `Unknown operation: ${op}`, data: {} };
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('domain')) {
        return { success: false, output: err.message, data: {} };
      }
      return handleNotInstalled(err, 'nginx') as ToolResult;
    }
  },
};
