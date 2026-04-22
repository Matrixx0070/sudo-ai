/**
 * coder.git — Full git operations via execFile (no shell interpolation).
 * Supports: init, clone, add, commit, push, pull, branch, checkout,
 *           merge, diff, log, status, stash, remote, reset, tag.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const execFile = promisify(execFileCb);

type GitOperation =
  | 'init' | 'clone' | 'add' | 'commit' | 'push' | 'pull'
  | 'branch' | 'checkout' | 'merge' | 'diff' | 'log'
  | 'status' | 'stash' | 'remote' | 'reset' | 'tag';

interface GitParams {
  operation: GitOperation;
  cwd?: string;
  // clone
  url?: string;
  destination?: string;
  // add
  files?: string[];
  // commit
  message?: string;
  amend?: boolean;
  // push / pull
  remote?: string;
  branch?: string;
  force?: boolean;
  // checkout
  createBranch?: boolean;
  ref?: string;
  // merge
  // (uses branch)
  // diff
  fromRef?: string;
  toRef?: string;
  // log
  count?: number;
  oneline?: boolean;
  // stash
  stashAction?: 'push' | 'pop' | 'list' | 'drop';
  stashMessage?: string;
  // remote
  remoteAction?: 'add' | 'remove' | 'list' | 'set-url';
  remoteName?: string;
  remoteUrl?: string;
  // reset
  resetMode?: 'soft' | 'mixed' | 'hard';
  // tag
  tagName?: string;
  tagMessage?: string;
  deleteTag?: boolean;
}

function buildArgs(p: GitParams): string[] {
  const op = p.operation;

  if (op === 'init') return ['init'];

  if (op === 'clone') {
    if (!p.url) throw new Error('clone requires "url"');
    const args = ['clone', p.url];
    if (p.destination) args.push(p.destination);
    return args;
  }

  if (op === 'add') {
    const files = p.files && p.files.length > 0 ? p.files : ['.'];
    return ['add', ...files];
  }

  if (op === 'commit') {
    if (!p.message) throw new Error('commit requires "message"');
    const args = ['commit', '-m', p.message];
    if (p.amend) args.push('--amend', '--no-edit');
    return args;
  }

  if (op === 'push') {
    const args = ['push'];
    if (p.force) args.push('--force-with-lease');
    if (p.remote) args.push(p.remote);
    if (p.branch) args.push(p.branch);
    return args;
  }

  if (op === 'pull') {
    const args = ['pull'];
    if (p.remote) args.push(p.remote);
    if (p.branch) args.push(p.branch);
    return args;
  }

  if (op === 'branch') {
    if (p.deleteTag) return ['branch', '-d', p.branch ?? ''];
    if (p.branch) return ['branch', p.branch];
    return ['branch', '-a'];
  }

  if (op === 'checkout') {
    const args = ['checkout'];
    if (p.createBranch) args.push('-b');
    args.push(p.ref ?? p.branch ?? '');
    return args;
  }

  if (op === 'merge') {
    if (!p.branch) throw new Error('merge requires "branch"');
    return ['merge', p.branch];
  }

  if (op === 'diff') {
    const args = ['diff'];
    if (p.fromRef) args.push(p.fromRef);
    if (p.toRef) args.push(p.toRef);
    return args;
  }

  if (op === 'log') {
    const args = ['log'];
    if (p.oneline) args.push('--oneline');
    args.push(`-${p.count ?? 10}`);
    return args;
  }

  if (op === 'status') return ['status', '--short', '--branch'];

  if (op === 'stash') {
    const action = p.stashAction ?? 'push';
    const args = ['stash', action];
    if (action === 'push' && p.stashMessage) args.push('-m', p.stashMessage);
    return args;
  }

  if (op === 'remote') {
    const action = p.remoteAction ?? 'list';
    if (action === 'list') return ['remote', '-v'];
    if (action === 'add') {
      if (!p.remoteName || !p.remoteUrl) throw new Error('remote add requires remoteName and remoteUrl');
      return ['remote', 'add', p.remoteName, p.remoteUrl];
    }
    if (action === 'remove') {
      if (!p.remoteName) throw new Error('remote remove requires remoteName');
      return ['remote', 'remove', p.remoteName];
    }
    if (action === 'set-url') {
      if (!p.remoteName || !p.remoteUrl) throw new Error('remote set-url requires remoteName and remoteUrl');
      return ['remote', 'set-url', p.remoteName, p.remoteUrl];
    }
    return ['remote', '-v'];
  }

  if (op === 'reset') {
    const mode = p.resetMode ?? 'mixed';
    const args = ['reset', `--${mode}`];
    if (p.ref) args.push(p.ref);
    return args;
  }

  if (op === 'tag') {
    if (p.deleteTag) {
      if (!p.tagName) throw new Error('tag delete requires tagName');
      return ['tag', '-d', p.tagName];
    }
    if (!p.tagName) return ['tag', '-l'];
    const args = ['tag'];
    if (p.tagMessage) args.push('-a', p.tagName, '-m', p.tagMessage);
    else args.push(p.tagName);
    return args;
  }

  throw new Error(`Unknown git operation: ${op}`);
}

const VALID_OPERATIONS: GitOperation[] = [
  'init', 'clone', 'add', 'commit', 'push', 'pull',
  'branch', 'checkout', 'merge', 'diff', 'log',
  'status', 'stash', 'remote', 'reset', 'tag',
];

export const gitTool: ToolDefinition = {
  name: 'coder.git',
  description:
    'Execute git operations safely. All arguments are passed as arrays — no shell injection possible. ' +
    'Supports: init, clone, add, commit, push, pull, branch, checkout, merge, diff, log, status, stash, remote, reset, tag.',
  category: 'coder',
  timeout: 60_000,
  parameters: {
    operation: {
      type: 'string',
      required: true,
      description: 'The git operation to perform.',
      enum: VALID_OPERATIONS,
    },
    cwd: { type: 'string', description: 'Working directory for git. Defaults to session cwd.' },
    url: { type: 'string', description: '(clone) Repository URL.' },
    destination: { type: 'string', description: '(clone) Target directory name.' },
    files: { type: 'array', description: '(add) Files to stage. Defaults to ["."].', items: { type: 'string', description: 'File path.' } },
    message: { type: 'string', description: '(commit) Commit message.' },
    amend: { type: 'boolean', description: '(commit) Amend the last commit.' },
    remote: { type: 'string', description: '(push/pull) Remote name, e.g. "origin".' },
    branch: { type: 'string', description: '(push/pull/branch/checkout/merge) Branch name.' },
    force: { type: 'boolean', description: '(push) Use --force-with-lease.' },
    createBranch: { type: 'boolean', description: '(checkout) Create branch if it does not exist (-b).' },
    ref: { type: 'string', description: '(checkout/diff/reset) Git ref or commit hash.' },
    fromRef: { type: 'string', description: '(diff) Source ref.' },
    toRef: { type: 'string', description: '(diff) Target ref.' },
    count: { type: 'number', description: '(log) Number of commits to show. Default 10.' },
    oneline: { type: 'boolean', description: '(log) Use --oneline format.' },
    stashAction: { type: 'string', description: '(stash) push | pop | list | drop', enum: ['push', 'pop', 'list', 'drop'] },
    stashMessage: { type: 'string', description: '(stash push) Stash message.' },
    remoteAction: { type: 'string', description: '(remote) add | remove | list | set-url', enum: ['add', 'remove', 'list', 'set-url'] },
    remoteName: { type: 'string', description: '(remote) Remote name.' },
    remoteUrl: { type: 'string', description: '(remote) Remote URL.' },
    resetMode: { type: 'string', description: '(reset) soft | mixed | hard', enum: ['soft', 'mixed', 'hard'] },
    tagName: { type: 'string', description: '(tag) Tag name.' },
    tagMessage: { type: 'string', description: '(tag) Annotated tag message.' },
    deleteTag: { type: 'boolean', description: '(tag/branch) Delete the tag or branch.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const op = params['operation'] as string;
    if (!op || !VALID_OPERATIONS.includes(op as GitOperation)) {
      return { success: false, output: `coder.git: invalid operation "${op}". Valid: ${VALID_OPERATIONS.join(', ')}` };
    }

    const gitCwd = typeof params['cwd'] === 'string'
      ? resolve(ctx.workingDir, params['cwd'])
      : ctx.workingDir;

    let args: string[];
    try {
      args = buildArgs(params as unknown as GitParams);
    } catch (e) {
      return { success: false, output: `coder.git: ${e instanceof Error ? e.message : String(e)}` };
    }

    try {
      const { stdout, stderr } = await execFile('git', args, {
        cwd: gitCwd,
        signal: ctx.signal,
        maxBuffer: 5 * 1024 * 1024,
      });

      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      log.info({ tool: 'coder.git', operation: op, args }, 'Git command executed');

      return {
        success: true,
        output: output || `git ${op} completed successfully (no output)`,
        data: { operation: op, args, cwd: gitCwd, stdout, stderr },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stderr = (err as { stderr?: string }).stderr ?? '';
      log.error({ tool: 'coder.git', operation: op, args, err }, 'Git command failed');
      return { success: false, output: `coder.git (${op}) failed: ${stderr || msg}` };
    }
  },
};

export default gitTool;
