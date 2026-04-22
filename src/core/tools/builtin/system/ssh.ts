/**
 * system.ssh — SSH key management and remote execution.
 * All commands use execFile; remote exec requires confirmation.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd, handleNotInstalled } from './exec.js';

const logger = createLogger('system.ssh');

const SSH_DIR = join(homedir(), '.ssh');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SshKey {
  name: string;
  type: string;
  fingerprint?: string;
  comment?: string;
}

type KeyType = 'ed25519' | 'rsa' | 'ecdsa';

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function listKeys(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Listing SSH keys');
  let files: string[] = [];
  try {
    files = await readdir(SSH_DIR);
  } catch {
    return { success: true, output: 'No .ssh directory found', data: { keys: [] } };
  }

  const pubKeyFiles = files.filter((f) => f.endsWith('.pub'));
  const keys: SshKey[] = await Promise.all(
    pubKeyFiles.map(async (file) => {
      const content = await readFile(join(SSH_DIR, file), 'utf8').catch(() => '');
      const parts = content.trim().split(/\s+/);
      return {
        name: file,
        type: parts[0] ?? '',
        comment: parts[2] ?? '',
      };
    }),
  );

  return { success: true, output: `${keys.length} SSH public key(s) found`, data: { keys } };
}

async function keygen(
  keyType: KeyType,
  comment: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const keyPath = join(SSH_DIR, `id_${keyType}_sudo`);
  logger.warn({ session: ctx.sessionId, keyType, keyPath }, 'Generating SSH key pair');

  await runCmd(
    'ssh-keygen',
    ['-t', keyType, '-f', keyPath, '-N', '', '-C', comment],
    { signal: ctx.signal },
  );

  const pubKey = await readFile(`${keyPath}.pub`, 'utf8').catch(() => '');
  return {
    success: true,
    output: `SSH key pair generated at ${keyPath}`,
    data: { keyPath, publicKey: pubKey.trim(), keyType },
    artifacts: [
      { path: keyPath, action: 'created' },
      { path: `${keyPath}.pub`, action: 'created' },
    ],
  };
}

async function copyKey(host: string, user: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, host, user }, 'Copying SSH public key to remote');
  const target = user ? `${user}@${host}` : host;
  const { stdout, exitCode } = await runCmd(
    'ssh-copy-id',
    ['-o', 'StrictHostKeyChecking=no', target],
    { signal: ctx.signal, allowFailure: true },
  );
  if (exitCode !== 0) {
    return { success: false, output: `ssh-copy-id failed: ${stdout}`, data: { host, user } };
  }
  return { success: true, output: `Public key copied to ${target}`, data: { host, user } };
}

async function testConnection(host: string, user: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, host, user }, 'Testing SSH connection');
  const target = user ? `${user}@${host}` : host;
  const { exitCode } = await runCmd(
    'ssh',
    [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=no',
      target,
      'echo ok',
    ],
    { signal: ctx.signal, allowFailure: true },
  );
  const ok = exitCode === 0;
  return { success: ok, output: ok ? `SSH to ${target}: OK` : `SSH to ${target}: failed`, data: { host, user, ok } };
}

async function remoteExec(
  host: string,
  user: string,
  command: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, host, user, command }, 'Executing remote SSH command');
  const target = user ? `${user}@${host}` : host;

  // NOTE: This leading-character check is a shallow heuristic only.
  // The real security gate is requiresConfirmation on the tool definition,
  // which forces explicit user approval before any SSH command executes.
  if (/^[;|&`$]/.test(command.trim())) {
    return { success: false, output: 'Command contains disallowed leading character', data: {} };
  }

  const { stdout, stderr, exitCode } = await runCmd(
    'ssh',
    [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=30',
      '-o', 'StrictHostKeyChecking=no',
      target,
      command,
    ],
    { signal: ctx.signal, allowFailure: true },
  );

  return {
    success: exitCode === 0,
    output: stdout || stderr,
    data: { host, user, command, stdout, stderr, exitCode },
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const sshTool: ToolDefinition = {
  name: 'system.ssh',
  description: 'SSH key management and remote execution: generate keys, copy to remote, execute commands, test connections.',
  category: 'system',
  requiresConfirmation: true,
  timeout: 60_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'Operation: keygen | copy-key | exec | list-keys | test-connection',
      required: true,
      enum: ['keygen', 'copy-key', 'exec', 'list-keys', 'test-connection'],
    },
    host: { type: 'string', description: 'Remote hostname or IP' },
    user: { type: 'string', description: 'Remote username', default: 'root' },
    command: { type: 'string', description: 'Command to execute on remote host' },
    keyType: {
      type: 'string',
      description: 'Key algorithm: ed25519 | rsa | ecdsa (default ed25519)',
      default: 'ed25519',
      enum: ['ed25519', 'rsa', 'ecdsa'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const op = params['operation'] as string;
    const host = params['host'] as string | undefined;
    const user = (params['user'] as string | undefined) ?? 'root';
    const command = params['command'] as string | undefined;
    const keyType = ((params['keyType'] as string | undefined) ?? 'ed25519') as KeyType;

    const requireHost = (): string => {
      if (!host || !/^[\w.@-]+$/.test(host)) throw new Error('Valid host is required');
      return host;
    };

    try {
      switch (op) {
        case 'list-keys':
          return listKeys(ctx);
        case 'keygen':
          return keygen(keyType, `sudo-ai@${new Date().toISOString().slice(0, 10)}`, ctx);
        case 'copy-key':
          return copyKey(requireHost(), user, ctx);
        case 'test-connection':
          return testConnection(requireHost(), user, ctx);
        case 'exec': {
          if (!command) return { success: false, output: 'exec requires command', data: {} };
          return remoteExec(requireHost(), user, command, ctx);
        }
        default:
          return { success: false, output: `Unknown operation: ${op}`, data: {} };
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('host')) {
        return { success: false, output: err.message, data: {} };
      }
      return handleNotInstalled(err, 'ssh') as ToolResult;
    }
  },
};
