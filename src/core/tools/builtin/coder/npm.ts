/**
 * coder.npm — Package management via npm / pnpm / yarn.
 * All commands use execFile with argument arrays — no shell interpolation.
 * Supports install, add, remove, build, test, run, init, outdated, audit.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const execFile = promisify(execFileCb);

type PackageManager = 'npm' | 'pnpm' | 'yarn';
type NpmOperation = 'install' | 'add' | 'remove' | 'build' | 'test' | 'run' | 'init' | 'outdated' | 'audit';

const VALID_OPS: NpmOperation[] = ['install', 'add', 'remove', 'build', 'test', 'run', 'init', 'outdated', 'audit'];
const VALID_PMS: PackageManager[] = ['npm', 'pnpm', 'yarn'];

function buildArgs(
  pm: PackageManager,
  operation: NpmOperation,
  packageName?: string,
  script?: string,
  dev?: boolean,
  exact?: boolean,
): string[] {
  if (operation === 'install') return ['install'];

  if (operation === 'add') {
    if (!packageName) throw new Error('"add" requires packageName');
    const args = pm === 'npm' ? ['install'] : ['add'];
    if (dev) args.push(pm === 'yarn' ? '--dev' : '-D');
    if (exact) args.push(pm === 'npm' ? '--save-exact' : '-E');
    args.push(packageName);
    return args;
  }

  if (operation === 'remove') {
    if (!packageName) throw new Error('"remove" requires packageName');
    return pm === 'npm' ? ['uninstall', packageName] : ['remove', packageName];
  }

  if (operation === 'build') return ['run', 'build'];

  if (operation === 'test') {
    const args = ['test'];
    if (script) args.push('--', script); // pass filter as a vitest/jest --testNamePattern
    return args;
  }

  if (operation === 'run') {
    if (!script) throw new Error('"run" requires a script name');
    return ['run', script];
  }

  if (operation === 'init') {
    return pm === 'yarn' ? ['init'] : ['init', '-y'];
  }

  if (operation === 'outdated') return ['outdated'];

  if (operation === 'audit') {
    return pm === 'yarn' ? ['audit'] : ['audit', '--json'];
  }

  throw new Error(`Unknown npm operation: ${operation}`);
}

export const npmTool: ToolDefinition = {
  name: 'coder.npm',
  description:
    'Run package manager commands (npm, pnpm, or yarn). ' +
    'Supports install, add, remove, build, test, run, init, outdated, audit. ' +
    'All commands are executed safely via execFile (no shell injection).',
  category: 'coder',
  timeout: 120_000,
  parameters: {
    operation: {
      type: 'string',
      required: true,
      description: 'Package manager operation to perform.',
      enum: VALID_OPS,
    },
    packageName: {
      type: 'string',
      description: '(add/remove) Name of the package, e.g. "lodash" or "typescript@5".',
    },
    script: {
      type: 'string',
      description: '(run) Script name from package.json scripts. (test) Optional test name filter.',
    },
    cwd: {
      type: 'string',
      description: 'Working directory. Defaults to session working directory.',
    },
    packageManager: {
      type: 'string',
      description: 'Which package manager to use.',
      enum: VALID_PMS,
      default: 'pnpm',
    },
    dev: {
      type: 'boolean',
      description: '(add) Install as devDependency.',
    },
    exact: {
      type: 'boolean',
      description: '(add) Pin exact version.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const op = params['operation'] as string;
    if (!op || !VALID_OPS.includes(op as NpmOperation)) {
      return { success: false, output: `coder.npm: invalid operation "${op}". Valid: ${VALID_OPS.join(', ')}` };
    }

    const pm = (typeof params['packageManager'] === 'string' && VALID_PMS.includes(params['packageManager'] as PackageManager))
      ? (params['packageManager'] as PackageManager)
      : 'pnpm';

    const pkgCwd = typeof params['cwd'] === 'string'
      ? resolve(ctx.workingDir, params['cwd'])
      : ctx.workingDir;

    const packageName = typeof params['packageName'] === 'string' ? params['packageName'] : undefined;
    const script = typeof params['script'] === 'string' ? params['script'] : undefined;
    const dev = params['dev'] === true;
    const exact = params['exact'] === true;

    let args: string[];
    try {
      args = buildArgs(pm, op as NpmOperation, packageName, script, dev, exact);
    } catch (e) {
      return { success: false, output: `coder.npm: ${e instanceof Error ? e.message : String(e)}` };
    }

    log.info({ tool: 'coder.npm', pm, operation: op, args, cwd: pkgCwd }, 'Running package manager');

    try {
      const { stdout, stderr } = await execFile(pm, args, {
        cwd: pkgCwd,
        signal: ctx.signal,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, CI: '1', NO_COLOR: '1' },
      });

      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      log.info({ tool: 'coder.npm', pm, operation: op }, 'Package manager complete');

      return {
        success: true,
        output: output || `${pm} ${op} completed successfully`,
        data: { pm, operation: op, args, cwd: pkgCwd, stdout, stderr },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stderr = (err as { stderr?: string }).stderr ?? '';
      const stdout = (err as { stdout?: string }).stdout ?? '';
      log.error({ tool: 'coder.npm', pm, operation: op, err }, 'Package manager failed');
      return {
        success: false,
        output: `coder.npm (${pm} ${op}) failed:\n${stderr || stdout || msg}`,
      };
    }
  },
};

export default npmTool;
