/**
 * super.deploy — One-command deployment.
 *
 * Supports: git-push, docker build+push, pm2 restart, rsync to remote.
 * All shell commands executed via execFile (no shell interpolation).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../tools/types.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('super.deploy');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunOpts { signal?: AbortSignal; cwd?: string }

async function run(bin: string, args: string[], opts: RunOpts = {}): Promise<string> {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    signal: opts.signal,
    cwd: opts.cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}

async function deployGit(branch: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, branch }, 'Deploying via git push');
  const cwd = ctx.workingDir;
  const opts: RunOpts = { signal: ctx.signal, cwd };

  const addOut = await run('git', ['add', '-A'], opts);
  const ts = new Date().toISOString();
  const commitOut = await run('git', ['commit', '-m', `deploy: auto-commit ${ts}`, '--allow-empty'], opts);
  const pushOut = await run('git', ['push', 'origin', branch], opts);

  const output = [addOut, commitOut, pushOut].filter(Boolean).join('\n');
  logger.info({ branch }, 'git push complete');
  return { success: true, output: `Git push to "${branch}" complete.\n${output}`, data: { branch } };
}

async function deployDocker(host: string | undefined, path: string | undefined, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, host, path }, 'Deploying via Docker');
  const cwd = path ?? ctx.workingDir;
  const opts: RunOpts = { signal: ctx.signal, cwd };

  const buildOut = await run('docker', ['build', '-t', host ?? 'app:latest', '.'], opts);
  const pushOut = host ? await run('docker', ['push', host], opts) : '';

  const output = [buildOut, pushOut].filter(Boolean).join('\n');
  logger.info({ host }, 'Docker build+push complete');
  return { success: true, output: `Docker deploy complete.\n${output}`, data: { host } };
}

async function deployPm2(processName: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, processName }, 'Deploying via PM2 restart');
  const out = await run('pm2', ['restart', processName], { signal: ctx.signal });
  logger.info({ processName }, 'PM2 restart complete');
  return { success: true, output: `PM2 restarted: ${processName}\n${out}`, data: { processName } };
}

async function deployRsync(host: string, remotePath: string, localPath: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, host, remotePath }, 'Deploying via rsync');
  const src = localPath.endsWith('/') ? localPath : `${localPath}/`;
  const dest = `${host}:${remotePath}`;
  const out = await run('rsync', ['-avz', '--delete', src, dest], { signal: ctx.signal });
  logger.info({ host, remotePath }, 'rsync complete');
  return { success: true, output: `rsync to ${dest} complete.\n${out}`, data: { host, remotePath } };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const deployTool: ToolDefinition = {
  name: 'super.deploy',
  description: 'One-command deployment: git-push (add+commit+push), docker (build+push), pm2 (restart), or rsync to remote.',
  category: 'superpowers',
  requiresConfirmation: true,
  timeout: 120_000,
  parameters: {
    target: {
      type: 'string',
      description: 'Deployment method.',
      required: true,
      enum: ['git-push', 'docker', 'pm2', 'rsync'],
    },
    host: { type: 'string', description: 'Docker image tag, PM2 process name, or SSH host (user@host).' },
    path: { type: 'string', description: 'Local source path (rsync/docker) or remote destination path (rsync).' },
    branch: { type: 'string', description: 'Git branch to push to.', default: 'main' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const target = params['target'] as string;
    const host = params['host'] as string | undefined;
    const path = params['path'] as string | undefined;
    const branch = (params['branch'] as string | undefined) ?? 'main';

    logger.info({ session: ctx.sessionId, target }, 'Deploy invoked');

    try {
      switch (target) {
        case 'git-push':
          return deployGit(branch, ctx);

        case 'docker':
          return deployDocker(host, path, ctx);

        case 'pm2': {
          if (!host) return { success: false, output: 'pm2 target requires host (process name).' };
          return deployPm2(host, ctx);
        }

        case 'rsync': {
          if (!host) return { success: false, output: 'rsync requires host (user@host).' };
          if (!path) return { success: false, output: 'rsync requires path (remote destination path).' };
          const localPath = ctx.workingDir;
          return deployRsync(host, path, localPath, ctx);
        }

        default:
          return { success: false, output: `Unknown deploy target: ${target}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ target, err: msg }, 'Deploy failed');
      return { success: false, output: `Deploy failed: ${msg}`, data: { target, error: msg } };
    }
  },
};
