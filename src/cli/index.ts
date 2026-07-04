#!/usr/bin/env node
/**
 * @file cli/index.ts
 * @description SUDO-AI CLI entry point.
 *
 * Registers all sub-commands via commander and dispatches to the appropriate
 * handler. This file is compiled to dist/cli/index.js and exposed as the
 * `sudo-ai` binary via package.json "bin".
 *
 * Commands:
 *   sudo-ai start [--daemon]   Boot the full SUDO-AI stack
 *   sudo-ai stop               Gracefully stop a running instance
 *   sudo-ai status             Show running status and health
 *   sudo-ai config             Validate or inspect configuration
 *   sudo-ai doctor             Run comprehensive environment checks
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { APP_VERSION } from '../core/shared/constants.js';
import { PROJECT_ROOT } from '../core/shared/paths.js';

// ---------------------------------------------------------------------------
// Bundler path overrides — ESM bundle __dirname fix
//
// esbuild inlines pino and thread-stream as __commonJS wrappers.  Those
// wrappers reference __dirname in their closures, but esbuild does NOT inject
// __dirname into __commonJS callbacks when outputting ESM.
//
// pino checks globalThis.__bundlerPathsOverrides BEFORE falling back to
// __dirname, so injecting it here — before any lazy __esm init (config/loader,
// brain, etc.) can fire pino.transport() — permanently prevents the
// ReferenceError: __dirname is not defined crash.
//
// The build:cli banner injects:
//   import { createRequire } from 'module'; const require = createRequire(import.meta.url);
// We must NOT re-import createRequire (duplicate ESM identifier error).
// Instead we declare the banner-injected `require` as ambient.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: NodeRequire;  // provided by esbuild banner

(function injectPinoBundlerPaths() {
  if (typeof globalThis !== 'object' || '__bundlerPathsOverrides' in globalThis) return;
  try {
    // thread-stream is a nested dep of pino under pnpm and is NOT directly
    // resolvable from the bundle entry.  In pnpm's virtual store, all deps of
    // a package sit as siblings: <store>/pino@x/node_modules/{pino,thread-stream,...}
    // so we find thread-stream relative to pino's own directory.
    const pinoMain  = require.resolve('pino');
    const pinoDir   = path.dirname(pinoMain);                     // …/node_modules/pino
    const tsWorker  = path.resolve(pinoDir, '..', 'thread-stream', 'lib', 'worker.js');

    (globalThis as Record<string, unknown>)['__bundlerPathsOverrides'] = {
      'pino-worker':          require.resolve('pino/lib/worker.js'),
      'thread-stream-worker': tsWorker,
      'pino/file':            require.resolve('pino/file.js'),
      'pino-pretty':          require.resolve('pino-pretty'),
    };
  } catch {
    // Non-fatal — pino will fall back to __dirname at runtime; log dir issues
    // will surface naturally.
  }
}());
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Project root resolution
// ---------------------------------------------------------------------------

/**
 * Install root: where this checkout lives (../../ from src/ or dist/cli/).
 * Used only by commands operating on the installation itself (`start` spawns
 * src/cli.ts with the local tsx; `update` runs git against the checkout and
 * reads its package.json). All other commands (config, doctor, scan,
 * quickstart, init) use the SUDO_AI_HOME-aware PROJECT_ROOT from
 * core/shared/paths.ts, so a global install targets the user's project dir.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INSTALL_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Program definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('sudo-ai')
  .description('SUDO-AI — Autonomous AI Agent Platform')
  .version(APP_VERSION, '-v, --version', 'Print version number');

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

program
  .command('start')
  .description('Boot the full SUDO-AI stack')
  .option('-d, --daemon', 'Run as a background daemon (detached process)', false)
  .action(async (opts: { daemon: boolean }) => {
    if (opts.daemon) {
      const { runStartDaemon } = await import('./commands/start.js');
      await runStartDaemon(INSTALL_ROOT);
    } else {
      const { runStartForeground } = await import('./commands/start.js');
      await runStartForeground(INSTALL_ROOT);
    }
  });

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

program
  .command('stop')
  .description('Gracefully stop a running SUDO-AI instance')
  .action(async () => {
    const { runStop } = await import('./commands/stop.js');
    const code = await runStop();
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('Show current SUDO-AI running status and API health')
  .action(async () => {
    const { runStatus } = await import('./commands/status.js');
    const code = await runStatus();
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const configCmd = program
  .command('config')
  .description('Inspect or validate the SUDO-AI configuration');

configCmd
  .option('--validate', 'Load and validate config/sudo-ai.json5, exit 0/1')
  .option('--path', 'Print the resolved config file path')
  .action(async (opts: { validate?: boolean; path?: boolean }) => {
    const { runConfigValidate, runConfigPath } = await import('./commands/config.js');

    if (opts.validate) {
      const code = await runConfigValidate(PROJECT_ROOT);
      process.exit(code);
    } else if (opts.path) {
      runConfigPath(PROJECT_ROOT);
    } else {
      // Default: show both.
      runConfigPath(PROJECT_ROOT);
      const code = await runConfigValidate(PROJECT_ROOT);
      process.exit(code);
    }
  });

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

program
  .command('doctor')
  .description('Run comprehensive environment health checks')
  .option('--fix', 'Auto-remediate issues where possible', false)
  .action(async (opts: { fix?: boolean }) => {
    const { runDoctor } = await import('./commands/doctor.js');
    const code = await runDoctor(PROJECT_ROOT, { fix: opts.fix ?? false });
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------

program
  .command('bench')
  .description('Run model × task benchmark sweep and print report')
  .option('--models <list>',     'Comma-separated model IDs to benchmark')
  .option('--tasks <list>',      'Comma-separated task IDs (default: all 5 built-in)')
  .option('--conditions <list>', 'Comma-separated conditions: no_skills,skills_on,skills_optimized')
  .option('--seeds <n>',         'Number of random seeds per cell (default: 1)')
  .option('--output <fmt>',      'Output format: markdown | json (default: markdown)', 'markdown')
  .action(async (opts: { models?: string; tasks?: string; conditions?: string; seeds?: string; output?: string }) => {
    const { runBench } = await import('./commands/bench.js');
    const code = await runBench(opts);
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// flywheel-verify (implemented in commands/flywheel-verify.ts)
// ---------------------------------------------------------------------------

program
  .command('flywheel-verify')
  .description('Run the repair-flywheel LIVE A/B on captured failures (dry by default; --confirm spends tokens)')
  .option('--tool <name>', 'Tool cluster to verify', 'system.exec')
  .option('--max <n>',     'Max live rewrites to spend (cost ceiling)', '20')
  .option('--confirm',     'Actually spend tokens and run the live A/B', false)
  .option('--admit',       'On an adopt decision, enter the lesson into the canary lifecycle', false)
  .option('--json',        'Emit the result as JSON', false)
  .action(async (opts: { tool?: string; max?: string; confirm?: boolean; admit?: boolean; json?: boolean }) => {
    const { runFlywheelVerify } = await import('./commands/flywheel-verify.js');
    const code = await runFlywheelVerify(opts);
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// scan (implemented in commands/scan.ts)
// ---------------------------------------------------------------------------

program
  .command('scan')
  .description('Security scan: token strength, env leaks, config permissions')
  .option('--json', 'Output results as JSON instead of table', false)
  .action(async (opts: { json?: boolean }) => {
    try {
      const { runScan } = await import('./commands/scan.js');
      const code = await runScan(PROJECT_ROOT, opts);
      process.exit(code);
    } catch (err) {
      console.error('[sudo-ai] scan failed:', err);
      console.error('[sudo-ai] scan command not yet available (Builder 3 pending)');
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// quickstart (implemented in commands/quickstart.ts)
// ---------------------------------------------------------------------------

program
  .command('quickstart')
  .description('Interactive 5-step setup wizard')
  .option('--force', 'Overwrite existing config without prompting', false)
  .action(async (opts: { force?: boolean }) => {
    try {
      const { runQuickstart } = await import('./commands/quickstart.js');
      await runQuickstart(PROJECT_ROOT, { force: opts.force ?? false });
      process.exit(0);
    } catch (err) {
      console.error('[sudo-ai] quickstart failed:', err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// init (implemented in commands/init.ts)
// ---------------------------------------------------------------------------

program
  .command('init')
  .description('Apply a preset recipe to the current workspace')
  .option('--preset <name>', 'Preset name: coding | research | chat')
  .option('--force', 'Overwrite existing config without prompting', false)
  .action(async (opts: { preset?: string; force?: boolean }) => {
    try {
      const { runInit } = await import('./commands/init.js');
      const code = await runInit(PROJECT_ROOT, opts);
      process.exit(code);
    } catch (err) {
      console.error('[sudo-ai] init failed:', err);
      if (opts.preset) {
        process.exit(1);
      } else {
        console.log('Available presets: coding, research, chat');
        process.exit(0);
      }
    }
  });

// ---------------------------------------------------------------------------
// chat — terminal TUI streaming conversation with Claude
// ---------------------------------------------------------------------------

program
  .command('chat')
  .description('Interactive streaming chat with Claude in the terminal')
  .action(async () => {
    const { runChat } = await import('./commands/chat.js');
    await runChat();
  });

// ---------------------------------------------------------------------------
// claude-oauth — Claude.ai subscription OAuth (PKCE) connector
// ---------------------------------------------------------------------------

const claudeOauthCmd = program
  .command('claude-oauth')
  .description('Manage Claude.ai subscription OAuth (PKCE) — login, status, refresh, disconnect');

claudeOauthCmd
  .command('login')
  .description('Run the PKCE OAuth flow — prints URL, accepts pasted code')
  .action(async () => {
    const { runClaudeOAuthLogin } = await import('./commands/claude-oauth.js');
    process.exit(await runClaudeOAuthLogin());
  });

claudeOauthCmd
  .command('status')
  .description('Show whether sudo-ai has a usable Claude OAuth token')
  .action(async () => {
    const { runClaudeOAuthStatus } = await import('./commands/claude-oauth.js');
    process.exit(await runClaudeOAuthStatus());
  });

claudeOauthCmd
  .command('refresh')
  .description('Force a Claude OAuth token refresh now')
  .action(async () => {
    const { runClaudeOAuthRefresh } = await import('./commands/claude-oauth.js');
    process.exit(await runClaudeOAuthRefresh());
  });

claudeOauthCmd
  .command('disconnect')
  .description('Wipe stored Claude OAuth credentials')
  .action(async () => {
    const { runClaudeOAuthDisconnect } = await import('./commands/claude-oauth.js');
    process.exit(await runClaudeOAuthDisconnect());
  });

claudeOauthCmd
  .command('models')
  .description('List Claude models available to the connected account')
  .option('--refresh', 'Force a live fetch instead of using the cached list', false)
  .action(async (opts: { refresh?: boolean }) => {
    const { runClaudeOAuthModels } = await import('./commands/claude-oauth.js');
    process.exit(await runClaudeOAuthModels(opts.refresh ?? false));
  });

claudeOauthCmd
  .command('set-model <id>')
  .description('Set the default Claude model used by the brain router')
  .action(async (id: string) => {
    const { runClaudeOAuthSetModel } = await import('./commands/claude-oauth.js');
    process.exit(await runClaudeOAuthSetModel(id));
  });

// ---------------------------------------------------------------------------
// update — check for and apply SUDO-AI updates
// ---------------------------------------------------------------------------

program
  .command('update')
  .description('Check for and apply SUDO-AI updates')
  .option('--check', 'Only check for available updates (do not apply)')
  .option('--channel <channel>', 'Update channel: latest or stable', 'latest')
  .option('--rollback', 'Rollback to the previous version')
  .option('--status', 'Show current version and update history')
  .action(async (opts: { check?: boolean; channel?: string; rollback?: boolean; status?: boolean }) => {
    const { runUpdate } = await import('./commands/update.js');
    const code = await runUpdate(INSTALL_ROOT, opts);
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[sudo-ai] Fatal error: ${msg}`);
  process.exit(1);
});
